// AI-driven caller. Owns the conversation loop:
//   1. Wait for the service to start speaking (we detect inbound media energy).
//   2. While the service speaks, accumulate its PCM into the STT WS so we
//      build a transcript of what the service said.
//   3. When the service finishes (mark/clear/silence), hand the rolling
//      transcript to the LLM with the scenario's `instructions` system prompt.
//   4. The LLM picks the next action: speak <text>, stay silent for <ms>,
//      interrupt now, or hang up.
//   5. Execute the action via the Twilio WS caller; repeat until hang-up or
//      the scenario timeout.

import { auraSpeak, type AuraTTSOptions } from "./auraTTS";
import { openDeepgramStt, type DeepgramSttOptions } from "./deepgramStt";
import {
	startTwilioWsCaller,
	type TwilioInboundFrame,
	type TwilioWsCaller,
	type TwilioWsCallerOptions,
} from "./twilioWsCaller";

export type CallerActionSpeak = {
	type: "speak";
	text: string;
	/** Override the AI caller's voice for this utterance. */
	voice?: string;
	/** Cut off and barge-in over any in-flight service audio first. */
	interrupt?: boolean;
};

export type CallerActionSilence = {
	type: "silence";
	/** How long to stay silent before doing anything else. */
	ms: number;
};

export type CallerActionHangup = {
	type: "hangup";
	reason?: string;
};

export type CallerAction =
	| CallerActionSpeak
	| CallerActionSilence
	| CallerActionHangup;

export type ConversationTurn = {
	speaker: "caller" | "service";
	text: string;
	at: number;
};

export type ScenarioContext = {
	/** Every utterance so far in chronological order. */
	transcript: ConversationTurn[];
	/** Total elapsed ms since the WS opened. */
	elapsedMs: number;
	/** Most recent service utterance (or null if still waiting on greeting). */
	lastServiceUtterance: string | null;
	/** How many caller turns have fired so far. */
	callerTurnCount: number;
};

export type ScenarioDecide = (ctx: ScenarioContext) => Promise<CallerAction> | CallerAction;

export type Scenario = {
	/** Short human label — `happy-path`, `adversarial`, etc. */
	id: string;
	/** Hard ceiling on the whole conversation. */
	maxDurationMs: number;
	/** Called every time the service finishes an utterance (or after `idleMs` of silence with no service speech). */
	decide: ScenarioDecide;
	/** When the service stops emitting media for this long, wake decide() anyway. Default 1500. */
	idleMs?: number;
	/** Max wait for the service to START responding after a caller speak. Default 8000. */
	responseStartTimeoutMs?: number;
};

export type RunScenarioOptions = {
	wsUrl: string;
	scenario: Scenario;
	tts: AuraTTSOptions;
	stt: DeepgramSttOptions;
	/** `start.customParameters` Twilio merges into the bridge — usually `sessionId`. */
	customParameters?: Record<string, string>;
	/** Caller phone (E.164). Default `+15555550100`. */
	from?: string;
	/** Service number (E.164). Default `+19999999999`. */
	to?: string;
	/** Optional logger; defaults to console.info. */
	log?: (line: string) => void;
};

export type ScenarioReport = {
	scenario: string;
	transcript: ConversationTurn[];
	callerTurns: number;
	serviceTurns: number;
	durationMs: number;
	endedReason: "scenario_hangup" | "timeout" | "ws_closed" | "error";
	error?: { message: string };
	streamSid: string;
};

// Detect "the service has finished its turn" via two signals:
//   - a Twilio `clear` event (the service explicitly told us it was done)
//   - or `idleMs` of zero inbound media frames (heuristic for silence)
// Either fires, we collect the rolling STT transcript and ask the scenario
// what to do next.

const SILENCE_THRESHOLD = 200; // PCM samples below this count as silence

const isLoudFrame = (samples: Int16Array): boolean => {
	for (let i = 0; i < samples.length; i += 1) {
		if (Math.abs(samples[i] ?? 0) > SILENCE_THRESHOLD) return true;
	}
	return false;
};

