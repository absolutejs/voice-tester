// Deepgram /v1/listen WS — the caller-side ear. We feed it μ-law-decoded PCM
// from the receptionist's outbound media frames and emit speech-final
// transcripts back to the conversation runner.
//
// Telephony arrives at 8 kHz — Deepgram nova-3 supports linear16 + 8 kHz
// natively, so we keep the data plane simple and skip Twilio mulaw encoding
// on the listen side (we already decoded it to PCM).

export type DeepgramSttOptions = {
	apiKey: string;
	/** Default `nova-3`. */
	model?: string;
	/** Language code for transcription (default `multi` so Spanish + English work). */
	language?: string;
	/** Default `https://api.deepgram.com`. */
	baseUrl?: string;
	/** Sample rate of the PCM we'll send (default 8000 for telephony, 48000 for Discord). */
	sampleRateHz?: number;
};

export type DeepgramSttEvents = {
	/** Final (utterance-complete) transcript. */
	final: (transcript: string) => void | Promise<void>;
	/** Interim partial transcript (every word, fast). */
	partial: (transcript: string) => void | Promise<void>;
	/** WS open. */
	open: () => void | Promise<void>;
	/** WS closed normally. */
	close: (code: number, reason: string) => void | Promise<void>;
	/** Adapter or WS error. */
	error: (err: Error) => void | Promise<void>;
};

export type DeepgramSttSession = {
	send: (pcmSamples: Int16Array) => void;
	finish: () => Promise<void>;
	on: <K extends keyof DeepgramSttEvents>(
		event: K,
		handler: DeepgramSttEvents[K],
	) => () => void;
};

/**
 * Open a Deepgram listen WebSocket. Caller pumps in 8 kHz linear16 frames via
 * `send()` and consumes `final` transcripts to drive the next LLM turn.
 */
export const openDeepgramStt = (
	options: DeepgramSttOptions,
): DeepgramSttSession => {
	const baseWs = (options.baseUrl ?? "https://api.deepgram.com")
		.replace(/^http/, "ws")
		.replace(/\/$/, "");
	const params = new URLSearchParams({
		channels: "1",
		encoding: "linear16",
		endpointing: "300",
		interim_results: "true",
		language: options.language ?? "multi",
		model: options.model ?? "nova-3",
		punctuate: "true",
		sample_rate: String(options.sampleRateHz ?? 8000),
		smart_format: "true",
		utterances: "true",
	});
	const url = `${baseWs}/v1/listen?${params.toString()}`;
	const ws = new WebSocket(url, ["token", options.apiKey]);
	ws.binaryType = "arraybuffer";

	const listeners: {
		[K in keyof DeepgramSttEvents]: Set<DeepgramSttEvents[K]>;
	} = {
		close: new Set(),
		error: new Set(),
		final: new Set(),
		open: new Set(),
		partial: new Set(),
	};

	const emit = async <K extends keyof DeepgramSttEvents>(
		event: K,
		...args: Parameters<DeepgramSttEvents[K]>
	) => {
		for (const handler of listeners[event]) {
			await (handler as (...a: unknown[]) => unknown)(...args);
		}
	};

	ws.addEventListener("open", () => void emit("open"));
	ws.addEventListener("error", (event) => {
		const err =
			event instanceof ErrorEvent
				? (event.error ?? new Error(event.message))
				: new Error("Deepgram WS error");
		void emit("error", err);
	});
	ws.addEventListener("close", (event) => {
		void emit("close", event.code, event.reason);
	});
	ws.addEventListener("message", (event) => {
		if (typeof event.data !== "string") return;
		try {
			const payload = JSON.parse(event.data) as {
				channel?: {
					alternatives?: { transcript?: string }[];
				};
				is_final?: boolean;
				speech_final?: boolean;
				type?: string;
			};
			if (payload.type !== "Results") return;
			const transcript =
				payload.channel?.alternatives?.[0]?.transcript ?? "";
			if (!transcript.trim()) return;
			if (payload.speech_final || payload.is_final) {
				void emit("final", transcript);
			} else {
				void emit("partial", transcript);
			}
		} catch {
			// Unknown payload shape; ignore.
		}
	});

	let pending: Int16Array[] = [];
	const flushPending = () => {
		if (ws.readyState !== WebSocket.OPEN) return;
		for (const frame of pending) {
			ws.send(frame.buffer.slice(frame.byteOffset, frame.byteOffset + frame.byteLength));
		}
		pending = [];
	};
	ws.addEventListener("open", flushPending);

	// Deepgram closes the listen WS with code 1011 (Net0001) after ~10s of no
	// audio. Caller-side silence probes are intentional, so we send a JSON
	// KeepAlive every 5s instead of forcing a steady stream of silence frames.
	// https://developers.deepgram.com/docs/keep-alive
	const keepAliveInterval = setInterval(() => {
		if (ws.readyState === WebSocket.OPEN) {
			ws.send(JSON.stringify({ type: "KeepAlive" }));
		}
	}, 5000);
	ws.addEventListener("close", () => clearInterval(keepAliveInterval));

	return {
		finish: async () => {
			if (ws.readyState === WebSocket.OPEN) {
				// CloseStream forces a final transcript flush from Deepgram.
				ws.send(JSON.stringify({ type: "CloseStream" }));
				await new Promise<void>((resolve) => {
					if (ws.readyState === WebSocket.CLOSED) {
						resolve();
						return;
					}
					ws.addEventListener("close", () => resolve(), {
						once: true,
					});
					// Belt + braces; some Deepgram models don't close cleanly.
					setTimeout(() => {
						try {
							ws.close();
						} catch {}
						resolve();
					}, 1500);
				});
			}
		},
		on: (event, handler) => {
			(listeners[event] as Set<typeof handler>).add(handler);
			return () => {
				(listeners[event] as Set<typeof handler>).delete(handler);
			};
		},
		send: (samples) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(
					samples.buffer.slice(
						samples.byteOffset,
						samples.byteOffset + samples.byteLength,
					),
				);
			} else if (ws.readyState === WebSocket.CONNECTING) {
				pending.push(samples);
			}
		},
	};
};
