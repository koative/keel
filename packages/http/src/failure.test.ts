import { afterEach, describe, expect, it } from "bun:test";
import { type DrainContext, initLogger } from "evlog";
import { errorSchema } from "./response";
import { appWithoutLogger, LEAKED_SECRET, testApp } from "./test-app";

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
