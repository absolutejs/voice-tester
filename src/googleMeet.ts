import { auraSpeak, type AuraTTSOptions } from "./auraTTS";

type AnyBrowser = {
	newContext: (options?: Record<string, unknown>) => Promise<AnyContext>;
	close: () => Promise<void>;
};

type AnyContext = {
	newPage: () => Promise<AnyPage>;
	addInitScript: (script: string) => Promise<unknown>;
	close: () => Promise<void>;
};

type AnyLocator = {
	click: (options?: Record<string, unknown>) => Promise<unknown>;
	fill: (value: string, options?: Record<string, unknown>) => Promise<unknown>;
	first: () => AnyLocator;
};

type AnyPage = {
	goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
	url: () => string;
	getByRole: (
		role: string,
		options: { name: RegExp | string },
	) => AnyLocator;
	getByPlaceholder: (placeholder: RegExp | string) => AnyLocator;
	getByLabel: (label: RegExp | string) => AnyLocator;
	waitForTimeout: (ms: number) => Promise<unknown>;
	waitForURL: (
		matcher: RegExp | string,
		options?: Record<string, unknown>,
	) => Promise<unknown>;
	evaluate: (script: string) => Promise<unknown>;
};

export type StartGoogleMeetOptions = {
	/**
	 * Existing Meet URL to open. Omit to create a fresh meeting through
	 * https://meet.google.com/new (which needs a signed-in `storageState`).
	 */
	url?: string;
	/**
	 * Reuse a signed-in Playwright storage state when the account must be
	 * authenticated before creating or joining meetings. Without one the tester
	 * joins as a guest and someone in the call has to admit it.
	 */
	storageState?: string | Record<string, unknown>;
	/**
	 * A Chrome profile directory to keep between runs. Sign the tester's Google
	 * account in there once (Meet turns away guests in automated browsers) and
	 * every later run joins signed in.
	 */
	userDataDir?: string;
	/** Playwright's `chromium`, when `playwright` isn't importable from here. */
	chromium?: unknown;
	browser?: AnyBrowser;
	headless?: boolean;
	channel?: string;
	/** The name shown in the call (guests only; signed-in accounts use theirs). */
	displayName?: string;
	join?: boolean;
	camera?: boolean;
	/**
	 * Join with a microphone the tester controls: `say()` speaks into the call
	 * through it. Default true.
	 */
	microphone?: boolean;
	/** Deepgram Aura voice for `say()`. Needs `apiKey`. */
	tts?: AuraTTSOptions;
	/** Deepgram key for `hear()` transcripts (defaults to `tts.apiKey`). */
	sttApiKey?: string;
	timeoutMs?: number;
};

/** A stretch of audio from the other people in the call. */
export type HeardSpeech = {
	/** Epoch ms when the audio started and stopped. */
	startedAt: number;
	endedAt: number;
	/** What was said, when a Deepgram key is available. */
	text: string;
};

export type GoogleMeetSession = {
	browser: AnyBrowser;
	context: AnyContext;
	page: AnyPage;
	url: string;
	/** Whether the tester is in the call (false while waiting to be admitted). */
	inCall: () => Promise<boolean>;
	/** Resolves once the tester is in the call, e.g. after the host admits it. */
	waitUntilInCall: (timeoutMs?: number) => Promise<void>;
	/**
	 * As host, lets in everyone waiting (or only names matching `who`), waiting
	 * up to `timeoutMs` for someone to knock. Returns who was admitted.
	 */
	admit: (options?: { who?: RegExp; timeoutMs?: number }) => Promise<string[]>;
	/**
	 * Speaks `text` into the call with Aura and resolves when it has finished
	 * playing. Returns when playback started and ended (epoch ms).
	 */
	say: (text: string) => Promise<{ startedAt: number; endedAt: number }>;
	/**
	 * Waits for someone else in the call to speak after `after` (epoch ms,
	 * default now), until they've been quiet for `quietMs`, and transcribes it.
	 * Sentence gaps shorter than `quietMs` count as one reply.
	 */
	hear: (options?: {
		after?: number;
		timeoutMs?: number;
		quietMs?: number;
	}) => Promise<HeardSpeech>;
	close: () => Promise<void>;
};

