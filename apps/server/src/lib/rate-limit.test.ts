import { describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { apiRateLimit } from "@keel/db/schema/rate-limit";
import { env } from "@keel/env/server";
import { failure, ok } from "@keel/http/response";
import { eq, sql } from "drizzle-orm";
import { evlog } from "evlog/hono";
import { Hono } from "hono";
import type { AppEnv } from "@/lib/context";
import { rateLimit } from "@/lib/rate-limit";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("rate limit"));
}

const READ_BUDGET = env.RATE_LIMIT_READ_PER_MINUTE;
const WRITE_BUDGET = env.RATE_LIMIT_WRITE_PER_MINUTE;

/**
 * Driven through a throwaway Hono app, like the idempotency suite: the middleware
 * is mounted by whoever needs it, so the thing under test is the middleware plus
 * `app.onError`, not the route table. The stub that sets `actorId` stands in for
 * `requireUser`, which is the only reason this can run without a session.
 *
 * `onError` is wired to the real `failure` on purpose — a 429 reaches the client
 * only through it, and whether the headers set before the throw survive that path
 * is exactly what these tests have to prove.
 */
function buildApp(actorId: string) {
	const app = new Hono<AppEnv>();
	app.use(evlog());
	app.use(async (c, next) => {
		c.set("actorId", actorId);
		await next();
	});
	app.use(rateLimit);
	app.get("/things", (c) => ok(c, { seen: true }));
	app.post("/things", (c) => ok(c, { seen: true }));
	app.onError((error, c) => failure(c, error));
	return app;
}

// No seedUser: the bucket key is opaque text with no foreign key, so a fresh id
// per test keeps the suites from contending.
const freshActor = () => crypto.randomUUID();

const remainingOf = (response: Response) =>
	Number(response.headers.get("RateLimit-Remaining"));

/**
 * Puts a bucket at a known level so a test does not have to spend a whole budget
 * to reach the interesting state. `updated_at` is left at `now()`, so the refill
 * the next request earns is a few milliseconds' worth and cannot change a result.
 */
const primeBucket = (key: string, tokens: number) =>
	db
		.insert(apiRateLimit)
		.values({ key, tokens })
		.onConflictDoUpdate({
			set: { tokens, updatedAt: sql`now()` },
			target: apiRateLimit.key,
		});

/**
 * Moves the bucket's clock back instead of sleeping. The refill is computed from
 * `updated_at` against Postgres' `now()`, so backdating the row is indistinguishable
 * from waiting — and a test that really waited a minute is a test nobody runs.
 */
const ageBucket = (key: string, seconds: number) =>
	db
		.update(apiRateLimit)
		.set({ updatedAt: sql`now() - make_interval(secs => ${seconds})` })
		.where(eq(apiRateLimit.key, key));

const tokensIn = async (key: string) => {
	const [row] = await db
		.select({ tokens: apiRateLimit.tokens })
		.from(apiRateLimit)
		.where(eq(apiRateLimit.key, key));
	return row?.tokens;
};

