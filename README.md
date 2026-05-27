# @absolutejs/voice-tester

AI-driven automated tester for voice services that speak the Twilio Media
Streams protocol. Pairs with [`@absolutejs/voice`](https://npmjs.com/package/@absolutejs/voice) — drives a regression scenario end-to-end against a deployed receptionist without a phone, a real Twilio call, or a human in the loop.

Built for the AbsoluteJS AI Studio.

## What it does

Opens a WebSocket directly to your voice service's `/stream` endpoint and acts
as the caller side of a Twilio Media Stream:

1. Sends a `connected` envelope, then `start` with custom parameters (sessionId, etc.)
2. Streams 20ms μ-law frames generated from Deepgram Aura TTS
3. Receives the service's outbound audio frames, decodes μ-law back to PCM
4. Pipes the inbound PCM into Deepgram STT to transcribe what the bot said
5. Asks an LLM what to say next given the rolling transcript + scenario rules
6. Repeats until the scenario completes or the timeout fires

Every layer is observable: full transcript with caller/service timestamps,
partial + final STT events, mark/clear events from the bridge.

## Install

```sh
bun add -d @absolutejs/voice-tester @absolutejs/ai
```

`@absolutejs/ai` is a peer dependency.

Environment:

- `DEEPGRAM_API_KEY` — required for both TTS (Aura) and STT
- `ANTHROPIC_API_KEY` — picked up by `@absolutejs/ai` when scenarios use the LLM

## Quick start (CLI)

```sh
bun x @absolutejs/voice-tester \
  --target wss://example.com/v1/voice/phone/stream \
  --scenario adversarial \
  --duration 90 \
  --from +15555550100 \
  --to +15555550199 \
  --session phone:+15555550100:$(date +%s)
```

Exits non-zero if the scenario hit an error. Prints a JSON report:

```json
{
  "scenario": "adversarial",
  "callerTurns": 7,
  "serviceTurns": 7,
  "durationMs": 68073,
  "endedReason": "scenario_hangup",
  "streamSid": "MZ…",
  "transcript": [ { "speaker": "service", "text": "…", "at": 9271 }, … ]
}
```

## Quick start (API)

```ts
import { runScenario } from "@absolutejs/voice-tester";
import { adversarialScenario } from "@absolutejs/voice-tester/scenarios";

const report = await runScenario({
  wsUrl: "wss://example.com/v1/voice/phone/stream",
  tts: { apiKey: process.env.DEEPGRAM_API_KEY! },
  stt: { apiKey: process.env.DEEPGRAM_API_KEY! },
  scenario: adversarialScenario({ llm: { model: "claude-haiku-4-5-20251001" } }),
  customParameters: { sessionId: `phone:+15555550100:${Date.now()}` },
  from: "+15555550100",
  to: "+15555550199",
});

if (report.endedReason === "error") {
  throw new Error(report.error?.message ?? "scenario failed");
}
```

## Built-in scenarios

- **`happyPathScenario`** — plays a realistic new subscriber. Answers the bot's intake questions naturally for ~75s, then hangs up. Baseline: if this one breaks, the bot is broken in a boring way.
- **`adversarialScenario`** — probes failure modes: long silence after greeting, mumbled answer, mid-sentence interruption, language switch to Spanish, off-topic ("what's the weather?"), then LLM-improvised follow-ups. Should fail gracefully — if the bot crashes, hangs, or loops, you'll see it in the transcript.

## Writing your own scenario

A scenario is a `decide` function that receives the rolling context and returns the next caller action:

```ts
import type { Scenario } from "@absolutejs/voice-tester";

export const myScenario: Scenario = {
  id: "my-scenario",
  maxDurationMs: 60_000,
  idleMs: 1200,
  decide: async ({ transcript, lastServiceUtterance, callerTurnCount }) => {
    if (callerTurnCount >= 5) return { type: "hangup" };
    if (lastServiceUtterance?.toLowerCase().includes("price")) {
      return { type: "speak", text: "Is there a free trial?" };
    }
    return { type: "speak", text: "Tell me more." };
  },
};
```

Actions are `{ type: "speak", text }`, `{ type: "silence", ms }`, or `{ type: "hangup", reason }`.

## Modes

- **twilio-ws** (default) — speaks Twilio's protocol against any WS endpoint. Free, no carrier audio path. Tests the full app stack: STT → LLM → TTS → scribe → DB. **Shipped.**
- **discord** — joins a Discord voice channel as a fake tester user, sends Aura TTS as opus, subscribes to other users' audio receivers, decodes opus back to PCM for STT. Use this to regress Deal Referee / any bot living in a voice channel. **Shipped.** Requires a separate tester Discord bot (with `connect`, `speak` permissions on the channel).
- **twilio-outbound** (planned) — originates a real Twilio outbound call so the test exercises the carrier audio path. Costs Twilio minutes; gated behind a flag.

### Discord mode

Full one-time setup guide (creating the tester bot in the Discord developer portal, inviting it, finding the IDs, common gotchas): see [`docs/discord-setup.md`](./docs/discord-setup.md).

```sh
DISCORD_TESTER_TOKEN=Bot.your_tester_bot_token bunx @absolutejs/voice-tester \
  --mode discord \
  --guild   1234567890 \
  --channel 9876543210 \
  --target-user 1122334455 \
  --scenario adversarial \
  --duration 90
```

`--target-user` is optional — if set, the tester only transcribes that user's audio (useful when there are humans in the channel too). Without it, everyone except the tester bot itself is forwarded to STT.

```ts
import { runScenario } from "@absolutejs/voice-tester";
import { adversarialScenario } from "@absolutejs/voice-tester/scenarios";
import { discordVoiceTransport } from "@absolutejs/voice-tester/discord";

const transport = await discordVoiceTransport({
  token: process.env.DISCORD_TESTER_TOKEN!,
  guildId: "1234567890",
  channelId: "9876543210",
  targetUserId: "1122334455", // optional: only this user's audio
});

const report = await runScenario({
  transport,
  scenario: adversarialScenario({ llm: {} }),
  tts: { apiKey: process.env.DEEPGRAM_API_KEY! },
  stt: { apiKey: process.env.DEEPGRAM_API_KEY! },
});
```

Discord mode pulls three peer dependencies which are not installed by default — only install them if you actually use Discord mode:

```sh
bun add -d @discordjs/voice discord.js prism-media
```

## Architecture

```
+-----------------------------------+
|        runScenario()              |
|  + scenario.decide() -> action    |
|  + AI caller loop                 |
+-----------------------------------+
        |                ^
        v                |
  +--------+        +--------+
  |  Aura  |        |Deepgram|
  |  TTS   |        |  STT   |
  +--------+        +--------+
   PCM 8k             PCM 8k
   ↓                    ↑
  +-------------------------------+
  |     twilioWsCaller.ts         |
  |  caller-side Twilio protocol  |
  +-------------------------------+
        |                ^
        v                |
   media (mulaw)    media (mulaw)
        |                |
        v                |
  +-------------------------------+
  |  YOUR voice service           |
  |  (@absolutejs/voice bridge)   |
  +-------------------------------+
```

## License

MIT
