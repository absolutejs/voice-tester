#!/usr/bin/env bun
// Minimal CLI for one-shot regression checks. Run as:
//   bunx @absolutejs/voice-tester \
//     --target wss://example.com/v1/voice/phone/stream \
//     --scenario adversarial \
//     --duration 90
//
// Environment:
//   DEEPGRAM_API_KEY  — required for STT + Aura TTS
//   ANTHROPIC_API_KEY — picked up by @absolutejs/ai

import { runScenario } from "./aiCaller";
import { adversarialScenario, happyPathScenario } from "./scenarios";

type Args = {
	target?: string;
	scenario?: "adversarial" | "happy-path";
	durationMs?: number;
	model?: string;
	voice?: string;
	from?: string;
	to?: string;
	sessionId?: string;
};

const parseArgs = (argv: string[]): Args => {
	const args: Args = {};
	for (let i = 0; i < argv.length; i += 1) {
		const flag = argv[i];
		const value = argv[i + 1];
		switch (flag) {
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
		}
	}
	return args;
};

const main = async () => {
	const args = parseArgs(process.argv.slice(2));
	if (!args.target) {
		console.error(
			"Usage: voice-tester --target wss://... [--scenario adversarial|happy-path] [--duration 90] [--model ...]",
		);
		process.exit(1);
	}
	const deepgramKey = process.env.DEEPGRAM_API_KEY;
	if (!deepgramKey) {
		console.error("DEEPGRAM_API_KEY is required for STT + TTS");
		process.exit(1);
	}

	const scenarioName = args.scenario ?? "adversarial";
	const llmConfig = args.model ? { model: args.model } : {};
	const scenario =
		scenarioName === "adversarial"
			? adversarialScenario({
					...(args.durationMs ? { maxDurationMs: args.durationMs } : {}),
					llm: llmConfig,
				})
			: happyPathScenario({
					...(args.durationMs ? { maxDurationMs: args.durationMs } : {}),
					llm: llmConfig,
				});

	const customParameters: Record<string, string> = {};
	if (args.sessionId) customParameters.sessionId = args.sessionId;

	const report = await runScenario({
		customParameters,
		scenario,
		stt: { apiKey: deepgramKey },
		tts: { apiKey: deepgramKey, ...(args.voice ? { model: args.voice } : {}) },
		wsUrl: args.target,
		...(args.from ? { from: args.from } : {}),
		...(args.to ? { to: args.to } : {}),
	});

	console.info("\n=== SCENARIO REPORT ===");
	console.info(JSON.stringify(report, null, 2));
	process.exit(report.endedReason === "error" ? 1 : 0);
};

main().catch((err) => {
	console.error(err);
	process.exit(1);
});
