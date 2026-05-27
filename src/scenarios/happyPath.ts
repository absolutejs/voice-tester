// Happy-path scenario — a plausible new subscriber answering an intake bot
// naturally for ~75 seconds. Useful as a baseline: if this one fails, the
// bot is broken in the boring way, not just the adversarial way.

import type { CallerAction, Scenario } from "../aiCaller";
import { decideNextAction, type CallerLLMConfig } from "../llm";

export type HappyPathOptions = {
	llm: Omit<CallerLLMConfig, "system">;
	/** Default 75_000 (75s). */
	maxDurationMs?: number;
};

const HAPPY_SYSTEM = `You are a realistic new subscriber being onboarded by a voice AI receptionist over the phone. You're a coach selling a $4k group program for women in their 40s; you have about 800 newsletter subscribers; you've never done a partnership before. Answer the bot's questions naturally, in 1-2 short sentences. After ~5 of your turns OR if the bot says it has what it needs, hang up politely. Never break character.`;

export const happyPathScenario = (options: HappyPathOptions): Scenario => ({
	decide: async ({ transcript, lastServiceUtterance, callerTurnCount }) => {
		if (callerTurnCount >= 6) {
			return { reason: "max_turns_reached", type: "hangup" };
		}
		const decision = await decideNextAction(
			{ ...options.llm, system: HAPPY_SYSTEM },
			transcript,
			lastServiceUtterance,
		);
		return decision as CallerAction;
	},
	id: "happy-path",
	idleMs: 1500,
	maxDurationMs: options.maxDurationMs ?? 75_000,
});
