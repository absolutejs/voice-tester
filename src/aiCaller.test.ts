import { describe, expect, mock, test } from "bun:test";
import type { Transport } from "./transport";

let finishes = 0;
mock.module("./deepgramStt", () => ({
	openDeepgramStt: () => ({
		on: () => {},
		send: () => {},
		finish: async () => {
			finishes += 1;
		},
	}),
}));
mock.module("./auraTTS", () => ({ auraSpeak: async () => new Int16Array(0) }));
const { runScenario } = await import("./aiCaller");
const createTransport = (ready = Promise.resolve()) => {
	const closed = Promise.withResolvers<void>();
	let unsubscribed = false;
	let speaks = 0;
	const transport: Transport = {
		id: "lifecycle-test",
		sampleRateHz: 16000,
		ready,
		closed: closed.promise,
		close: async () => {
			closed.resolve();
		},
		onFrame: () => () => {
			unsubscribed = true;
		},
		speakPcm: async () => {
			speaks += 1;
		},
		silence: async () => {},
	};
	return {
		transport,
		closed,
		unsubscribed: () => unsubscribed,
		speaks: () => speaks,
	};
};
const options = {
	stt: { apiKey: "test" },
	tts: { apiKey: "test" },
	log: () => {},
};
describe("transport closure", () => {
	test.each(["before ready", "while waiting"])(
		"ends promptly %s and releases listeners",
		async (phase) => {
			const fixture = createTransport(
				phase === "before ready"
					? new Promise<void>(() => {})
					: Promise.resolve(),
			);
			let decisions = 0;
			const before = finishes;
			const pending = runScenario({
				...options,
				transport: fixture.transport,
				scenario: {
					id: "close",
					maxDurationMs: 60000,
					responseStartTimeoutMs: 45000,
					decide: () => {
						decisions += 1;
						return { type: "hangup" };
					},
				},
			});
			fixture.closed.resolve();
			const report = await pending;
			expect(report.endedReason).toBe("transport_closed");
			expect(report.error).toBeUndefined();
			expect(report.durationMs).toBeLessThan(500);
			expect(decisions).toBe(0);
			expect(fixture.unsubscribed()).toBe(true);
			expect(finishes).toBe(before + 1);
		},
	);
	test("closure interrupts a pending decision and never sends its eventual reply", async () => {
		const fixture = createTransport();
		const deciding = Promise.withResolvers<void>();
		const decision = Promise.withResolvers<{ type: "speak"; text: string }>();
		const pending = runScenario({
			...options,
			transport: fixture.transport,
			scenario: {
				id: "decision",
				maxDurationMs: 60000,
				idleMs: 0,
				responseStartTimeoutMs: 0,
				decide: () => {
					deciding.resolve();
					return decision.promise;
				},
			},
		});
		await deciding.promise;
		fixture.closed.resolve();
		const report = await pending;
		decision.resolve({ type: "speak", text: "Too late" });
		await Promise.resolve();
		expect(report.endedReason).toBe("transport_closed");
		expect(fixture.speaks()).toBe(0);
		expect(fixture.unsubscribed()).toBe(true);
	});
	test("cleanup closure does not replace a normal scenario hangup", async () => {
		const fixture = createTransport();
		const report = await runScenario({
			...options,
			transport: fixture.transport,
			scenario: {
				id: "hangup",
				maxDurationMs: 1000,
				idleMs: 0,
				responseStartTimeoutMs: 0,
				decide: () => ({ type: "hangup" }),
			},
		});
		expect(report.endedReason).toBe("scenario_hangup");
		expect(fixture.unsubscribed()).toBe(true);
	});
});
