// Thin wrapper around `@absolutejs/ai` for LLM-driven scenarios. We don't pin
// a model here — scenarios pass whichever model id they want and the AI
// package routes it. Defaults to Claude Haiku for snappy, cheap calls.

import { anthropic, generateAI } from "@absolutejs/ai";

export type CallerLLMConfig = {
	/** Anthropic model id. Default `claude-haiku-4-5-20251001`. */
	model?: string;
	/** Anthropic API key. Falls back to `ANTHROPIC_API_KEY`. */
	apiKey?: string;
	/** Caller persona / scenario rules. Becomes the system prompt. */
	system: string;
	/** Max tokens per decision. Default 200. */
	maxTokens?: number;
};

export type CallerLLMDecision =
	| { type: "speak"; text: string }
	| { type: "silence"; ms: number }
	| { type: "hangup"; reason?: string };

const DECISION_GRAMMAR = `Respond with ONE line of JSON, no markdown, matching one of:
{"type":"speak","text":"<what you literally say next>"}
{"type":"silence","ms":<integer 500-12000>}
{"type":"hangup","reason":"<short>"}`;

/**
 * Ask the LLM for the next caller action given the running transcript.
 * Falls back to a clean hangup if the model output won't parse, so the test
 * always terminates.
 */
export const decideNextAction = async (
	config: CallerLLMConfig,
	transcript: { speaker: string; text: string }[],
	lastService: string | null,
): Promise<CallerLLMDecision> => {
	const formatted = transcript
		.map((t) => `${t.speaker === "caller" ? "ME" : "BOT"}: ${t.text}`)
		.join("\n");
	const prompt = [
		"Conversation so far (between you, the test caller, and the voice bot):",
		formatted || "(no exchange yet — the bot may not have spoken)",
		"",
		lastService
			? `Bot just said: "${lastService}"`
			: "Bot has been silent.",
		"",
		"Pick your NEXT action. Only one. Be concise.",
		DECISION_GRAMMAR,
	].join("\n");

	const apiKey = config.apiKey ?? process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		return {
			reason: "no_anthropic_key",
			type: "hangup",
		};
	}
	const provider = anthropic({ apiKey });
	const result = await generateAI({
		maxTokens: config.maxTokens ?? 200,
		messages: [{ content: prompt, role: "user" }],
		model: config.model ?? "claude-haiku-4-5-20251001",
		provider,
		systemPrompt: config.system,
	});
	try {
		const json = result.text
			.trim()
			.replace(/^```(?:json)?\s*/i, "")
			.replace(/```\s*$/i, "");
		const parsed = JSON.parse(json) as Partial<CallerLLMDecision> & {
			type?: string;
		};
		if (parsed.type === "speak" && typeof parsed.text === "string") {
			return { text: parsed.text, type: "speak" };
		}
		if (parsed.type === "silence" && typeof parsed.ms === "number") {
			return { ms: parsed.ms, type: "silence" };
		}
		if (parsed.type === "hangup") {
			return {
				reason: typeof parsed.reason === "string" ? parsed.reason : undefined,
				type: "hangup",
			};
		}
	} catch {
		// fallthrough to parse-fail hangup
	}
	return { reason: "llm_parse_fail", type: "hangup" };
};
