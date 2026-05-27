// Adversarial scenario — try to break the bot. Probes:
//   T1: long silence after the greeting (does the bot re-prompt or hang up?)
//   T2: mumbled / very short answer (does it ask for clarification?)
//   T3: interrupt the bot mid-sentence (does barge-in work?)
//   T4: switch to Spanish (does it cope or wedge into English-only?)
//   T5: ask completely off-topic (does it gracefully redirect?)
//   T6: rude hangup
//
// A real test framework would assert specific behaviors; for now we just
// capture the transcript + flag obvious failures (silence > 8s, looping,
// bot just hangs up).

import type { CallerAction, Scenario } from "../aiCaller";
import { decideNextAction, type CallerLLMConfig } from "../llm";

export type AdversarialOptions = {
	llm: Omit<CallerLLMConfig, "system">;
	maxDurationMs?: number;
};

const ADVERSARIAL_SYSTEM = `You are an adversarial QA tester probing a voice receptionist bot for failure modes. You're not rude — you're rigorous. Vary your tactic per turn. Stay under 12 words per utterance.`;

// A scripted spine that mixes deterministic stress probes with LLM-improvised
// turns so we cover the obvious failure modes and surprising ones.
const PROBE_SEQUENCE: CallerAction[] = [
	// T1: silence (forces the bot to re-prompt or quit)
	{ ms: 6000, type: "silence" },
	// T2: a near-mumble — single word, ambiguous
	{ text: "Um... maybe?", type: "speak" },
	// T3: barge-in attempt — say something immediately, will overlap if the bot is mid-greeting again
	{ interrupt: true, text: "Wait, hold on, let me ask you something first.", type: "speak" },
	// T4: switch to Spanish
	{ text: "¿Puedes hablar español? Necesito ayuda con esto.", type: "speak" },
	// T5: off-topic
	{ text: "Actually, what's the weather like in Tokyo right now?", type: "speak" },
];

export const adversarialScenario = (options: AdversarialOptions): Scenario => ({
	decide: async ({
		transcript,
		lastServiceUtterance,
		callerTurnCount,
		elapsedMs,
	}) => {
		// Burn through scripted probes first.
		if (callerTurnCount < PROBE_SEQUENCE.length) {
			return PROBE_SEQUENCE[callerTurnCount]!;
		}
		// Then improvise one or two with the LLM before hanging up.
		if (callerTurnCount >= PROBE_SEQUENCE.length + 2 || elapsedMs > 70_000) {
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
	maxDurationMs: options.maxDurationMs ?? 90_000,
});
