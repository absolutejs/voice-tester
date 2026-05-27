// Deepgram Aura TTS — the caller-side mouth. We need 16-bit PCM @ 8 kHz so it
// drops straight into the μ-law encoder + 20ms frame packetizer downstream.
// Aura supports linear16 + container=none + native 8 kHz sample rate, so no
// resampling is required for telephony output.

import { resamplePcm } from "./mulaw";

export type AuraTTSOptions = {
	apiKey: string;
	/** Default `aura-asteria-en`. See https://developers.deepgram.com/docs/tts-models */
	model?: string;
	/** Default `https://api.deepgram.com`. */
	baseUrl?: string;
};

export type AuraSpeakOptions = {
	/** Target sample rate (8000 for telephony). Default 8000. */
	sampleRateHz?: number;
	/** Abort the in-flight request. */
	signal?: AbortSignal;
};

/**
 * Synthesize text to a single 16-bit PCM buffer. Returns mono samples at the
 * requested sample rate (default 8 kHz for telephony). Aura is fastest at
 * 8 kHz with container=none — ~150 ms to first byte.
 */
export const auraSpeak = async (
	text: string,
	tts: AuraTTSOptions,
	options: AuraSpeakOptions = {},
): Promise<Int16Array> => {
	const trimmed = text.trim();
	if (!trimmed) return new Int16Array(0);

	const target = options.sampleRateHz ?? 8000;
	// Pick the closest native Aura rate (8 / 16 / 24 / 48 kHz) so we resample
	// as little as possible. Telephony hot path is 8 kHz, Discord voice is
	// 48 kHz — both are native, no resampling needed in the common case.
	const NATIVE_RATES = [8000, 16000, 24000, 48000];
	const native = NATIVE_RATES.includes(target)
		? target
		: (NATIVE_RATES.find((r) => r >= target) ?? 48000);
	const baseUrl = (tts.baseUrl ?? "https://api.deepgram.com").replace(
		/\/$/,
		"",
	);
	const model = tts.model ?? "aura-asteria-en";
	const url = `${baseUrl}/v1/speak?model=${encodeURIComponent(
		model,
	)}&encoding=linear16&sample_rate=${native}&container=none`;

	const response = await fetch(url, {
		body: JSON.stringify({ text: trimmed }),
		headers: {
			authorization: `Token ${tts.apiKey}`,
			"content-type": "application/json",
		},
		method: "POST",
		signal: options.signal,
	});
	if (!response.ok) {
		const detail = await response.text().catch(() => "");
		throw new Error(
			`Deepgram Aura speak failed (${response.status}): ${detail || response.statusText}`,
		);
	}
	const bytes = new Uint8Array(await response.arrayBuffer());
	// linear16 is little-endian; trim a stray odd byte so 16-bit alignment holds.
	const evenLength = bytes.byteLength - (bytes.byteLength % 2);
	const pcm = new Int16Array(
		bytes.buffer,
		bytes.byteOffset,
		evenLength / 2,
	);
	// Copy out — the Int16Array view above shares the fetch buffer's lifetime.
	const owned = new Int16Array(pcm);
	return native === target ? owned : resamplePcm(owned, native, target);
};