// Chrome runs with fake media devices; this swaps the fake microphone for an
// audio graph the tester plays speech into, and taps every incoming WebRTC
// audio track so it can tell when others talk and keep what they said
// (16 kHz, the last three minutes).
const MEDIA_SCRIPT = `(() => {
  if (window.__voiceTester) return;
  const S = (window.__voiceTester = { segments: [], chunks: [] });
  let ctx = null;
  const audio = () => {
    if (!ctx) {
      ctx = new AudioContext({ sampleRate: 48000 });
      S.mic = ctx.createMediaStreamDestination();
      S.remote = ctx.createGain();
      const tap = ctx.createScriptProcessor(4096, 1, 1);
      const mute = ctx.createGain();
      mute.gain.value = 0;
      S.remote.connect(tap);
      tap.connect(mute);
      mute.connect(ctx.destination);
      let open = null, quietSince = 0;
      tap.onaudioprocess = (e) => {
        const input = e.inputBuffer.getChannelData(0);
        let sum = 0;
        const pcm = new Int16Array(Math.floor(input.length / 3));
        for (let i = 0; i < input.length; i++) sum += input[i] * input[i];
        for (let i = 0; i < pcm.length; i++)
          pcm[i] = Math.max(-1, Math.min(1, input[i * 3])) * 32767;
        const now = Date.now();
        const at = now - input.length / 48;
        S.chunks.push({ at, pcm });
        while (S.chunks.length && S.chunks[0].at < now - 180000) S.chunks.shift();
        const loud = Math.sqrt(sum / input.length) > 0.01;
        if (loud) {
          quietSince = 0;
          if (!open) { open = { start: at, end: null }; S.segments.push(open); }
        } else if (open) {
          if (!quietSince) quietSince = at;
          if (now - quietSince > 300) { open.end = quietSince; open = null; quietSince = 0; }
        }
      };
    }
    if (ctx.state === "suspended") ctx.resume();
    return ctx;
  };
  const getUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  navigator.mediaDevices.getUserMedia = async (constraints) => {
    if (!constraints || !constraints.audio) return getUserMedia(constraints);
    const stream = constraints.video
      ? await getUserMedia({ video: constraints.video })
      : new MediaStream();
    audio();
    for (const track of S.mic.stream.getAudioTracks()) stream.addTrack(track.clone());
    return stream;
  };
  const PC = window.RTCPeerConnection;
  function Tapped(...args) {
    const pc = new PC(...args);
    pc.addEventListener("track", (e) => {
      if (e.track.kind !== "audio") return;
      const stream = new MediaStream([e.track]);
      // Chrome only feeds remote WebRTC audio to Web Audio while an element plays it.
      const el = new Audio();
      el.muted = true;
      el.srcObject = stream;
      el.play().catch(() => {});
      audio().createMediaStreamSource(stream).connect(S.remote);
    });
    return pc;
  }
  Tapped.prototype = PC.prototype;
  Object.setPrototypeOf(Tapped, PC);
  window.RTCPeerConnection = Tapped;
  S.play = (b64, rate) => new Promise((resolve) => {
    const c = audio();
    const bytes = Uint8Array.from(atob(b64), (ch) => ch.charCodeAt(0));
    const pcm = new Int16Array(bytes.buffer, 0, bytes.byteLength >> 1);
    const buffer = c.createBuffer(1, pcm.length, rate);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768;
    const source = c.createBufferSource();
    source.buffer = buffer;
    source.connect(S.mic);
    const startedAt = Date.now();
    source.onended = () => resolve({ startedAt, endedAt: Date.now() });
    source.start();
  });
  S.pcmBetween = (from, to) => {
    const parts = S.chunks.filter((c) => c.at + c.pcm.length / 16 >= from && c.at <= to);
    const total = parts.reduce((n, c) => n + c.pcm.length, 0);
    const out = new Int16Array(total);
    let o = 0;
    for (const c of parts) { out.set(c.pcm, o); o += c.pcm.length; }
    let s = "";
    const u8 = new Uint8Array(out.buffer);
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  };
})();`;

// Chrome flags: fake devices (the script above replaces the microphone), no
// permission prompts, and audio that plays without a click.
export const googleMeetChromeArgs = [
	"--use-fake-ui-for-media-stream",
	"--use-fake-device-for-media-stream",
	"--autoplay-policy=no-user-gesture-required",
];

const dynamicImport = new Function("specifier", "return import(specifier)") as (
	specifier: string,
) => Promise<Record<string, unknown>>;

