// Re-export of the Discord transport on a stable subpath. Keeps the optional
// peer-dep imports (`discord.js`, `@discordjs/voice`, `prism-media`) off the
// main entry point so non-Discord users don't have to install them.
export {
	discordVoiceTransport,
	type DiscordVoiceTransportOptions,
} from "./transports/discord";
