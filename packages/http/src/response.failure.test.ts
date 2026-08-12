import { afterEach, describe, expect, it } from "bun:test";
import { type DrainContext, initLogger } from "evlog";
import { errorSchema } from "./envelope";
import { appWithoutLogger, LEAKED_SECRET, testApp } from "./response.fixtures";

describe("unexpected failures", () => {
	it("never forwards the thrown message", async () => {
		const response = await testApp.request("/crash");
		const raw = await response.text();

		expect(response.status).toBe(500);
		expect(raw).not.toContain(LEAKED_SECRET);
		expect(raw).not.toContain("ECONNREFUSED");
		expect(errorSchema.parse(JSON.parse(raw)).error).toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Something went wrong",
		});
	});
});

// 413 is thrown by `requestBodyLimit` in apps/server, and `failure` maps a
// thrown status to a response through one table. A status missing from that
// table is not a passthrough — it is silently rewritten to 500 and its message
// replaced, which is a worse answer than the 400 this replaced.
describe("a status the app throws", () => {
	it("renders 413 as itself rather than masking it as a 500", async () => {
		const response = await testApp.request("/oversized");
		const body = errorSchema.parse(await response.json());

		expect(response.status).toBe(413);
		expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
		expect(body.status).toBe(413);
		expect(body.title).toBe("Payload too large");
		expect(body.type).toBe("https://keel.dev/errors/payload-too-large");
		expect(body.error.why).toContain("1024");
	});
});

// evlog folds everything about a request into one event, so severity is decided
// once, in `failure`, and cannot be downgraded afterwards.
describe("wide event severity", () => {
	const events: DrainContext[] = [];

	const collect = () => {
		events.length = 0;
		initLogger({
			drain: (context) => {
				events.push(context);
			},
			silent: true,
		});
	};

	afterEach(() => {
		initLogger({ drain: () => Promise.resolve(), silent: true });
	});

	it("emits exactly one event per request, not one per log call", async () => {
		collect();
		await testApp.request("/crash");

		expect(events).toHaveLength(1);
	});

	it("records a client mistake at warn, not error", async () => {
		collect();
		await testApp.request("/thrown-not-found");

		expect(events[0]?.event.level).toBe("warn");
		expect(events[0]?.event.errorCode).toBe("NOT_FOUND");
	});

	it("records a server failure at error, with the stack the client never sees", async () => {
		collect();
		await testApp.request("/crash");

		expect(events[0]?.event.level).toBe("error");
		expect(JSON.stringify(events[0]?.event.error)).toContain(LEAKED_SECRET);
	});
});

// `failure` is the app's last line of defence. If it throws, Hono has nothing
// left to render and the caller gets a bare 500 with no correlation id.
describe("failure without evlog installed", () => {
	it("renders a 500 rather than throwing out of the error handler", async () => {
		const response = await appWithoutLogger.request("/crash");
		const body = errorSchema.parse(await response.json());

		expect(response.status).toBe(500);
		expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
		expect(body.error.requestId).toBe("unknown");
	});

	it("keeps a 4xx a 4xx", async () => {
		const response = await appWithoutLogger.request("/thrown-not-found");

		expect(response.status).toBe(404);
		expect(errorSchema.parse(await response.json()).error.code).toBe(
			"NOT_FOUND"
		);
	});
});
