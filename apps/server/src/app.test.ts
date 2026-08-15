import { afterEach, describe, expect, it } from "bun:test";
import { type DrainContext, initLogger } from "evlog";
import { app } from "./app";

const PREFLIGHT_HEADERS = {
	"Access-Control-Request-Headers": "content-type",
	"Access-Control-Request-Method": "DELETE",
	Origin: "http://localhost:3001",
};

// A body stream that rejects is what a client vanishing mid-upload looks like from
// inside the server. It surfaces while `requestBodyLimit` is counting the body,
// above every route, so nothing but `app.onError` can answer it. The thrown text
// reads like the connection string an unexpected failure really would carry, on
// the reserved host and obviously-fake password `LEAKED_SECRET` already uses.
const THROWN_DETAIL =
	"postgres://admin:change-me@db.example.invalid/prod is unreachable";

describe("app", () => {
	it("answers the container health probe", async () => {
		const response = await app.request("/");

		expect(response.status).toBe(200);
		expect(await response.text()).toBe("OK");
	});

	it("advertises every method a CRUD surface needs", async () => {
		const response = await app.request("/api/projects", {
			headers: PREFLIGHT_HEADERS,
			method: "OPTIONS",
		});

		expect(response.status).toBe(204);
		expect(
			response.headers.get("access-control-allow-methods")?.split(",")
		).toEqual(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
	});
});

// Which endpoints are published is an app-level fact, not a module's, so it lives
// here rather than in one module's contract test — otherwise adding a second
// public surface breaks an unrelated module's suite.
describe("published surface", () => {
	it("describes only the versioned endpoints", async () => {
		const document = (await (await app.request("/doc")).json()) as {
			paths: Record<string, Record<string, unknown>>;
		};

		const operations = Object.entries(document.paths).flatMap(
			([path, methods]) =>
				Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`)
		);

		// The internal API is a plain Hono, so it cannot register itself in the
		// OpenAPI registry. This asserts that structural fact rather than trusting it.
		expect(operations.sort()).toEqual([
			"GET /v1/projects",
			"GET /v1/projects/{id}",
			"POST /v1/projects",
		]);
	});
});

describe("terminal responses", () => {
	it("renders an unknown route as a Problem Details document", async () => {
		const response = await app.request("/nope", {
			headers: { "x-request-id": "trace-7" },
		});

		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain(
			"application/problem+json"
		);
		expect(await response.json()).toEqual({
			error: {
				code: "NOT_FOUND",
				fix: "Check the identifier and retry, or list the collection to discover valid ones",
				message: "Route not found",
				requestId: "trace-7",
				why: "No route matched the given identifier",
			},
			status: 404,
			title: "Not found",
			type: "https://keel.dev/errors/not-found",
		});
	});

	it("renders an unexpected failure without echoing what was thrown", async () => {
		const response = await app.request("/v1/projects", {
			body: new ReadableStream({
				start: (controller) => controller.error(new Error(THROWN_DETAIL)),
			}),
			duplex: "half",
			headers: {
				"content-type": "application/json",
				"x-request-id": "trace-9",
			},
			method: "POST",
		});

		expect(response.status).toBe(500);
		expect(response.headers.get("content-type")).toContain(
			"application/problem+json"
		);
		// Whole-document equality is the leak assertion: there is nowhere for the
		// thrown message to hide, and the client still gets an id to quote.
		expect(await response.json()).toEqual({
			error: {
				code: "INTERNAL_SERVER_ERROR",
				fix: "Retry the request, and quote the requestId if it keeps failing",
				message: "Something went wrong",
				requestId: "trace-9",
				why: "The server failed while handling this request",
			},
			status: 500,
			title: "Internal server error",
			type: "https://keel.dev/errors/internal-server-error",
		});
	});

	// Probes are excluded from the wide-event stream, so there is no id to quote and
	// advertising one would point at a log line that does not exist.
	it("answers both probes and leaves them out of correlation", async () => {
		const live = await app.request("/health");
		const ready = await app.request("/ready");

		expect(live.status).toBe(200);
		expect(await live.json()).toEqual({ data: { status: "live" } });
		expect(live.headers.get("x-request-id")).toBeNull();
		expect([200, 503]).toContain(ready.status);
	});

	// A JSON API should never load or execute anything from a response body.
	it("serves the strictest content policy on the API surface", async () => {
		const response = await app.request("/");

		expect(response.headers.get("content-security-policy")).toContain(
			"default-src 'none'"
		);
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("x-content-type-options")).toBe("nosniff");
	});

	it("echoes the correlation id on a successful response", async () => {
		const response = await app.request("/", {
			headers: { "x-request-id": "trace-8" },
		});

		expect(response.headers.get("x-request-id")).toBe("trace-8");
	});
});

// CORS is registered ahead of the logger and the Better Auth identifier. The
// only observable proof is that a preflight produces no wide event at all,
// because nothing downstream of CORS ever runs for it.
describe("middleware order", () => {
	afterEach(() => {
		initLogger({ drain: () => Promise.resolve(), silent: true });
	});

	it("short-circuits a preflight before anything downstream runs", async () => {
		const events: DrainContext[] = [];
		initLogger({
			drain: (context) => {
				events.push(context);
			},
			silent: true,
		});

		await app.request("/api/projects", {
			headers: PREFLIGHT_HEADERS,
			method: "OPTIONS",
		});
		expect(events).toHaveLength(0);

		await app.request("/");
		expect(events).toHaveLength(1);
		expect(events[0]?.event.path).toBe("/");
		expect(events[0]?.event.requestId).toBeString();
	});
});
