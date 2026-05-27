// Caller-side Twilio Media Stream simulator. Opens a WebSocket to a voice
// service's `/stream` endpoint and emits the exact frames Twilio would: a
// `connected` envelope, a `start` envelope carrying customParameters (so the
// service routes to the right session), then a steady 20ms cadence of `media`
// frames whenever the caller "speaks".
//
// The receiving service (e.g. @absolutejs/voice's twilio bridge) will reply
// with `media`/`mark`/`clear` events; we expose those as a typed event stream
// so the test runner can decode μ-law payloads back to PCM and pipe them into
// STT.

import {
	decodeMulawBase64,
	encodeMulawBase64,
	frame20ms8k,
} from "./mulaw";

export type TwilioWsCallerOptions = {
	/** `wss://...` URL of the service's Media Stream endpoint. */
	wsUrl: string;
	/** Caller's phone number (E.164). Surfaces in `start.start.callSid` etc. */
	from?: string;
	/** Service number being dialed (E.164). */
	to?: string;
	/** Custom parameters merged into `start.start.customParameters`. */
	customParameters?: Record<string, string>;
	/** Override the simulated streamSid (default: random `MZ…`). */
	streamSid?: string;
	/** Override the simulated callSid (default: random `CA…`). */
	callSid?: string;
};

export type TwilioInboundFrame =
	| { type: "media"; pcm: Int16Array; receivedAt: number }
	| { type: "clear"; receivedAt: number }
	| { type: "mark"; name: string; receivedAt: number }
	| { type: "raw"; raw: string };

const FRAME_INTERVAL_MS = 20;
const SAMPLES_PER_FRAME = 160;

const randomSid = (prefix: string) => {
	const hex = Array.from({ length: 32 }, () =>
		Math.floor(Math.random() * 16).toString(16),
	).join("");
	return `${prefix}${hex}`;
};

export type TwilioWsCaller = {
	/** Wait until the WS is open + the start envelope was sent. */
	ready: Promise<void>;
	/** Send 16-bit PCM @ 8 kHz; framed into 20 ms μ-law packets paced in real time. */
	speakPcm: (samples: Int16Array) => Promise<void>;
	/** Pad the line with silence frames for the given duration (preserves cadence). */
	speakSilence: (ms: number) => Promise<void>;
	/** Subscribe to inbound frames from the service. */
	onFrame: (handler: (frame: TwilioInboundFrame) => void) => () => void;
	/** Hang up — sends a stop envelope + closes the WS. */
	close: () => Promise<void>;
	/** Active stream SID. */
	streamSid: string;
};

/**
 * Spin up a caller-side Twilio Media Stream connection. Throws on connect
 * failure; returns a controller with paced `speakPcm` + inbound-frame
 * subscription.
 */
export const startTwilioWsCaller = (
	options: TwilioWsCallerOptions,
): TwilioWsCaller => {
	const streamSid = options.streamSid ?? randomSid("MZ");
	const callSid = options.callSid ?? randomSid("CA");
	const ws = new WebSocket(options.wsUrl);
	ws.binaryType = "arraybuffer";

	const inboundHandlers = new Set<(frame: TwilioInboundFrame) => void>();
	const emit = (frame: TwilioInboundFrame) => {
		for (const handler of inboundHandlers) handler(frame);
	};

	const ready = new Promise<void>((resolve, reject) => {
		ws.addEventListener("open", () => {
			ws.send(
				JSON.stringify({
					event: "connected",
					protocol: "Call",
					version: "1.0.0",
				}),
			);
			ws.send(
				JSON.stringify({
					event: "start",
					sequenceNumber: "1",
					start: {
						accountSid: "ACvoicetester0000000000000000000000",
						callSid,
						customParameters: options.customParameters ?? {},
						mediaFormat: {
							channels: 1,
							encoding: "audio/x-mulaw",
							sampleRate: 8000,
						},
						streamSid,
						tracks: ["inbound", "outbound"],
					},
					streamSid,
				}),
			);
			resolve();
		});
		ws.addEventListener("error", (event) => {
			const err =
				event instanceof ErrorEvent
					? (event.error ?? new Error(event.message))
					: new Error("voice-tester WS error");
			reject(err);
		});
	});

	ws.addEventListener("message", (event) => {
		if (typeof event.data !== "string") return;
		try {
			const payload = JSON.parse(event.data) as {
				event?: string;
				mark?: { name?: string };
				media?: { payload?: string };
			};
			const receivedAt = Date.now();
			switch (payload.event) {
				case "media":
					if (payload.media?.payload) {
						emit({
							pcm: decodeMulawBase64(payload.media.payload),
							receivedAt,
							type: "media",
						});
					}
					break;
				case "clear":
					emit({ receivedAt, type: "clear" });
					break;
				case "mark":
					emit({
						name: payload.mark?.name ?? "",
						receivedAt,
						type: "mark",
					});
					break;
			}
		} catch {
			emit({ raw: event.data, type: "raw" });
		}
	});

	let sequence = 2;
	const sendMediaFrame = (frame: Int16Array) => {
		if (ws.readyState !== WebSocket.OPEN) return;
		ws.send(
			JSON.stringify({
				event: "media",
				media: {
					chunk: String(sequence),
					payload: encodeMulawBase64(frame),
					timestamp: String((sequence - 2) * FRAME_INTERVAL_MS),
					track: "inbound",
				},
				sequenceNumber: String(sequence),
				streamSid,
			}),
		);
		sequence += 1;
	};

	const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const sendFramesPaced = async (frames: Int16Array[]) => {
		// Twilio sends frames at strict 20ms cadence; the receiving STT will
		// segment turns from the audio's energy + endpointing, so pacing matters.
		const startedAt = performance.now();
		for (let i = 0; i < frames.length; i += 1) {
			const target = startedAt + (i + 1) * FRAME_INTERVAL_MS;
			sendMediaFrame(frames[i]!);
			const drift = target - performance.now();
			if (drift > 0) await wait(drift);
		}
	};

	return {
		close: async () => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(
					JSON.stringify({
						event: "stop",
						sequenceNumber: String(sequence),
						stop: {
							accountSid: "ACvoicetester0000000000000000000000",
							callSid,
						},
						streamSid,
					}),
				);
				ws.close(1000, "voice-tester hangup");
			}
		},
		onFrame: (handler) => {
			inboundHandlers.add(handler);
			return () => {
				inboundHandlers.delete(handler);
			};
		},
		ready,
		speakPcm: async (samples) => {
			await ready;
			await sendFramesPaced(frame20ms8k(samples));
		},
		speakSilence: async (ms) => {
			await ready;
			const frameCount = Math.ceil(ms / FRAME_INTERVAL_MS);
			const silence = new Int16Array(SAMPLES_PER_FRAME);
			const frames = Array.from({ length: frameCount }, () => silence);
			await sendFramesPaced(frames);
		},
		streamSid,
	};
};