const clickIfPresent = async (
	page: AnyPage,
	role: string,
	name: RegExp,
	timeoutMs = 1500,
) => {
	try {
		await page.getByRole(role, { name }).first().click({ timeout: timeoutMs });
		return true;
	} catch {
		return false;
	}
};

const fillIfPresent = async (
	page: AnyPage,
	label: RegExp,
	value: string,
	timeoutMs = 1500,
) => {
	for (const locator of [page.getByLabel(label), page.getByPlaceholder(label)])
		try {
			await locator.first().fill(value, { timeout: timeoutMs });
			return true;
		} catch {}
	return false;
};

type AnyChromium = {
	launch: (options: Record<string, unknown>) => Promise<AnyBrowser>;
	launchPersistentContext: (
		dir: string,
		options: Record<string, unknown>,
	) => Promise<AnyContext>;
};

const chromiumFor = async (options: StartGoogleMeetOptions) =>
	(options.chromium ??
		(await dynamicImport("playwright")).chromium) as AnyChromium;

const launchOptions = (options: StartGoogleMeetOptions) => ({
	...(options.channel ? { channel: options.channel } : {}),
	headless: options.headless ?? false,
	args: googleMeetChromeArgs,
});

// A browser and a context with the tester's media script and permissions:
// a kept profile when `userDataDir` is set, otherwise a fresh context.
const openContext = async (
	options: StartGoogleMeetOptions,
	permissions: string[],
): Promise<{ browser: AnyBrowser | null; context: AnyContext }> => {
	if (options.userDataDir) {
		const context = await (
			await chromiumFor(options)
		).launchPersistentContext(options.userDataDir, {
			...launchOptions(options),
			// A kept profile reopens its last tabs, which can't be resized.
			viewport: null,
			permissions,
		});
		return { browser: null, context };
	}
	const browser =
		options.browser ??
		(await (await chromiumFor(options)).launch(launchOptions(options)));
	const context = await browser.newContext({
		...(options.storageState ? { storageState: options.storageState } : {}),
		permissions,
	});
	return { browser, context };
};

// What Meet shows a guest it won't let in.
const REFUSED = /you can.t join this video call/i;

const toBase64 = (pcm: Int16Array) =>
	Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength).toString("base64");

const transcribe = async (pcmBase64: string, apiKey: string) => {
	const response = await fetch(
		"https://api.deepgram.com/v1/listen?model=nova-3&encoding=linear16&sample_rate=16000&smart_format=true",
		{
			method: "POST",
			headers: {
				authorization: `Token ${apiKey}`,
				"content-type": "application/octet-stream",
			},
			body: Buffer.from(pcmBase64, "base64"),
		},
	);
	if (!response.ok)
		throw new Error(`Deepgram transcription failed (${response.status})`);
	const body = (await response.json()) as {
		results?: {
			channels?: { alternatives?: { transcript?: string }[] }[];
		};
	};
	return body.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
};

/**
 * Starts or joins Google Meet through Playwright without a human clicking
 * through the pre-join screen, with a microphone the tester speaks through
 * (`say`) and ears on everyone else (`hear`). This does not bypass Google
 * authentication, Workspace policy, CAPTCHA, or anti-abuse controls; pass
 * `storageState` for a signed-in tester account, or join as a guest and have
 * the host admit it.
 *
 * A browser you pass in must be launched with `googleMeetChromeArgs`.
 */
