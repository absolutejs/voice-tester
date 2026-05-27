// Discord voice transport — joins a voice channel as a fake tester user,
// speaks Aura TTS into the channel as 48 kHz mono opus, and subscribes to
// other users' audio receivers (decoded opus → PCM) so the scenario engine
// can listen to whatever bot we're testing.
//
// Discord was the original Deal Referee test surface, so a Discord mode in
// the tester closes the loop on automated regression for the referee path
// (matching the Twilio-WS mode already shipping for the phone receptionist).
//
// Lifecycle:
//   1. Login to Discord with a bot token (the TESTER bot — NOT the bot we're
//      testing; they need to be two separate Discord applications).
//   2. Resolve guild + voice channel; joinVoiceChannel + wait for Ready.
//   3. Wire an AudioPlayer for outbound speech.
//   4. Subscribe to the voice receiver for the target user (or every
//      non-self user if no target specified) — pipe their opus packets
//      through a prism-media Opus.Decoder → 48 kHz mono PCM → emit as
//      InboundAudioFrame so the scenario engine can transcribe them.

import { Readable } from "node:stream";
import {
	AudioPlayerStatus,
	EndBehaviorType,
	NoSubscriberBehavior,
	StreamType,
	VoiceConnectionStatus,
	createAudioPlayer,
	createAudioResource,
	entersState,
	joinVoiceChannel,
	type VoiceConnection,
} from "@discordjs/voice";
import {
	Client,
	GatewayIntentBits,
	type VoiceBasedChannel,
} from "discord.js";
import { opus } from "prism-media";
import type { InboundAudioFrame, Transport } from "../transport";

export type DiscordVoiceTransportOptions = {
	/** Bot token for the TESTER application. Not the bot being tested. */
	token: string;
	/** Guild snowflake to connect to. */
	guildId: string;
	/** Voice channel snowflake to join. */
	channelId: string;
	/**
	 * Optional: only emit inbound frames for this user snowflake (the bot you
	 * are testing). When omitted, every non-self user's audio is forwarded.
	 */
	targetUserId?: string;
	/** Timeout for the join → Ready handshake. Default 15_000 ms. */
	joinTimeoutMs?: number;
	/** Drop in an existing logged-in discord.js Client instead of logging in. */
	client?: Client;
	/** Self-deafen on join (don't bother decoding inbound audio downloads we don't subscribe to). Default true. */
	selfDeaf?: boolean;
};

const DISCORD_SAMPLE_RATE = 48000;
const DISCORD_FRAME_SIZE = 960; // 20 ms @ 48 kHz mono (decoded inbound side)

/**
 * Drive @discordjs/voice from a Readable.
 *
 * `StreamType.Raw` in @discordjs/voice expects **stereo 48 kHz 16-bit LE PCM**
 * (signed). Our TTS (`auraSpeak`) produces **mono** PCM at the transport's
 * sampleRateHz (48 kHz here), so we duplicate every sample into L + R
 * interleaved before pushing — otherwise the player misinterprets every pair
 * of mono samples as one stereo frame and the receiving side hears garbage
 * at 2× speed. Verified live: a Deal Referee with `EndBehaviorType.AfterSilence`
 * + a `channels: 2` OpusDecoder receives audio_progress frames but produces
 * NO transcript when fed mono-as-stereo audio; upmixing fixes it.
 */
class PcmPushable extends Readable {
	private finished = false;
	_read() {
		/* push happens externally via `pushSamples` */
	}
	pushSamples(monoSamples: Int16Array) {
		if (this.finished) return;
		const stereo = new Int16Array(monoSamples.length * 2);
		for (let i = 0; i < monoSamples.length; i += 1) {
			const sample = monoSamples[i] ?? 0;
			stereo[i * 2] = sample; // L
			stereo[i * 2 + 1] = sample; // R
		}
		this.push(
			Buffer.from(stereo.buffer, stereo.byteOffset, stereo.byteLength),
		);
	}
	endStream() {
		if (this.finished) return;
		this.finished = true;
		this.push(null);
	}
}

