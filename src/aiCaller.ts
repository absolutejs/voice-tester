// AI-driven caller. Owns the conversation loop end-to-end and is intentionally
// transport-agnostic: anything that satisfies `Transport` works (Twilio Media
// Stream, Discord voice, future LiveKit / Zoom Media SDK, …). The engine:
//   1. Wait for the service to start speaking (detected via inbound media energy).
//   2. While the service speaks, accumulate PCM into the STT WS so we build
//      a rolling transcript of what the service said.
//   3. When the service finishes (mark/clear/silence), hand the rolling
//      transcript to the LLM with the scenario's system prompt.
//   4. The LLM picks the next action: speak <text>, stay silent for <ms>, or hang up.
//   5. Execute the action via the transport; repeat until hang-up or timeout.

import { auraSpeak, type AuraTTSOptions } from "./auraTTS";
import { openDeepgramStt, type DeepgramSttOptions } from "./deepgramStt";
import type { InboundAudioFrame, Transport } from "./transport";
import {
	twilioWsTransport,
	type TwilioWsTransportOptions,
} from "./transports/twilioWs";

export type CallerActionSpeak = {
	type: "speak";
	text: string;
	/** Override the AI caller's TTS voice for this utterance. */
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
	/** Total elapsed ms since the transport opened. */
	elapsedMs: number;
	/** Most recent service utterance (or null if still waiting on greeting). */
	lastServiceUtterance: string | null;
	/** How many caller turns have fired so far. */
	callerTurnCount: number;
};

export type ScenarioDecide = (
	ctx: ScenarioContext,
) => Promise<CallerAction> | CallerAction;

export type Scenario = {
	/** Short human label — `happy-path`, `adversarial`, etc. */
	id: string;
	/** Hard ceiling on the whole conversation. */
	maxDurationMs: number;
	/** Called when the service finishes an utterance (or after `idleMs` of no service speech). */
	decide: ScenarioDecide;
	/** When the service stops emitting media for this long, wake decide() anyway. Default 1500. */
	idleMs?: number;
	/** Max wait for the service to START responding after a caller speak. Default 8000. */
	responseStartTimeoutMs?: number;
};

export type RunScenarioOptions = {
	/** Pre-built transport (twilio-ws, discord, your own). */
	transport: Transport;
	scenario: Scenario;
	tts: AuraTTSOptions;
	stt: DeepgramSttOptions;
	/** Optional logger; defaults to console.info. */
	log?: (line: string) => void;
};

export type ScenarioReport = {
	scenario: string;
	transport: string;
	transcript: ConversationTurn[];
	callerTurns: number;
	serviceTurns: number;
	durationMs: number;
	endedReason: "scenario_hangup" | "timeout" | "transport_closed" | "error";
	error?: { message: string };
};

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
	let endedReason: ScenarioReport["endedReason"] = "transport_closed";
	let error: Error | null = null;
	let mediaFrameCount = 0;
	let lastMediaLogAt = 0;

	const transport = options.transport;
	const sampleRate = transport.sampleRateHz;

	const stt = openDeepgramStt({ ...options.stt, sampleRateHz: sampleRate });
	stt.on("open", () => log(`[stt] open (rate=${sampleRate}Hz)`));
	stt.on("close", (code, reason) =>
		log(`[stt] close code=${code} reason=${reason || "(none)"}`),
	);
	stt.on("error", (err) => log(`[stt] error: ${err.message}`));
	stt.on("partial", (text) => log(`[stt:partial] ${text}`));
	stt.on("final", (text) => {
		log(`[stt:final] ${text}`);
		currentServiceText = currentServiceText
			? `${currentServiceText} ${text}`
			: text;
	});

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
		const offFrame = transport.onFrame((frame: InboundAudioFrame) => {
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

		await transport.ready;
		log(`[caller] transport=${transport.id} ready (rate=${sampleRate}Hz)`);

		const idleMs = options.scenario.idleMs ?? 1500;
		const responseStartTimeoutMs =
			options.scenario.responseStartTimeoutMs ?? 8000;
		const deadline = Date.now() + options.scenario.maxDurationMs;
		const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

		// Floor for the response-start watch — without this, an old lastLoud
		// timestamp from before our caller speak would trip "service idle"
		// before the bot has had a chance to start responding.
		let lastCallerActionAt = Date.now();

		while (Date.now() < deadline) {
			// Phase 1: wait for the service to start responding (or timeout).
			const responseFloor = lastCallerActionAt;
			const responseDeadline = responseFloor + responseStartTimeoutMs;
			while (
				Date.now() < deadline &&
				lastInboundLoudAt <= responseFloor &&
				Date.now() < responseDeadline
			) {
				await wait(150);
			}

			// Phase 2: wait until the service has been quiet long enough.
			let idleStart = Math.max(Date.now(), lastInboundLoudAt);
			while (Date.now() < deadline) {
				if (lastInboundLoudAt > idleStart)
					idleStart = lastInboundLoudAt;
				if (Date.now() - idleStart >= idleMs) break;
				await wait(150);
			}
			// Phase 3: STT final-flush window (~300ms endpointing).
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
				await transport.silence(action.ms);
				lastCallerActionAt = Date.now();
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
			}, { sampleRateHz: sampleRate });
			await transport.speakPcm(samples);
			lastCallerActionAt = Date.now();
		}

		offFrame();
	} catch (err) {
		error = err instanceof Error ? err : new Error(String(err));
		endedReason = "error";
		log(`[caller] error: ${error.message}`);
	} finally {
		try {
			await transport.close();
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
		transcript,
		transport: transport.id,
	};
};

// Convenience wrapper: build a Twilio WS transport and runScenario in one
// call, preserving the original entry point users wrote against.
export type RunTwilioScenarioOptions = Omit<RunScenarioOptions, "transport"> &
	TwilioWsTransportOptions;

export const runTwilioScenario = (
	options: RunTwilioScenarioOptions,
): Promise<ScenarioReport> => {
	const { scenario, tts, stt, log, ...transportOptions } = options;
	const transport = twilioWsTransport(transportOptions);
	return runScenario({
		log,
		scenario,
		stt,
		transport,
		tts,
	});
};
