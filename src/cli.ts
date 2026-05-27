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

type Mode = "twilio-ws" | "discord";

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
};

const parseArgs = (argv: string[]): Args => {
	const args: Args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
			case "--mode":
				args.mode = value === "discord" ? "discord" : "twilio-ws";
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
		}
	}
	return args;
};

const usage = `Usage:
  voice-tester --mode twilio-ws --target wss://... [--scenario adversarial|happy-path] [--duration 90] [--session sessionId] [--from +E164] [--to +E164]
  voice-tester --mode discord --guild <id> --channel <id> [--target-user <id>] [--scenario adversarial|happy-path] [--duration 90]

Env: DEEPGRAM_API_KEY (required), ANTHROPIC_API_KEY (LLM scenarios), DISCORD_TESTER_TOKEN (discord mode).`;

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
