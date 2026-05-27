// Twilio outbound transport — originates a REAL phone call from a user-owned
// Twilio number to a target number, then runs the scenario engine over the
// real PSTN connection. Use this for true end-to-end testing of phone-side
// voice agents (vs the `twilioWs` mode which just speaks Twilio's WS protocol
// directly without the actual carrier in the loop).
//
// Setup the user needs:
//   1. A Twilio account (TWILIO_ACCOUNT_SID + TWILIO_AUTH_TOKEN env vars)
//   2. A Twilio-owned phone number to call FROM (any voice-capable number on
//      their account — buy one in the console for ~$1/mo if they don't have
//      one). Pass via --from.
//   3. The number to call TO (--to). This is the bot you want to test.
//   4. A publicly-reachable HTTPS URL Twilio can hit for the TwiML callback
//      (--public-url, e.g. https://abc.ngrok.io or an AbsoluteJS tunnel URL).
//      The transport hosts a local server on --port (default 3344) and the
//      public URL must proxy to it.
//
// Architecture:
//   voice-tester (local) ──── POST /Calls ────▶ Twilio
//                                                 │
//                                                 ▼ dials --to
//                                              Target answers
//                                                 │
//                          GET /twiml ◀─────── Twilio
//                          (returns <Stream>)
//                                                 │
//                                                 ▼
//                          /stream WS ◀───── Twilio (real audio both ways)
//
// Cost: ~$0.014/min outbound US-to-US per Twilio. Pennies per test call.

import { randomUUID } from "node:crypto";
import {
	decodeMulawBase64,
	encodeMulawBase64,
	frame20ms8k,
} from "../mulaw";
import type { InboundAudioFrame, Transport } from "../transport";

export type TwilioOutboundTransportOptions = {
	/** Twilio Account SID (starts with `AC...`). Env: `TWILIO_ACCOUNT_SID`. */
	accountSid: string;
	/** Twilio Auth Token. Env: `TWILIO_AUTH_TOKEN`. */
	authToken: string;
	/** E.164 number to call FROM — must be a voice-capable number on your Twilio account. */
	from: string;
	/** E.164 number to call TO — the bot you want to test. */
	to: string;
	/**
	 * Public HTTPS URL Twilio can reach to fetch TwiML + open the Media
	 * Stream. The transport hosts a local server; this URL must proxy to it.
	 * Examples: `https://abc.ngrok.io`, `https://your-app.fly.dev`,
	 * `https://<tunnel-id>.absolutejs.io` (AbsoluteJS built-in tunnel).
	 * No trailing slash.
	 */
	publicUrl: string;
	/** Local port to bind the TwiML + WS server. Default 3344. */
	port?: number;
	/** Twilio REST API base URL (override only for testing). */
	apiBaseUrl?: string;
	/** Optional: enable Twilio call recording (separate from voice-tester's STT). */
	recordCall?: boolean;
};

const FRAME_INTERVAL_MS = 20;
const SAMPLES_PER_FRAME = 160;

const escapeXml = (value: string): string =>
	value
		.replaceAll("&", "&amp;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;");

/**
 * Bring up the local TwiML+WS server, POST to Twilio to originate the
 * outbound call, and resolve a Transport once Twilio opens the Media Stream
 * and sends its `start` event. The transport's `ready` promise covers that
 * full handshake.
 */
