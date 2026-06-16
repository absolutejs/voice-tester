// Adversarial scenario — try to break the bot. Probes:
//   T1: long silence after the greeting (does the bot re-prompt or hang up?)
//   T2: mumbled / very short answer (does it ask for clarification?)
//   T3: switch to Spanish (does it cope or wedge into English-only?)
//   T4: ask completely off-topic (does it gracefully redirect?)
//   T5: explicitly ask the bot to slow down (does set_response_pace fire?)
//   T6: rude hangup
//
// Earlier this scenario fired probes back-to-back with NO inter-probe silence,
// which (a) wasn't realistic — real callers pause between sentences, and
// (b) under twilio-ws fake-stream mode could merge multiple probes into one
// mega-turn on the bot's Deepgram side, leaving the bot stuck on weird
// input. Now every speak action is followed by a `silence` long enough to
// guarantee the bot's silenceMs turn-detector commits the probe individually.
//
// Tune via `interProbeSilenceMs`. Default 3500ms — fits typical bot
// silenceMs (1.5-2.5s) plus headroom for STT endpointing.
//
// A real test framework would assert specific behaviors; for now we just
// capture the transcript + flag obvious failures (silence > 8s, looping,
// bot just hangs up).

import type { CallerAction, Scenario } from "../aiCaller";
import { decideNextAction, type CallerLLMConfig } from "../llm";

export type AdversarialOptions = {
	llm: Omit<CallerLLMConfig, "system">;
	maxDurationMs?: number;
	/**
	 * Silence inserted between consecutive speak actions so the bot's
	 * turn-detector can commit each probe individually. Default 3500ms —
	 * fits typical bot silenceMs (1.5-2.5s) plus headroom. Set lower to
	 * stress-test back-to-back utterance handling.
	 */
	interProbeSilenceMs?: number;
};

const ADVERSARIAL_SYSTEM = `You are an adversarial QA tester probing a voice receptionist bot for failure modes. You're not rude — you're rigorous. Vary your tactic per turn. Stay under 12 words per utterance.`;

// Pure speak actions — silence between them is injected by `decide()` below
// so the bot's turn-detector commits each probe individually.
const SPEAK_PROBES: CallerAction[] = [
	{ text: "Um... maybe?", type: "speak" },
	{ text: "Wait, hold on, let me ask you something first.", type: "speak" },
	{ text: "¿Puedes hablar español? Necesito ayuda con esto.", type: "speak" },
	{ text: "Actually, what's the weather like in Tokyo right now?", type: "speak" },
	{
		text: "Slow down please, you're talking too fast for me.",
		type: "speak",
	},
];

export const adversarialScenario = (options: AdversarialOptions): Scenario => {
	const interProbeMs = options.interProbeSilenceMs ?? 3500;
	// Interleave each speak probe with an inter-probe silence so the bot's
	// silenceMs turn-detector commits between them. The first action is a 6s
	// silence after the greeting (the classic "did the bot re-prompt"
	// probe) — that doesn't need a trailing silence since the bot's response
	// IS what we're listening for.
	const SCRIPT: CallerAction[] = [
		{ ms: 6000, type: "silence" }, // T1: post-greeting silence probe
	];
	for (const probe of SPEAK_PROBES) {
		SCRIPT.push(probe);
		SCRIPT.push({ ms: interProbeMs, type: "silence" });
	}

	return {
		decide: async ({
			transcript,
			lastServiceUtterance,
			callerTurnCount,
			elapsedMs,
		}) => {
			// Burn through scripted probes first.
			if (callerTurnCount < SCRIPT.length) {
				return SCRIPT[callerTurnCount]!;
			}
			// Then improvise one or two with the LLM before hanging up.
			if (callerTurnCount >= SCRIPT.length + 2 || elapsedMs > 90_000) {
				return { reason: "probe_complete", type: "hangup" };
			}
			const decision = await decideNextAction(
				{ ...options.llm, system: ADVERSARIAL_SYSTEM },
				transcript,
				lastServiceUtterance,
			);
			return decision as CallerAction;
		},
		id: "adversarial",
		idleMs: 1200,
		maxDurationMs: options.maxDurationMs ?? 120_000,
	};
};
