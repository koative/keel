import { describe, expect, it } from "bun:test";
import { failure, ok } from "@keel/http/response";
import { evlog } from "evlog/hono";
import { Hono } from "hono";
import type { AppEnv } from "@/lib/context";
import { rateLimit } from "@/lib/rate-limit";

/**
 * The limiter's one wiring fact, asserted the way `security.test.ts` asserts
 * where `requestBodyLimit` sits: what is under test is the order, not the
 * behaviour `rate-limit.test.ts` already covers.
 *
 * Its own file rather than a describe in that suite, because this one carries no
 * `testDbReady()` gate. The guard has to refuse before the repository is
 * reached, so it runs whether or not Postgres is up — the day it needs a
 * database is the day the guard runs too late.
 */
describe("rate limit middleware mounted above requireUser", () => {
	it("refuses the request instead of keying every caller on one bucket", async () => {
		let reached = false;
		const app = new Hono<AppEnv>();
		app.use(evlog());
		app.use(rateLimit);
		// Below the limiter, which is the mistake under test: `AppEnv` types
		// `actorId` as a plain string, so this order compiles and the bucket key
		// would be the text `undefined` — one bucket for the whole deployment.
		app.use(async (c, next) => {
			c.set("actorId", crypto.randomUUID());
			await next();
		});
		app.get("/things", (c) => {
			reached = true;
			return ok(c, { seen: true });
		});
		app.onError((error, c) => failure(c, error));

		const response = await app.request("/things");
		const body = (await response.json()) as { error: { code: string } };

		// A 500, not a 4xx: nothing the caller sent is wrong.
		expect(response.status).toBe(500);
		expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
		// No budget headers means no bucket was touched: it refused before
		// spending from the shared one, not after.
		expect(response.headers.get("RateLimit-Limit")).toBeNull();
		expect(reached).toBe(false);
	});
});
