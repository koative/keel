import { afterEach, describe, expect, it, spyOn } from "bun:test";
import type { MailMessage } from "./message";
import { type MailConfig, sendMail } from "./send";

const API_KEY = "re_test_do_not_leak";
const KEY = "01JJ0000000000000000000000";
const MISSING_KEY_MESSAGE = /apiKey/;
const REJECTION_MESSAGE = /403.*domain is not verified/;

const MESSAGE: MailMessage = {
	html: "<p>Confirm your address</p>",
	subject: "Confirm your email address",
	text: "Confirm your address: https://keel.test/verify?token=abc",
	to: "recipient@example.com",
};

const LOG_CONFIG: MailConfig = { driver: "log", from: "Keel <hi@keel.test>" };
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

/** Replaces `fetch` with one that records the call and returns `response`. */
function stubFetch(response: () => Response): Call[] {
	const calls: Call[] = [];

	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({ init, url });

		return Promise.resolve(response());
	}) as unknown as typeof fetch;

	return calls;
}

/** Collects everything the driver writes to stdout, keeping the test output clean. */
function captureStdout(): string[] {
	const written: string[] = [];

	spyOn(process.stdout, "write").mockImplementation(((chunk: string) => {
		written.push(String(chunk));

		return true;
	}) as typeof process.stdout.write);

	return written;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("sendMail, log driver", () => {
	it("writes the recipient, the subject and both bodies where they can be read", async () => {
		const written = captureStdout();

		await sendMail(LOG_CONFIG, MESSAGE, KEY);

		const output = written.join("");
		expect(output).toContain(MESSAGE.to);
		expect(output).toContain(MESSAGE.subject);
		expect(output).toContain(MESSAGE.text);
		expect(output).toContain(MESSAGE.html);
		expect(output).toContain(LOG_CONFIG.from);
	});

	it("marks the output as not sent, so a log reader cannot mistake it for delivery", async () => {
		const written = captureStdout();

		await sendMail(LOG_CONFIG, MESSAGE, KEY);

		expect(written.join("")).toContain("NOT SENT");
	});

	it("performs no request", async () => {
		captureStdout();
		const calls = stubFetch(() => new Response("", { status: 200 }));

		await sendMail(LOG_CONFIG, MESSAGE, KEY);

		expect(calls).toHaveLength(0);
	});
});

describe("sendMail, resend driver", () => {
	it("posts the message to the Resend endpoint", async () => {
		const calls = stubFetch(() => new Response("{}", { status: 200 }));

		await sendMail(RESEND_CONFIG, MESSAGE, KEY);

		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.resend.com/emails");
		expect(calls[0]?.init.method).toBe("POST");
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({
			from: RESEND_CONFIG.from,
			html: MESSAGE.html,
			subject: MESSAGE.subject,
			text: MESSAGE.text,
			to: [MESSAGE.to],
		});
	});

	it("authenticates as a bearer token and sends JSON", async () => {
		const calls = stubFetch(() => new Response("{}", { status: 200 }));

		await sendMail(RESEND_CONFIG, MESSAGE, KEY);

		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`Bearer ${API_KEY}`);
		expect(headers["Content-Type"]).toBe("application/json");
	});

	it("passes the idempotency key as a header, so a retry cannot deliver twice", async () => {
		const calls = stubFetch(() => new Response("{}", { status: 200 }));

		await sendMail(RESEND_CONFIG, MESSAGE, KEY);

		const headers = calls[0]?.init.headers as Record<string, string>;
		expect(headers["Idempotency-Key"]).toBe(KEY);
	});

	it("throws with the status and the response body, which the worker records", async () => {
		stubFetch(
			() =>
				new Response('{"message":"The keel.test domain is not verified"}', {
					status: 403,
				})
		);

		await expect(sendMail(RESEND_CONFIG, MESSAGE, KEY)).rejects.toThrow(
			REJECTION_MESSAGE
		);
	});

	it("does not put the API key in the error it throws", async () => {
		stubFetch(() => new Response("nope", { status: 401 }));

		const error = await sendMail(RESEND_CONFIG, MESSAGE, KEY).catch(
			(thrown: Error) => thrown
		);

		expect(String(error)).not.toContain(API_KEY);
	});

	it("refuses to run without an API key rather than degrading to stdout", async () => {
		const calls = stubFetch(() => new Response("{}", { status: 200 }));

		await expect(
			sendMail({ driver: "resend", from: RESEND_CONFIG.from }, MESSAGE, KEY)
		).rejects.toThrow(MISSING_KEY_MESSAGE);
		expect(calls).toHaveLength(0);
	});
});
