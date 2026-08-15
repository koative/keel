import { describe, expect, it } from "bun:test";
import { env } from "@keel/env/server";
import { app } from "@/app";
import { createClient, type ErrorEnvelope } from "../../test-http";

/**
 * Both halves are driven through the real `app`, not a throwaway Hono, because
 * both are facts about where the middleware sits. `requestBodyLimit` is mounted
 * with `app.use("*", …)` above every route and above `requireUser`; the reference
 * page's policy only holds because `/reference` is registered above
 * `app.use("*", apiSecurityHeaders)`. A local app would assert the middleware
 * and prove nothing about the wiring, which is the part that can regress.
 *
 * No `testDbReady()` gate: neither path reaches Postgres. The oversized request
 * is rejected before any guard runs, and a cookie-less session lookup returns
 * null without a query.
 */
describe("requestBodyLimit", () => {
	// Bun does not set content-length on a Request built from a string body, so
	// hono's bodyLimit takes its streaming branch and counts bytes. That is the
	// branch a real client over a socket also hits when it uses chunked
	// encoding, and it is why this needs a genuinely oversized body rather than
	// a spoofed header.
	const oversized = "x".repeat(env.BODY_LIMIT_BYTES);

	// The client carries no cookie, so this is also the ordering assertion: a 401
	// would mean `requireUser` ran first and an unauthenticated caller could still
	// make the server buffer the whole body before anything refused it.
	it("answers an oversized write with 413 in the standard envelope", async () => {
		const client = createClient();

		const response = await client.post("/v1/projects", {
			name: oversized,
			slug: "billing",
		});
		const body = await client.body<ErrorEnvelope>(response);

		expect(response.status).toBe(413);
		expect(response.headers.get("content-type")).toContain(
			"application/problem+json"
		);
		expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
		expect(body.error.why).toContain(String(env.BODY_LIMIT_BYTES));
		expect(body.error.requestId).toBeString();
	});

	// The complement: the limiter is not simply refusing every write. An
	// ordinary body reaches the guard and gets the guard's answer.
	it("lets a body under the limit through to the route", async () => {
		const client = createClient();

		const response = await client.post("/v1/projects", {
			name: "Billing",
			slug: "billing",
		});

		expect(response.status).toBe(401);
	});
});

/**
 * `/reference` is the one HTML page this API serves, and Scalar renders it
 * client-side from jsDelivr. Under the API's own `default-src 'none'` it loads
 * a blank page — a failure nothing else here would catch, because the response
 * is still a 200 with a correct-looking body.
 */
describe("referenceSecurityHeaders", () => {
	it("serves the reference page the exact policy Scalar needs", async () => {
		const response = await app.request("/reference");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(
			"connect-src 'self'; default-src 'none'; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' https://cdn.jsdelivr.net data:; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'"
		);
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("strict-transport-security")).toBe(
			"max-age=31536000; includeSubDomains"
		);
	});

	// The allowance is written out per route rather than loosened globally, and
	// this is the assertion that keeps it that way: exactly one path may name
	// the CDN.
	it("does not leak the CDN allowance onto the JSON surface", async () => {
		const response = await app.request("/");

		expect(response.headers.get("content-security-policy")).not.toContain(
			"cdn.jsdelivr.net"
		);
	});
});