export const runScenario = async (
	options: RunScenarioOptions,
): Promise<ScenarioReport> => {
	const log = options.log ?? ((line) => console.info(line));
	const startedAt = Date.now();
	const transcript: ConversationTurn[] = [];
	let callerTurnCount = 0;
	let serviceTurnCount = 0;
	let lastInboundLoudAt = 0;
	let currentServiceText = "";
	let endedReason: ScenarioReport["endedReason"] = "ws_closed";
	let error: Error | null = null;

	let caller: TwilioWsCaller | null = null;
	const stt = openDeepgramStt(options.stt);
	stt.on("open", () => log(`[stt] open`));
	stt.on("close", (code, reason) =>
		log(`[stt] close code=${code} reason=${reason || "(none)"}`),
	);
	stt.on("error", (err) => {
		log(`[stt] error: ${err.message}`);
	});
	stt.on("partial", (text) => log(`[stt:partial] ${text}`));
	stt.on("final", (text) => {
		log(`[stt:final] ${text}`);
		// Append to the in-flight service-utterance buffer; we treat a clear
		// (or idle gap) as the boundary, not the STT final alone — services
		// sometimes finalize mid-thought.
		currentServiceText = currentServiceText
			? `${currentServiceText} ${text}`
			: text;
	});
	let mediaFrameCount = 0;
	let lastMediaLogAt = 0;

	const closeServiceTurn = (reason: "clear" | "idle") => {
		const text = currentServiceText.trim();
		if (!text) return;
		serviceTurnCount += 1;
		transcript.push({
			at: Date.now() - startedAt,
			speaker: "service",
			text,
		});
		log(`[service:${reason}] ${text}`);
		currentServiceText = "";
	};

	try {
		caller = startTwilioWsCaller({
			customParameters: options.customParameters,
			from: options.from,
			to: options.to,
			wsUrl: options.wsUrl,
		} satisfies TwilioWsCallerOptions);

		const offFrame = caller.onFrame((frame: TwilioInboundFrame) => {
			if (frame.type === "media") {
				mediaFrameCount += 1;
				if (isLoudFrame(frame.pcm)) lastInboundLoudAt = Date.now();
				stt.send(frame.pcm);
				const now = Date.now();
				if (now - lastMediaLogAt > 2000) {
					log(
						`[media] inboundFrames=${mediaFrameCount} lastLoud=${lastInboundLoudAt ? `${now - lastInboundLoudAt}ms ago` : "never"}`,
					);
					lastMediaLogAt = now;
				}
			} else if (frame.type === "clear") {
				closeServiceTurn("clear");
			} else if (frame.type === "mark") {
				log(`[service:mark] ${frame.name}`);
			}
		});

		await caller.ready;
		log(`[caller] streamSid=${caller.streamSid} connected`);

		const idleMs = options.scenario.idleMs ?? 1500;
		// How long to wait for the service to START responding after we speak.
		// If nothing comes back in this window, we treat the service's response
		// as "silence" and let the scenario decide what to do next.
		const responseStartTimeoutMs =
			options.scenario.responseStartTimeoutMs ?? 8000;
		const deadline = Date.now() + options.scenario.maxDurationMs;

		const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

		// When we last did anything that moves the conversation forward. We
		// use this as the floor for the idle-watch so a stale lastInboundLoudAt
		// from BEFORE our caller utterance doesn't immediately trip "idle".
		let lastCallerActionAt = Date.now();

		while (Date.now() < deadline) {
			// Phase 1: wait for the service to START responding (or a hard
			// timeout). Without this floor, the idle-watch below would exit
			// immediately if the bot hasn't begun speaking yet — because
			// lastInboundLoudAt is still the OLD value from before we spoke.
			const responseFloor = lastCallerActionAt;
			const responseDeadline =
				responseFloor + responseStartTimeoutMs;
			while (
				Date.now() < deadline &&
				lastInboundLoudAt <= responseFloor &&
				Date.now() < responseDeadline
			) {
				await wait(150);
			}

			// Phase 2: wait until the service has been quiet long enough —
			// that's our turn signal.
			let idleStart = Math.max(Date.now(), lastInboundLoudAt);
			while (Date.now() < deadline) {
				if (lastInboundLoudAt > idleStart)
					idleStart = lastInboundLoudAt;
				if (Date.now() - idleStart >= idleMs) break;
				await wait(150);
			}
			// Phase 3: give STT a final-flush window. The bot just stopped
			// transmitting; Deepgram still has ~300ms of endpointing latency
			// before it emits the `final` event we need.
			await wait(400);
			closeServiceTurn("idle");

			if (Date.now() >= deadline) {
				endedReason = "timeout";
				break;
			}

			const action = await options.scenario.decide({
				callerTurnCount,
				elapsedMs: Date.now() - startedAt,
				lastServiceUtterance:
					transcript[transcript.length - 1]?.speaker === "service"
						? (transcript[transcript.length - 1]?.text ?? null)
						: null,
				transcript: [...transcript],
			});

			if (action.type === "hangup") {
				log(`[caller] hangup (${action.reason ?? "scenario"})`);
				endedReason = "scenario_hangup";
				break;
			}

			if (action.type === "silence") {
				log(`[caller] silence ${action.ms}ms`);
				await caller.speakSilence(action.ms);
				lastCallerActionAt = Date.now();
				// Count silence as a consumed turn too, otherwise a scripted
				// scenario whose first probe is silence will loop forever
				// (we'd ask the scenario for the same action every iteration).
				callerTurnCount += 1;
				continue;
			}

			callerTurnCount += 1;
			transcript.push({
				at: Date.now() - startedAt,
				speaker: "caller",
				text: action.text,
			});
			log(`[caller:say] ${action.text}`);

			const samples = await auraSpeak(action.text, {
				...options.tts,
				...(action.voice ? { model: action.voice } : {}),
			});
			await caller.speakPcm(samples);
			lastCallerActionAt = Date.now();
		}

		offFrame();
	} catch (err) {
		error = err instanceof Error ? err : new Error(String(err));
		endedReason = "error";
		log(`[caller] error: ${error.message}`);
	} finally {
		try {
			if (caller) await caller.close();
		} catch {}
		try {
			await stt.finish();
		} catch {}
	}

	closeServiceTurn("idle");

	return {
		callerTurns: callerTurnCount,
		durationMs: Date.now() - startedAt,
		endedReason,
		error: error ? { message: error.message } : undefined,
		scenario: options.scenario.id,
		serviceTurns: serviceTurnCount,
		streamSid: caller?.streamSid ?? "",
		transcript,
	};
};