export const startGoogleMeet = async (
	options: StartGoogleMeetOptions = {},
): Promise<GoogleMeetSession> => {
	const microphone = options.microphone ?? true;
	const { browser, context } = await openContext(options, [
		...(microphone ? ["microphone"] : []),
		...(options.camera ? ["camera"] : []),
	]);
	await context.addInitScript(MEDIA_SCRIPT);
	const page = await context.newPage();
	const targetUrl = options.url ?? "https://meet.google.com/new";
	await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
	await page.waitForTimeout(2500);

	if (options.displayName) {
		await fillIfPresent(page, /your name/i, options.displayName, 5000);
	}

	if (!microphone) {
		await clickIfPresent(page, "button", /turn off microphone/i);
	}
	if (!options.camera) {
		// "Do you want people to see you in the meeting?"
		await clickIfPresent(page, "button", /continue without camera/i, 3000);
		await clickIfPresent(page, "button", /turn off camera/i);
	}

	if (options.join ?? true) {
		await clickIfPresent(
			page,
			"button",
			/join now|ask to join|start an instant meeting/i,
			options.timeoutMs ?? 10_000,
		);
	}

	await page.waitForTimeout(1000);

	// Meet reloads the page while joining; a check caught mid-reload is "not yet".
	const pageText = () =>
		(page.evaluate("document.body ? document.body.innerText : ''") as Promise<
			string
		>).catch(() => "");
	const inCall = () =>
		(
			page.evaluate(
				`!!document.querySelector('[aria-label*="leave call" i]')`,
			) as Promise<boolean>
		).catch(() => false);
	const refused = async () => REFUSED.test(await pageText());
	const refusal = () =>
		new Error(
			options.storageState || options.userDataDir
				? "Google Meet wouldn't let the tester in. Check the tester's account can join this meeting."
				: "Google Meet turned the tester away as a guest. Sign a Google account in with userDataDir (or pass storageState) and try again.",
		);
	if (await refused()) {
		await context.close();
		if (browser && !options.browser) await browser.close();
		throw refusal();
	}
	const sttKey = options.sttApiKey ?? options.tts?.apiKey;

	return {
		browser: browser ?? (context as unknown as AnyBrowser),
		close: async () => {
			await clickIfPresent(page, "button", /leave call/i, 1000);
			await context.close();
			if (browser && !options.browser) await browser.close();
		},
		context,
		page,
		url: page.url(),
		inCall,
		waitUntilInCall: async (timeoutMs = 120_000) => {
			const until = Date.now() + timeoutMs;
			while (!(await inCall())) {
				if (await refused()) throw refusal();
				if (Date.now() > until)
					throw new Error("Not admitted to the call in time");
				await page.waitForTimeout(500);
			}
		},
		admit: async ({ who, timeoutMs = 60_000 } = {}) => {
			const until = Date.now() + timeoutMs;
			const admitted: string[] = [];
			for (;;) {
				// Each waiting person has their own "Admit" button (labelled
				// "Admit <name>"); the "Admit N guest" chip only opens that list.
				const names = ((await page
					.evaluate(
						`[...document.querySelectorAll('button[aria-label^="Admit "]')].filter((b) => b.offsetParent && !/^Admit \\d+ /.test(b.getAttribute("aria-label"))).map((b) => b.getAttribute("aria-label").slice(6))`,
					)
					.catch(() => [])) ?? []) as string[];
				const wanted = names.filter((n) => !who || who.test(n));
				for (const name of wanted) {
					await page
						.getByRole("button", { name: `Admit ${name}` })
						.first()
						.click({ timeout: 3000 })
						.then(() => admitted.push(name))
						.catch(() => {});
				}
				if (admitted.length) return admitted;
				if (!names.length)
					await clickIfPresent(page, "button", /^admit \d+ (guest|person|people)/i, 500);
				if (Date.now() > until) return admitted;
				await page.waitForTimeout(1000);
			}
		},
		say: async (text) => {
			if (!microphone) throw new Error("Joined without a microphone");
			if (!options.tts)
				throw new Error("say() needs tts options with an apiKey");
			const pcm = await auraSpeak(text, options.tts, { sampleRateHz: 48000 });
			return page.evaluate(
				`window.__voiceTester.play(${JSON.stringify(toBase64(pcm))}, 48000)`,
			) as Promise<{ startedAt: number; endedAt: number }>;
		},
		hear: async ({
			after = Date.now(),
			timeoutMs = 60_000,
			quietMs = 1500,
		} = {}) => {
			const until = after + timeoutMs;
			for (;;) {
				const segments = ((await page
					.evaluate("window.__voiceTester ? window.__voiceTester.segments : []")
					.catch(() => [])) ?? []) as { start: number; end: number | null }[];
				const heard = segments.filter((s) => s.start >= after);
				const last = heard.at(-1);
				const now = Date.now();
				if (last?.end && now - last.end >= quietMs) {
					const startedAt = heard[0]!.start,
						endedAt = last.end;
					const text = sttKey
						? await transcribe(
								(await page.evaluate(
									`window.__voiceTester.pcmBetween(${startedAt - 200}, ${endedAt + 200})`,
								)) as string,
								sttKey,
							)
						: "";
					return { startedAt, endedAt, text };
				}
				if (now > until)
					throw new Error(
						heard.length
							? "Someone was still talking when time ran out"
							: "Nobody spoke in time",
					);
				await page.waitForTimeout(200);
			}
		},
	};
};
