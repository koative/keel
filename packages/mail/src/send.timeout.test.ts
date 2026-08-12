import { afterEach, describe, expect, it } from "bun:test";
import type { MailMessage } from "./message";
import { type MailConfig, RESEND_TIMEOUT_MS, sendMail } from "./send";

const API_KEY = "re_test_do_not_leak";
const KEY = "01JJ0000000000000000000000";

/**
 * Far below the shipped budget, so a stall that is correctly aborted costs the
 * suite 20ms and a stall that is not costs it bun:test's 5s per-test timeout —
 * a red test either way, never a hung run.
 */
const TEST_TIMEOUT_MS = 20;
const TIMEOUT_MESSAGE = /Resend did not answer within 20ms/;
const CONNECT_MESSAGE = /Unable to connect/;

/**
 * Duplicated on purpose from `apps/server/src/worker.ts:117`. A package may not
 * import from `apps/`, and the coupling is worth pinning anyway: the budget has
 * to stay under the worker's drain deadline, or one hung send is enough on its
 * own to turn a graceful shutdown into `process.exit(1)`.
 */
const WORKER_SHUTDOWN_DEADLINE_MS = 10_000;

const MESSAGE: MailMessage = {
	html: "<p>Confirm your address</p>",
	subject: "Confirm your email address",
	text: "Confirm your address: https://keel.test/verify?token=abc",
	to: "recipient@example.com",
};

const RESEND_CONFIG: MailConfig = {
	apiKey: API_KEY,
	driver: "resend",
	from: "Keel <hi@keel.test>",
};

const originalFetch = globalThis.fetch;

interface Call {
	init: RequestInit;
	url: string;
}

/** Answers immediately, so the assertion is about what was passed, not timing. */
function stubFetch(response: () => Response): Call[] {
	const calls: Call[] = [];

	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({ init, url });

		return Promise.resolve(response());
	}) as unknown as typeof fetch;

	return calls;
}

/** A provider that accepted the connection and then said nothing at all. */
function stubSilentFetch(): Call[] {
	const calls: Call[] = [];

	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({ init, url });

		const { promise, reject } = Promise.withResolvers<Response>();
		init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
			once: true,
		});

		return promise;
	}) as unknown as typeof fetch;

	return calls;
}

/**
 * Headers arrive, the body never ends. Erroring the stream on abort is not
 * invention: a real Bun fetch does exactly this, measured against a live
 * `Bun.serve` that held a body stream open — `response.text()` rejected with the
 * signal's `TimeoutError` on the fetch's own budget.
 */
function stubStalledBodyFetch(status: number): Call[] {
	const calls: Call[] = [];

	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({ init, url });

		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"message":"partial'));
				init.signal?.addEventListener(
					"abort",
					() => controller.error(init.signal?.reason),
					{ once: true }
				);
			},
		});

		return Promise.resolve(new Response(body, { status }));
	}) as unknown as typeof fetch;

	return calls;
}

/** A socket that failed outright, which is not a timeout and must not read as one. */
function stubFailingFetch(error: Error): Call[] {
	const calls: Call[] = [];

	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({ init, url });

		return Promise.reject(error);
	}) as unknown as typeof fetch;

	return calls;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

/**
 * The budget, split from the lifecycle suite because that file is at 161 of the
 * 200 permitted lines and these cases need three stubs of their own.
 *
 * What is being defended: the worker runs a claimed batch one job at a time, so
 * an unbounded send does not delay one message — it stops every kind of work in
 * the process until the network gives up.
 */
describe("sendMail, resend request budget", () => {
	it("bounds the request with an abort signal", async () => {
		const calls = stubFetch(() => new Response("{}", { status: 200 }));

		await sendMail(RESEND_CONFIG, MESSAGE, KEY);

		expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
		expect(calls[0]?.init.signal?.aborted).toBe(false);
	});

	it("aborts a request the provider never answers", async () => {
		stubSilentFetch();

		await expect(
			sendMail({ ...RESEND_CONFIG, timeoutMs: TEST_TIMEOUT_MS }, MESSAGE, KEY)
		).rejects.toThrow(TIMEOUT_MESSAGE);
	});

	it("aborts a response whose headers arrived and whose body never ends", async () => {
		stubStalledBodyFetch(403);

		await expect(
			sendMail({ ...RESEND_CONFIG, timeoutMs: TEST_TIMEOUT_MS }, MESSAGE, KEY)
		).rejects.toThrow(TIMEOUT_MESSAGE);
	});

	it("leaves a failure that is not a timeout carrying its own message", async () => {
		stubFailingFetch(new TypeError("Unable to connect"));

		await expect(
			sendMail({ ...RESEND_CONFIG, timeoutMs: TEST_TIMEOUT_MS }, MESSAGE, KEY)
		).rejects.toThrow(CONNECT_MESSAGE);
	});

	it("does not put the API key in the timeout error", async () => {
		stubSilentFetch();

		const error = await sendMail(
			{ ...RESEND_CONFIG, timeoutMs: TEST_TIMEOUT_MS },
			MESSAGE,
			KEY
		).catch((thrown: Error) => thrown);

		expect(String(error)).not.toContain(API_KEY);
	});

	it("ships a budget the worker can still drain inside", () => {
		expect(RESEND_TIMEOUT_MS).toBeLessThan(WORKER_SHUTDOWN_DEADLINE_MS);
	});
});
