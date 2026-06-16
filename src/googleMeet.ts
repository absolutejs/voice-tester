type AnyBrowser = {
	newContext: (options?: Record<string, unknown>) => Promise<AnyContext>;
	close: () => Promise<void>;
};

type AnyContext = {
	newPage: () => Promise<AnyPage>;
	close: () => Promise<void>;
};

type AnyPage = {
	goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
	url: () => string;
	getByRole: (
		role: string,
		options: { name: RegExp | string },
	) => { click: (options?: Record<string, unknown>) => Promise<unknown> };
	getByPlaceholder: (
		placeholder: RegExp | string,
	) => { fill: (value: string, options?: Record<string, unknown>) => Promise<unknown> };
	waitForTimeout: (ms: number) => Promise<unknown>;
	waitForURL: (
		matcher: RegExp | string,
		options?: Record<string, unknown>,
	) => Promise<unknown>;
};

export type StartGoogleMeetOptions = {
	/**
	 * Existing Meet URL to open. Omit to create a fresh meeting through
	 * https://meet.google.com/new.
	 */
	url?: string;
	/**
	 * Reuse a signed-in Playwright storage state when the account must be
	 * authenticated before creating or joining meetings.
	 */
	storageState?: string | Record<string, unknown>;
	browser?: AnyBrowser;
	headless?: boolean;
	channel?: string;
	displayName?: string;
	join?: boolean;
	camera?: boolean;
	microphone?: boolean;
	timeoutMs?: number;
};

export type GoogleMeetSession = {
	browser: AnyBrowser;
	context: AnyContext;
	page: AnyPage;
	url: string;
	close: () => Promise<void>;
};

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
		await page.getByRole(role, { name }).click({ timeout: timeoutMs });
		return true;
	} catch {
		return false;
	}
};

const fillIfPresent = async (
	page: AnyPage,
	placeholder: RegExp,
	value: string,
	timeoutMs = 1500,
) => {
	try {
		await page.getByPlaceholder(placeholder).fill(value, { timeout: timeoutMs });
		return true;
	} catch {
		return false;
	}
};

const launchBrowser = async (options: StartGoogleMeetOptions) => {
	if (options.browser) return options.browser;
	const playwright = await dynamicImport("playwright");
	const chromium = playwright.chromium as {
		launch: (options: Record<string, unknown>) => Promise<AnyBrowser>;
	};
	return chromium.launch({
		...(options.channel ? { channel: options.channel } : {}),
		headless: options.headless ?? false,
	});
};

/**
 * Starts or joins Google Meet through Playwright without a human clicking
 * through the pre-join screen. This does not bypass Google authentication,
 * Workspace policy, CAPTCHA, or anti-abuse controls; pass `storageState` for a
 * signed-in tester account when the meeting requires one.
 */
export const startGoogleMeet = async (
	options: StartGoogleMeetOptions = {},
): Promise<GoogleMeetSession> => {
	const browser = await launchBrowser(options);
	const context = await browser.newContext({
		...(options.storageState ? { storageState: options.storageState } : {}),
		permissions: [
			...(options.microphone ? ["microphone"] : []),
			...(options.camera ? ["camera"] : []),
		],
	});
	const page = await context.newPage();
	const targetUrl = options.url ?? "https://meet.google.com/new";
	await page.goto(targetUrl, { waitUntil: "domcontentloaded" });

	if (options.displayName) {
		await fillIfPresent(page, /name/i, options.displayName);
	}

	if (!options.microphone) {
		await clickIfPresent(page, "button", /turn off microphone|microphone/i);
	}
	if (!options.camera) {
		await clickIfPresent(page, "button", /turn off camera|camera/i);
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
	return {
		browser,
		close: async () => {
			await context.close();
			if (!options.browser) await browser.close();
		},
		context,
		page,
		url: page.url(),
	};
};
