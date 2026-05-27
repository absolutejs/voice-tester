// Caller-side Twilio Media Stream transport. Speaks Twilio's WS protocol as
// if we were the carrier dialing into a `@absolutejs/voice` (or any) bridge.
// Sample rate is fixed at 8 kHz mono μ-law — telephony native.

import {
	decodeMulawBase64,
	encodeMulawBase64,
	frame20ms8k,
} from "../mulaw";
import type { InboundAudioFrame, Transport } from "../transport";

export type TwilioWsTransportOptions = {
	/** `wss://...` URL of the service's Media Stream endpoint. */
	wsUrl: string;
	/** `customParameters` merged into the Twilio `start` envelope (e.g. sessionId). */
	customParameters?: Record<string, string>;
	/** Caller phone (E.164). */
	from?: string;
	/** Service phone (E.164). */
	to?: string;
	/** Override the simulated streamSid (default: random `MZ…`). */
	streamSid?: string;
	/** Override the simulated callSid (default: random `CA…`). */
	callSid?: string;
};

const FRAME_INTERVAL_MS = 20;
const SAMPLES_PER_FRAME = 160;

const randomSid = (prefix: string) => {
	const hex = Array.from({ length: 32 }, () =>
		Math.floor(Math.random() * 16).toString(16),
	).join("");
	return `${prefix}${hex}`;
};

/**
 * Open a Twilio Media Stream as the caller side. Throws on connect failure.
 */
export const twilioWsTransport = (
	options: TwilioWsTransportOptions,
): Transport => {
	const streamSid = options.streamSid ?? randomSid("MZ");
	const callSid = options.callSid ?? randomSid("CA");
	const ws = new WebSocket(options.wsUrl);
	ws.binaryType = "arraybuffer";

	const inboundHandlers = new Set<(frame: InboundAudioFrame) => void>();
	const emit = (frame: InboundAudioFrame) => {
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
		id: streamSid,
		onFrame: (handler) => {
			inboundHandlers.add(handler);
			return () => {
				inboundHandlers.delete(handler);
			};
		},
		ready,
		sampleRateHz: 8000,
		silence: async (ms) => {
			await ready;
			const frameCount = Math.ceil(ms / FRAME_INTERVAL_MS);
			const silence = new Int16Array(SAMPLES_PER_FRAME);
			const frames = Array.from({ length: frameCount }, () => silence);
			await sendFramesPaced(frames);
		},
		speakPcm: async (samples) => {
			await ready;
			await sendFramesPaced(frame20ms8k(samples));
		},
	};
};
