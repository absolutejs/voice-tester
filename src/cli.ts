#!/usr/bin/env bun
// Minimal CLI. Two modes:
//
// Twilio-WS (the dealroom phone receptionist style):
//   bunx @absolutejs/voice-tester \
//     --mode twilio-ws \
//     --target wss://example.com/v1/voice/phone/stream \
//     --scenario adversarial \
//     --duration 90 \
//     --session phone:+15555550100:$(date +%s)
//
// Discord voice (the Deal Referee style):
//   DISCORD_TESTER_TOKEN=Bot.xxx bunx @absolutejs/voice-tester \
//     --mode discord \
//     --guild 1234567890 \
//     --channel 9876543210 \
//     --target-user 1122334455 \
//     --scenario adversarial \
//     --duration 90
//
// Environment:
//   DEEPGRAM_API_KEY       — required (STT + Aura TTS)
//   ANTHROPIC_API_KEY      — picked up by @absolutejs/ai (LLM-driven scenarios)
//   DISCORD_TESTER_TOKEN   — required for --mode discord

import { runScenario } from "./aiCaller";
import { adversarialScenario, happyPathScenario } from "./scenarios";
import type { Transport } from "./transport";
import { twilioWsTransport } from "./transports/twilioWs";

type Mode = "twilio-ws" | "twilio-outbound" | "discord";

type Args = {
	mode?: Mode;
	target?: string;
	scenario?: "adversarial" | "happy-path";
	durationMs?: number;
	model?: string;
	voice?: string;
	from?: string;
	to?: string;
	sessionId?: string;
	guildId?: string;
	channelId?: string;
	targetUserId?: string;
	discordToken?: string;
	publicUrl?: string;
	port?: number;
	recordCall?: boolean;
};

const parseArgs = (argv: string[]): Args => {
	const args: Args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case "--mode":
				args.mode =
					value === "discord"
						? "discord"
						: value === "twilio-outbound"
							? "twilio-outbound"
							: "twilio-ws";
				i += 1;
				break;
			case "--target":
				args.target = value;
				i += 1;
				break;
			case "--scenario":
				args.scenario =
					value === "adversarial" ? "adversarial" : "happy-path";
				i += 1;
				break;
			case "--duration":
				args.durationMs = Number(value) * 1000;
				i += 1;
				break;
			case "--model":
				args.model = value;
				i += 1;
				break;
			case "--voice":
				args.voice = value;
				i += 1;
				break;
			case "--from":
				args.from = value;
				i += 1;
				break;
			case "--to":
				args.to = value;
				i += 1;
				break;
			case "--session":
				args.sessionId = value;
				i += 1;
				break;
			case "--guild":
				args.guildId = value;
				i += 1;
				break;
			case "--channel":
				args.channelId = value;
				i += 1;
				break;
			case "--target-user":
				args.targetUserId = value;
				i += 1;
				break;
			case "--discord-token":
				args.discordToken = value;
				i += 1;
				break;
			case "--public-url":
				args.publicUrl = value;
				i += 1;
				break;
			case "--port":
				args.port = Number(value);
				i += 1;
				break;
			case "--record-call":
				args.recordCall = true;
				// flag, no value
				break;
		}
	}
	return args;
};

const usage = `Usage:
  voice-tester --mode twilio-ws       --target wss://... [--scenario adversarial|happy-path] [--duration 90] [--session sessionId] [--from +E164] [--to +E164]
  voice-tester --mode twilio-outbound --from +E164 --to +E164 --public-url https://... [--port 3344] [--record-call] [--scenario ...] [--duration ...]
  voice-tester --mode discord         --guild <id> --channel <id> [--target-user <id>] [--scenario ...] [--duration ...]

Env:
  DEEPGRAM_API_KEY     (required for STT + TTS)
  ANTHROPIC_API_KEY    (LLM-driven scenarios)
  TWILIO_ACCOUNT_SID   (twilio-outbound mode)
  TWILIO_AUTH_TOKEN    (twilio-outbound mode)
  DISCORD_TESTER_TOKEN (discord mode)

twilio-outbound setup:
  1. Have a Twilio account + a voice-capable number you own (--from).
  2. Expose a public HTTPS URL that proxies to your local --port (default
     3344). Easiest: 'ngrok http 3344' → use the https URL ngrok prints as
     --public-url. AbsoluteJS users can run the built-in tunnel instead.
  3. Set TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN env vars.
  4. Run: voice-tester --mode twilio-outbound --from +15551234567 \\
       --to +19735551212 --public-url https://abc.ngrok.io
  Twilio will dial the --to number; once they answer, the scenario engine
  drives the call. Cost is the standard Twilio outbound rate (~$0.014/min
  US-to-US).`;