export const twilioOutboundTransport = async (
	options: TwilioOutboundTransportOptions,
): Promise<Transport> => {
	const port = options.port ?? 3344;
	const apiBaseUrl = options.apiBaseUrl ?? "https://api.twilio.com";
	const inboundHandlers = new Set<(frame: InboundAudioFrame) => void>();
	const emit = (frame: InboundAudioFrame) => {
		for (const handler of inboundHandlers) handler(frame);
	};

	// Per-call streamSid + callSid arrive in Twilio's start event — we wait
	// for those before resolving ready. The TwiML response itself doesn't
	// need to know them.
	let streamSid: string | null = null;
	let callSid: string | null = null;
	let sequence = 1;
	let activeWs: WebSocket | null = null;
	let closed = false;

	let resolveReady: () => void = () => {};
	let rejectReady: (err: Error) => void = () => {};
	const ready = new Promise<void>((res, rej) => {
		resolveReady = res;
		rejectReady = rej;
	});

	// Build the TwiML response — a <Stream> verb pointing at our WS endpoint
	// + a long <Pause> so the call stays connected for the duration of the
	// scenario. Twilio's <Stream> is one-way by default; we set track="both"
	// (or "inbound_track" — adjust if outbound interferes with our send).
	const wsUrl = options.publicUrl
		.replace(/^http:/, "ws:")
		.replace(/^https:/, "wss:")
		.replace(/\/+$/, "");
	const buildTwiml = (): string =>
		`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Connect>
    <Stream url="${escapeXml(`${wsUrl}/stream`)}" />
  </Connect>
</Response>`;

	// Hosts the TwiML route + the Media Stream WebSocket. Bun.serve gives us
	// both in one server. The /twiml endpoint MUST be reachable from
	// Twilio's IPs via the public URL the user passed.
	type WsData = { kind: "twilio-stream" };
	const server = Bun.serve<WsData>({
		fetch: async (req, srv) => {
			const url = new URL(req.url);
			if (url.pathname === "/twiml" && req.method === "POST") {
				return new Response(buildTwiml(), {
					headers: { "Content-Type": "text/xml" },
				});
			}
			if (url.pathname === "/twiml" && req.method === "GET") {
				// Some setups (Twilio defaults) GET the TwiML URL — accept both.
				return new Response(buildTwiml(), {
					headers: { "Content-Type": "text/xml" },
				});
			}
			if (url.pathname === "/stream") {
				const upgraded = srv.upgrade(req, {
					data: { kind: "twilio-stream" } satisfies WsData,
				});
				if (!upgraded) {
					return new Response("WS upgrade failed", { status: 400 });
				}

				return undefined;
			}
			if (url.pathname === "/healthz") {
				return new Response("ok");
			}

			return new Response("not found", { status: 404 });
		},
		port,
		websocket: {
			close: () => {
				if (activeWs && !closed) {
					closed = true;
					try {
						activeWs.close();
					} catch {}
				}
			},
			message: (ws, raw) => {
				if (typeof raw !== "string") return;
				try {
					const payload = JSON.parse(raw) as {
						event?: string;
						start?: {
							streamSid?: string;
							callSid?: string;
						};
						media?: { payload?: string };
						mark?: { name?: string };
					};
					const receivedAt = Date.now();
					switch (payload.event) {
						case "connected":
							// Protocol-level handshake — nothing to do.
							break;
						case "start":
							streamSid = payload.start?.streamSid ?? null;
							callSid = payload.start?.callSid ?? null;
							activeWs = ws as unknown as WebSocket;
							resolveReady();
							break;
						case "media":
							if (payload.media?.payload) {
								emit({
									pcm: decodeMulawBase64(payload.media.payload),
									receivedAt,
									type: "media",
								});
							}
							break;
						case "mark":
							emit({
								name: payload.mark?.name ?? "",
								receivedAt,
								type: "mark",
							});
							break;
						case "stop":
							// Carrier hung up.
							closed = true;
							try {
								ws.close();
							} catch {}
							break;
					}
				} catch {
					emit({ raw, type: "raw" });
				}
			},
			open: (ws) => {
				// First message back to Twilio is implicit — Twilio doesn't expect
				// a server-side handshake. We just wait for `start`.
				activeWs = ws as unknown as WebSocket;
			},
		},
	});

	const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

	const sendMediaFrame = (frame: Int16Array): void => {
		if (!activeWs || !streamSid) return;
		try {
			(activeWs as unknown as { send: (s: string) => void }).send(
				JSON.stringify({
					event: "media",
					media: {
						payload: encodeMulawBase64(frame),
						track: "outbound",
					},
					sequenceNumber: String(sequence),
					streamSid,
				}),
			);
			sequence += 1;
		} catch {
			// Best-effort during teardown.
		}
	};

	const sendFramesPaced = async (frames: Int16Array[]) => {
		const startedAt = performance.now();
		for (let i = 0; i < frames.length; i += 1) {
			const target = startedAt + (i + 1) * FRAME_INTERVAL_MS;
			sendMediaFrame(frames[i]!);
			const drift = target - performance.now();
			if (drift > 0) await wait(drift);
		}
	};

	// Originate the call via Twilio REST. We do this AFTER the local server
	// is up so Twilio's TwiML fetch is guaranteed to find us. Throws if the
	// REST call fails (bad creds, unverified number, etc.) — the caller
	// should see a clear error.
	const auth = Buffer.from(
		`${options.accountSid}:${options.authToken}`,
	).toString("base64");
	const form = new URLSearchParams({
		From: options.from,
		To: options.to,
		Url: `${options.publicUrl.replace(/\/+$/, "")}/twiml`,
		...(options.recordCall ? { Record: "true" } : {}),
	});
	const callRes = await fetch(
		`${apiBaseUrl}/2010-04-01/Accounts/${options.accountSid}/Calls.json`,
		{
			body: form,
			headers: {
				Authorization: `Basic ${auth}`,
				"Content-Type": "application/x-www-form-urlencoded",
			},
			method: "POST",
		},
	);
	if (!callRes.ok) {
		const body = await callRes.text().catch(() => "");
		server.stop(true);
		throw new Error(
			`Twilio Calls.json ${callRes.status}: ${body.slice(0, 500)}`,
		);
	}
	const callJson = (await callRes.json()) as { sid?: string; status?: string };
	const initiatedSid = callJson.sid;

	// Watchdog: if Twilio never connects within 60s, reject ready. Probably
	// means the publicUrl isn't reachable, or the number didn't answer.
	const watchdog = setTimeout(() => {
		rejectReady(
			new Error(
				`Twilio never opened the Media Stream within 60s (call sid ${initiatedSid ?? "unknown"}). Check that publicUrl ${options.publicUrl} proxies to localhost:${port}, and that the call was answered.`,
			),
		);
	}, 60_000);
	ready.then(
		() => clearTimeout(watchdog),
		() => clearTimeout(watchdog),
	);

	return {
		close: async () => {
			closed = true;
			// Hang up the call via Twilio REST so it doesn't run on after we
			// stop the server.
			if (initiatedSid) {
				try {
					await fetch(
						`${apiBaseUrl}/2010-04-01/Accounts/${options.accountSid}/Calls/${initiatedSid}.json`,
						{
							body: new URLSearchParams({ Status: "completed" }),
							headers: {
								Authorization: `Basic ${auth}`,
								"Content-Type":
									"application/x-www-form-urlencoded",
							},
							method: "POST",
						},
					);
				} catch {
					// best-effort
				}
			}
			try {
				if (activeWs) activeWs.close();
			} catch {}
			server.stop(true);
		},
		id: streamSid ?? `pending:${randomUUID()}`,
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