export const discordVoiceTransport = async (
	options: DiscordVoiceTransportOptions,
): Promise<Transport> => {
	const inboundHandlers = new Set<(frame: InboundAudioFrame) => void>();
	const emit = (frame: InboundAudioFrame) => {
		for (const handler of inboundHandlers) handler(frame);
	};

	const ownsClient = !options.client;
	const client =
		options.client ??
		new Client({
			intents: [
				GatewayIntentBits.Guilds,
				GatewayIntentBits.GuildVoiceStates,
			],
		});

	if (ownsClient) {
		await client.login(options.token);
	}
	// Wait for the gateway "ready" before fetching guilds so adapterCreator works.
	if (!client.isReady()) {
		await new Promise<void>((resolve) =>
			client.once("clientReady", () => resolve()),
		);
	}

	const guild = await client.guilds.fetch(options.guildId);
	const channelRaw = await guild.channels.fetch(options.channelId);
	if (!channelRaw || !channelRaw.isVoiceBased()) {
		throw new Error(
			`Discord channel ${options.channelId} is not a voice channel`,
		);
	}
	const channel = channelRaw as VoiceBasedChannel;

	const selfId = client.user?.id;

	const connection: VoiceConnection = joinVoiceChannel({
		adapterCreator: guild.voiceAdapterCreator,
		channelId: channel.id,
		guildId: guild.id,
		selfDeaf: options.selfDeaf ?? false,
		selfMute: false,
	});

	const player = createAudioPlayer({
		behaviors: { noSubscriber: NoSubscriberBehavior.Pause },
	});
	connection.subscribe(player);

	const subscribedUsers = new Set<string>();
	const subscribeToUser = (userId: string) => {
		if (subscribedUsers.has(userId)) return;
		if (selfId && userId === selfId) return;
		if (options.targetUserId && userId !== options.targetUserId) return;
		subscribedUsers.add(userId);

		const audioStream = connection.receiver.subscribe(userId, {
			end: { behavior: EndBehaviorType.Manual },
		});
		// 20 ms opus packets in; 20 ms mono 48 kHz PCM out. Mirrors the
		// configuration used by @absolutejs/meeting-discord on the referee
		// receive side, so we're decoding the exact same audio the bot hears.
		const decoder = new opus.Decoder({
			channels: 1,
			frameSize: DISCORD_FRAME_SIZE,
			rate: DISCORD_SAMPLE_RATE,
		});
		audioStream.pipe(decoder);
		decoder.on("data", (chunk: Buffer) => {
			// chunk is mono 16-bit LE PCM — wrap as Int16Array without copying.
			const samples = new Int16Array(
				chunk.buffer,
				chunk.byteOffset,
				chunk.byteLength / 2,
			);
			// Copy out — the Buffer's lifetime is bounded by the next chunk.
			const owned = new Int16Array(samples);
			emit({
				pcm: owned,
				receivedAt: Date.now(),
				speakerId: userId,
				type: "media",
			});
		});
		decoder.on("error", () => {
			// Opus decoder errors are non-fatal for the rest of the call.
			subscribedUsers.delete(userId);
		});
	};

	// Discord broadcasts "speaking" events whenever a user starts emitting RTP.
	// We use that as our trigger to subscribe to their receiver, so we don't
	// blindly subscribe to every user in the channel up-front.
	connection.receiver.speaking.on("start", (userId: string) => {
		subscribeToUser(userId);
	});

	const ready = entersState(
		connection,
		VoiceConnectionStatus.Ready,
		options.joinTimeoutMs ?? 15_000,
	).then(() => undefined);

	// One push stream + one audio resource per `speakPcm` call — keeps barge-in
	// behavior simple (start a new utterance ⇒ cancel the in-flight one).
	let activeStream: PcmPushable | null = null;
	const speakPcm = async (samples: Int16Array): Promise<void> => {
		await ready;
		if (activeStream) {
			activeStream.endStream();
			activeStream = null;
		}
		const stream = new PcmPushable();
		activeStream = stream;
		stream.pushSamples(samples);
		stream.endStream();
		const resource = createAudioResource(stream, {
			inputType: StreamType.Raw,
		});
		player.play(resource);
		await new Promise<void>((resolve) => {
			const handleIdle = () => {
				player.off(AudioPlayerStatus.Idle, handleIdle);
				resolve();
			};
			player.on(AudioPlayerStatus.Idle, handleIdle);
		});
		if (activeStream === stream) activeStream = null;
	};

	const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const close = async () => {
		try {
			player.stop(true);
			connection.destroy();
		} catch {}
		if (ownsClient) {
			try {
				await client.destroy();
			} catch {}
		}
	};

	return {
		close,
		id: `discord:${guild.id}:${channel.id}`,
		onFrame: (handler) => {
			inboundHandlers.add(handler);
			return () => {
				inboundHandlers.delete(handler);
			};
		},
		ready,
		sampleRateHz: DISCORD_SAMPLE_RATE,
		silence: async (ms) => {
			await ready;
			// Discord doesn't need silence frames to maintain a stream; just
			// idle for `ms` and let any subscribed receivers keep emitting
			// inbound frames if the other side is speaking.
			await wait(ms);
		},
		speakPcm,
	};
};