const main = async () => {
	const args = parseArgs(process.argv.slice(2));
	const mode = args.mode ?? "twilio-ws";

	const deepgramKey = process.env.DEEPGRAM_API_KEY;
	if (!deepgramKey) {
		console.error("DEEPGRAM_API_KEY is required for STT + TTS");
		process.exit(1);
	}

	let transport: Transport;
	if (mode === "discord") {
		const token = args.discordToken ?? process.env.DISCORD_TESTER_TOKEN;
		if (!token || !args.guildId || !args.channelId) {
			console.error(
				"--mode discord requires DISCORD_TESTER_TOKEN (env or --discord-token), --guild, --channel",
			);
			console.error(usage);
			process.exit(1);
		}
		// Dynamic import so the @discordjs/voice + discord.js peer deps stay
		// optional — users on the Twilio path don't have to install them.
		const { discordVoiceTransport } = await import("./transports/discord");
		transport = await discordVoiceTransport({
			channelId: args.channelId,
			guildId: args.guildId,
			...(args.targetUserId ? { targetUserId: args.targetUserId } : {}),
			token,
		});
	} else if (mode === "twilio-outbound") {
		const accountSid = process.env.TWILIO_ACCOUNT_SID;
		const authToken = process.env.TWILIO_AUTH_TOKEN;
		if (!accountSid || !authToken) {
			console.error(
				"--mode twilio-outbound requires TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN env vars",
			);
			console.error(usage);
			process.exit(1);
		}
		if (!args.from || !args.to || !args.publicUrl) {
			console.error(
				"--mode twilio-outbound requires --from <E164>, --to <E164>, and --public-url <https://…>",
			);
			console.error(usage);
			process.exit(1);
		}
		const { twilioOutboundTransport } = await import(
			"./transports/twilioOutbound"
		);
		console.info(
			`[outbound] originating call from ${args.from} to ${args.to} via Twilio…`,
		);
		console.info(
			`[outbound] local server on port ${args.port ?? 3344}, public URL ${args.publicUrl}`,
		);
		transport = await twilioOutboundTransport({
			accountSid,
			authToken,
			from: args.from,
			...(args.port ? { port: args.port } : {}),
			publicUrl: args.publicUrl,
			...(args.recordCall ? { recordCall: true } : {}),
			to: args.to,
		});
		console.info("[outbound] call connected; running scenario…");
	} else {
		if (!args.target) {
			console.error("--mode twilio-ws requires --target wss://…");
			console.error(usage);
			process.exit(1);
		}
		transport = twilioWsTransport({
			...(args.from ? { from: args.from } : {}),
			...(args.to ? { to: args.to } : {}),
			...(args.sessionId
				? { customParameters: { sessionId: args.sessionId } }
				: {}),
			wsUrl: args.target,
		});
	}

	const scenarioName = args.scenario ?? "adversarial";
	const llmConfig = args.model ? { model: args.model } : {};
	const scenario =
		scenarioName === "adversarial"
			? adversarialScenario({
					...(args.durationMs
						? { maxDurationMs: args.durationMs }
						: {}),
					llm: llmConfig,
				})
			: happyPathScenario({
					...(args.durationMs
						? { maxDurationMs: args.durationMs }
						: {}),
					llm: llmConfig,
				});

	const report = await runScenario({
		scenario,
		stt: { apiKey: deepgramKey },
		transport,
		tts: {
			apiKey: deepgramKey,
			...(args.voice ? { model: args.voice } : {}),
		},
	});

	console.info("\n=== SCENARIO REPORT ===");
	console.info(JSON.stringify(report, null, 2));
	process.exit(report.endedReason === "error" ? 1 : 0);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
