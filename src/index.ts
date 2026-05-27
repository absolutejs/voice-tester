// @absolutejs/voice-tester — AI-driven automated tester for voice services
// that speak the Twilio Media Streams protocol. Designed for the AbsoluteJS
// AI Studio: run regression scenarios against any deployed @absolutejs/voice
// receptionist without a phone, a real Twilio call, or a human in the loop.

export {
	runScenario,
	type CallerAction,
	type CallerActionHangup,
	type CallerActionSilence,
	type CallerActionSpeak,
	type ConversationTurn,
	type RunScenarioOptions,
	type Scenario,
	type ScenarioContext,
	type ScenarioDecide,
	type ScenarioReport,
} from "./aiCaller";

export {
	startTwilioWsCaller,
	type TwilioInboundFrame,
	type TwilioWsCaller,
	type TwilioWsCallerOptions,
} from "./twilioWsCaller";

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