describe.skipIf(!ready)("rate limit middleware", () => {
	it("spends a token per request and reports the budget left", async () => {
		const app = buildApp(freshActor());
		const first = await app.request("/things");
		const second = await app.request("/things");

		expect(first.status).toBe(200);
		expect(first.headers.get("RateLimit-Limit")).toBe(String(READ_BUDGET));
		expect(remainingOf(first)).toBe(READ_BUDGET - 1);
		// One token down; the reset is derived, not the flat minute.
		expect(first.headers.get("RateLimit-Reset")).toBe("1");
		expect(remainingOf(second)).toBeLessThan(remainingOf(first));
		// Lower bound too: the refill between requests caps the drop at one token.
		expect(remainingOf(second)).toBeGreaterThanOrEqual(READ_BUDGET - 2);
	});

	// Primed rather than spent, so the refusal cannot race the refill: a spent
	// loop only lands on it if it finishes in under a second — the flake this
	// test used to have. A primed 1 is still spendable (`allowed` is tokens >= 0);
	// the refusal starts a token below, at the primed 0.
	it("refuses with a 429 once the budget is spent", async () => {
		const actorId = freshActor();
		const app = buildApp(actorId);
		await primeBucket(`${actorId}|write`, 1);
		const last = await app.request("/things", { method: "POST" });
		expect(last.status).toBe(200);
		expect(remainingOf(last)).toBe(0);
		await primeBucket(`${actorId}|write`, 0);
		const refused = await app.request("/things", { method: "POST" });
		const body = (await refused.json()) as { error: { code: string } };
		expect(refused.status).toBe(429);
		expect(body.error.code).toBe("TOO_MANY_REQUESTS");
		// Set before the throw, and it has to survive `app.onError`. Two, not one:
		// a refusal settles the bucket just below zero, so the caller waits out the
		// debt token as well as the one it wants to spend.
		expect(refused.headers.get("Retry-After")).toBe("2");
		expect(refused.headers.get("RateLimit-Limit")).toBe(String(WRITE_BUDGET));
		expect(remainingOf(refused)).toBe(0);
	});

	// The whole budget spent for real, not primed: this would catch the capacity
	// wired to the wrong env key, or an off-by-one in the fresh bucket's start.
	// `remaining` is not asserted — a slow runner earns a token back mid-loop —
	// so the exact counts live in the primed tests; the loop still proves every
	// request up to the budget succeeds.
	it("lets a client spend the whole budget as a burst", async () => {
		const app = buildApp(freshActor());
		let last = await app.request("/things", { method: "POST" });
		for (let spent = 1; spent < WRITE_BUDGET; spent += 1) {
			// biome-ignore lint/performance/noAwaitInLoops: a burst has to be serial to be countable — issued in parallel these would interleave with the refill and the request that tips the bucket over would no longer be a known one.
			last = await app.request("/things", { method: "POST" });
		}
		expect(last.status).toBe(200);
	});

	// The single-statement upsert is what serialises concurrent spends; a
	// read-then-write version would let two of a burst spend the same token. The
	// serial burst cannot see that, so here the burst arrives together — one
	// request more than the budget, because the fresh row starts at capacity - 1.
	it("leaves exactly one loser when a burst arrives concurrently", async () => {
		const app = buildApp(freshActor());
		const requests = Array.from({ length: WRITE_BUDGET + 1 }, () =>
			app.request("/things", { method: "POST" })
		);
		const responses = await Promise.all(requests);
		const refused = responses.filter((response) => response.status === 429);
		const allowed = responses.filter((response) => response.status === 200);
		expect(refused).toHaveLength(1);
		expect(allowed).toHaveLength(WRITE_BUDGET);
		expect(refused[0]?.headers.get("Retry-After")).toBe("2");
	});
	it("draws reads and writes from separate buckets", async () => {
		const actorId = freshActor();
		const app = buildApp(actorId);
		await primeBucket(`${actorId}|write`, 0);
		const write = await app.request("/things", { method: "POST" });
		const read = await app.request("/things");
		expect(write.status).toBe(429);
		expect(read.status).toBe(200);
		expect(remainingOf(read)).toBe(READ_BUDGET - 1);
	});
	it("keeps one actor's exhaustion off another actor", async () => {
		const spent = freshActor();
		const fresh = freshActor();
		await primeBucket(`${spent}|write`, 0);
		const post = { method: "POST" } as const;
		const refused = await buildApp(spent).request("/things", post);
		const allowed = await buildApp(fresh).request("/things", post);
		expect(refused.status).toBe(429);
		expect(allowed.status).toBe(200);
		expect(remainingOf(allowed)).toBe(WRITE_BUDGET - 1);
	});
	it("refills the bucket as time passes, up to its capacity", async () => {
		const actorId = freshActor();
		const app = buildApp(actorId);
		const key = `${actorId}|write`;
		await primeBucket(key, 0);
		await ageBucket(key, 30);
		const partial = await app.request("/things", { method: "POST" });
		// Half a minute at one token a second, less the token this request spent.
		expect(partial.status).toBe(200);
		expect(remainingOf(partial)).toBe(WRITE_BUDGET / 2 - 1);

		await primeBucket(key, 0);
		await ageBucket(key, 10 * 60);
		const capped = await app.request("/things", { method: "POST" });
		// Ten minutes is ten budgets; the bucket is not a savings account.
		expect(remainingOf(capped)).toBe(WRITE_BUDGET - 1);
	});
	it("does not let a refused caller run up unbounded debt", async () => {
		const actorId = freshActor();
		const app = buildApp(actorId);
		const key = `${actorId}|write`;
		await primeBucket(key, 0);

		let refused: Response | undefined;
		for (let attempt = 0; attempt < 25; attempt += 1) {
			// biome-ignore lint/performance/noAwaitInLoops: each refusal has to see the debt the previous one left, which is the whole claim under test; in parallel they would all read the same starting row.
			refused = await app.request("/things", { method: "POST" });
		}

		expect(refused?.status).toBe(429);
		// Twenty-five refusals, and the wait is what a single refusal costs:
		// without the repository floor the debt would climb a second per refusal.
		expect(refused?.headers.get("Retry-After")).toBe("2");
		expect(await tokensIn(key)).toBeGreaterThanOrEqual(-1);
		// And the debt really clears in that time, not just on paper.
		await ageBucket(key, 2);
		const recovered = await app.request("/things", { method: "POST" });
		expect(recovered.status).toBe(200);
	});
});
