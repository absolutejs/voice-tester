// G.711 μ-law (mu-law) codec — narrowband 8 kHz telephony format Twilio Media
// Streams uses. 8-bit samples; trivially round-trip lossless against the
// algorithm but lossy against true PCM (it's a compressed companding scheme).
//
// The encoder/decoder tables match ITU-T G.711 µ-law exactly; cross-checked
// against the equivalent helpers in @absolutejs/voice's twilio bridge.

const MULAW_BIAS = 0x84;
const MULAW_CLIP = 32635;

/** Encode a single 16-bit linear PCM sample to an 8-bit μ-law byte. */
export const encodeMulawSample = (pcmSample: number): number => {
	let sample = pcmSample;
	const sign = sample < 0 ? 0x80 : 0;
	if (sign !== 0) sample = -sample;
	if (sample > MULAW_CLIP) sample = MULAW_CLIP;
	sample += MULAW_BIAS;
	let exponent = 7;
	for (let mask = 0x4000; (sample & mask) === 0 && exponent > 0; mask >>= 1) {
		exponent -= 1;
	}
	const mantissa = (sample >> (exponent + 3)) & 0x0f;
	return (~(sign | (exponent << 4) | mantissa)) & 0xff;
};

/** Decode a single 8-bit μ-law byte back to a 16-bit linear PCM sample. */
export const decodeMulawSample = (mulawByte: number): number => {
	const inverted = ~mulawByte & 0xff;
	const sign = inverted & 0x80;
	const exponent = (inverted >> 4) & 0x07;
	const mantissa = inverted & 0x0f;
	let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
	sample -= MULAW_BIAS;
	return sign !== 0 ? -sample : sample;
};

/** Decode a base64 μ-law payload (Twilio media frame) to 16-bit PCM. */
export const decodeMulawBase64 = (payload: string): Int16Array => {
	const bytes = Buffer.from(payload, "base64");
	const out = new Int16Array(bytes.length);
	for (let i = 0; i < bytes.length; i += 1) {
		out[i] = decodeMulawSample(bytes[i] ?? 0);
	}
	return out;
};

/** Encode 16-bit linear PCM to a base64 μ-law payload (Twilio media frame). */
export const encodeMulawBase64 = (samples: Int16Array): string => {
	const bytes = new Uint8Array(samples.length);
	for (let i = 0; i < samples.length; i += 1) {
		bytes[i] = encodeMulawSample(samples[i] ?? 0);
	}
	return Buffer.from(bytes).toString("base64");
};

/**
 * Resample 16-bit PCM from `fromHz` to `toHz` using linear interpolation.
 * Good enough for telephony (8 kHz target, where the lowpass artifacts are
 * masked by the codec anyway). The receptionist bridge uses the same trick.
 */
export const resamplePcm = (
	input: Int16Array,
	fromHz: number,
	toHz: number,
): Int16Array => {
	if (fromHz === toHz) return input;
	const ratio = fromHz / toHz;
	const outLength = Math.floor(input.length / ratio);
	const out = new Int16Array(outLength);
	for (let i = 0; i < outLength; i += 1) {
		const srcIndex = i * ratio;
		const lo = Math.floor(srcIndex);
		const hi = Math.min(lo + 1, input.length - 1);
		const frac = srcIndex - lo;
		out[i] = Math.round(
			(input[lo] ?? 0) * (1 - frac) + (input[hi] ?? 0) * frac,
		);
	}
	return out;
};

/**
 * Split a PCM stream into 20 ms frames (160 samples @ 8 kHz). Twilio Media
 * Streams expects this packetization — sending larger chunks works but pacing
 * becomes a problem on the playback side.
 */
export const frame20ms8k = (samples: Int16Array): Int16Array[] => {
	const FRAME_SAMPLES = 160;
	const frames: Int16Array[] = [];
	for (let offset = 0; offset < samples.length; offset += FRAME_SAMPLES) {
		const end = Math.min(offset + FRAME_SAMPLES, samples.length);
		if (end - offset === FRAME_SAMPLES) {
			frames.push(samples.subarray(offset, end));
		} else {
			// Pad final partial frame with silence so packet pacing stays exact.
			const padded = new Int16Array(FRAME_SAMPLES);
			padded.set(samples.subarray(offset, end));
			frames.push(padded);
		}
	}
	return frames;
};
