// Transport contract — the scenario engine is intentionally meeting-agnostic.
// Anything that can: (a) open, (b) accept outbound PCM audio, (c) emit
// inbound audio frames, and (d) close, can be the test subject. Today we
// ship a Twilio Media Stream WS transport (`twilioWsTransport`) and a Discord
// voice transport (`discordVoiceTransport`); third parties can implement
// their own (LiveKit, Zoom Media SDK, a custom gateway, …) without touching
// the AI caller loop.

export type InboundAudioFrame =
	| {
			type: "media";
			pcm: Int16Array;
			receivedAt: number;
			/** Some transports (Discord) deliver per-speaker frames. */
			speakerId?: string;
	  }
	| { type: "clear"; receivedAt: number }
	| { type: "mark"; name: string; receivedAt: number }
	| { type: "raw"; raw: string };

export type Transport = {
	/** Stable identifier surfaced in the report (streamSid / channelId / …). */
	id: string;
	/** Sample rate of PCM passed to `speakPcm` AND emitted by inbound frames. */
	sampleRateHz: number;
	/** Resolves when media exchange is possible (post-handshake). */
	ready: Promise<void>;
	/** Send mono 16-bit PCM at `sampleRateHz`. Paced internally where required. */
	speakPcm: (samples: Int16Array) => Promise<void>;
	/**
	 * Hold for `ms` without sending audio. Twilio cares about silence frames
	 * to maintain stream pacing; Discord doesn't need them (silence = no send).
	 */
	silence: (ms: number) => Promise<void>;
	/** Subscribe to inbound frames. Returns an unsubscribe callback. */
	onFrame: (handler: (frame: InboundAudioFrame) => void) => () => void;
	/** Tear down the transport — equivalent to hangup / leaving the channel. */
	close: () => Promise<void>;
};
