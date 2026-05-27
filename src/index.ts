// @absolutejs/voice-tester — AI-driven automated tester for voice services.
// Transport-agnostic core (Twilio Media Streams + Discord voice ship; bring
// your own for anything else).

export {
	runScenario,
	runTwilioScenario,
	type CallerAction,
	type CallerActionHangup,
	type CallerActionSilence,
	type CallerActionSpeak,
	type ConversationTurn,
	type RunScenarioOptions,
	type RunTwilioScenarioOptions,
	type Scenario,
	type ScenarioContext,
	type ScenarioDecide,
	type ScenarioReport,
} from "./aiCaller";

export type { InboundAudioFrame, Transport } from "./transport";
export {
	twilioWsTransport,
	type TwilioWsTransportOptions,
} from "./transports/twilioWs";
// NB: `discordVoiceTransport` requires the optional peer deps `discord.js`,
// `@discordjs/voice`, and `prism-media`. Import it directly from the
// `/discord` subpath so users who don't run Discord mode don't pull them.
// e.g. `import { discordVoiceTransport } from "@absolutejs/voice-tester/discord";`

export { auraSpeak, type AuraSpeakOptions, type AuraTTSOptions } from "./auraTTS";
export {
	openDeepgramStt,
	type DeepgramSttEvents,
	type DeepgramSttOptions,
	type DeepgramSttSession,
} from "./deepgramStt";

export {
	decideNextAction,
	type CallerLLMConfig,
	type CallerLLMDecision,
} from "./llm";

export {
	decodeMulawBase64,
	decodeMulawSample,
	encodeMulawBase64,
	encodeMulawSample,
	frame20ms8k,
	resamplePcm,
} from "./mulaw";
