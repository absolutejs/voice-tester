# Discord tester bot — one-time setup

To run `@absolutejs/voice-tester --mode discord` against any voice bot
(Deal Referee, your own bot, anyone's bot), you need a **separate Discord
application** that acts as the tester. It cannot be the same bot as the one
you're testing — they need to be two distinct users in the same voice
channel so the tester can subscribe to the other bot's audio.

This is a ~10-minute one-time setup. After that, every test run reuses the
same token.

---

## 1. Create the tester bot application

1. Open <https://discord.com/developers/applications> and click **New
   Application**. Name it something obvious like `voice-tester` so future-you
   doesn't confuse it with the bot under test.
2. In the left sidebar pick **Bot**.
3. Under **Privileged Gateway Intents**:
   - Leave **Presence Intent** and **Message Content Intent** OFF — the
     tester doesn't need them.
   - The tester only needs the `Guilds` + `Guild Voice States` intents,
     which are *not* privileged and are enabled by default.
4. Under **Bot → Token**, click **Reset Token** and copy the value. This is
   your `DISCORD_TESTER_TOKEN`.

Save the token to whichever `.env` you'll run the tester from. For dealroom
local runs, that's `~/abs/voice-tester/.env`:

```sh
echo 'DISCORD_TESTER_TOKEN=Bot.your-tester-token-here' >> ~/abs/voice-tester/.env
```

Never commit it; the existing `.gitignore` already covers `.env`.

---

## 2. Invite the tester bot to your guild

In the developer portal, go to **OAuth2 → URL Generator**:

- **Scopes:** check `bot`
- **Bot Permissions:** check
  - `Connect`
  - `Speak`
  - `Use Voice Activity`
  - (optional) `View Channel` — needed only if the voice channel isn't public to the bot's role

Copy the generated URL (looks like `https://discord.com/api/oauth2/authorize?client_id=...&permissions=...&scope=bot`),
open it in a browser, pick the guild that already has the bot under test,
and confirm.

After authorizing the OAuth, drag the tester bot's role above the role of
the voice channel if the channel is role-restricted (otherwise it won't be
able to join).

---

## 3. Grab the IDs you'll pass to the CLI

In Discord (the user app), turn on **User Settings → Advanced → Developer
Mode**. Now right-clicking surfaces "Copy ID" everywhere.

- **Guild ID:** right-click the server icon in the sidebar → Copy Server ID.
- **Voice channel ID:** right-click the voice channel → Copy Channel ID.
- **Target user ID (the bot under test):** right-click that bot's user in
  the member list → Copy User ID. This is optional — if omitted, the tester
  forwards every non-self user's audio to STT. Useful when humans are also
  in the channel during the test.

---

## 4. Confirm both bots are in the same voice channel

1. Manually invite the bot under test (e.g. Deal Referee) into the voice
   channel the way you normally would.
2. Manually invite the tester bot into the same channel — easiest way is
   to start the tester run; it will join automatically.

If the bot under test joins the channel passively (only when summoned via
its own command), trigger that first so it's already speaking. The tester
will sit in silence until it sees inbound audio, so an empty channel just
prints `[media] inboundFrames=0 lastLoud=never` until something happens.

---

## 5. Run a test

```sh
cd ~/abs/voice-tester

# Source your keys + tester token
set -a; source .env; set +a

bunx @absolutejs/voice-tester \
  --mode discord \
  --guild   <GUILD_ID> \
  --channel <VOICE_CHANNEL_ID> \
  --target-user <BOT_UNDER_TEST_USER_ID> \
  --scenario adversarial \
  --duration 90
```

Required env: `DEEPGRAM_API_KEY`, `DISCORD_TESTER_TOKEN`, `ANTHROPIC_API_KEY` (for LLM-driven scenarios).

You'll see logs that mirror the Twilio mode:

```
[caller] transport=discord:<guild>:<channel> ready (rate=48000Hz)
[stt] open (rate=48000Hz)
[service:mark] ...
[stt:final] <what the bot under test said>
[caller:say] <what the tester said>
...
=== SCENARIO REPORT ===
```

Exit code is non-zero if the scenario hit an error.

---

## Common gotchas

- **`Connection timed out`** waiting for VoiceConnection ready: the tester
  bot was invited to the guild but doesn't have permission to *enter the
  voice channel*. Check Channel Settings → Permissions → the tester bot's
  role has Connect + Speak.
- **Bot joins but no audio is transcribed:** the bot under test may be on
  Discord's new DAVE end-to-end encryption (MLS). The tester relies on
  `@discordjs/voice` which transparently handles DAVE as long as a recent
  version is installed; if you see `[stt] open` but never any `[stt:final]`
  it's worth confirming `@discordjs/voice >= 0.19` and `prism-media >= 1.3.5`.
- **Multiple participants speaking at once:** the tester sends every
  non-self user's audio to one shared STT stream, so transcripts can
  interleave. Use `--target-user <id>` to focus on the bot under test.
- **The tester won't leave on Ctrl-C:** the underlying `discord.js` Client
  needs `.destroy()` to close the WebSocket. The tester does this on
  scenario completion; if you SIGINT mid-scenario the gateway may stay
  open for a few seconds before timing out. Wait it out or use `kill -9`.
- **`DiscordAPIError[50013]: Missing Permissions`:** the tester bot lacks
  Speak permission on the channel. Fix via channel-level role override.
- **You'll see "presence intent" warnings** in some discord.js setups.
  Ignore them — the tester doesn't request presence.
