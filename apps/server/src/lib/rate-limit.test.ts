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
/** Tokens of refill a bound tolerates. The write bucket returns one a second. */
const REFILL_SLACK = 5;

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
 * to reach the interesting state. `updated_at` is left at `now()`, so the request
 * that follows earns a few milliseconds of refill — a fraction of the token a
 * second the write bucket returns, enough to keep a primed 0 refused but not
 * enough to pin an exact remaining count on any level above it.
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

	/**
	 * The two primed tests below already establish that a spent bucket answers 429;
	 * this is the one that reads the refusal's body and headers. They reach the
	 * client only through `app.onError`, and a limiter that threw before setting
	 * them would still produce a 429 and pass those two.
	 */
	it("renders a refusal as the standard envelope with its retry headers", async () => {
		const actorId = freshActor();
		const app = buildApp(actorId);
		await primeBucket(`${actorId}|write`, 0);

		const refused = await app.request("/things", { method: "POST" });
		const body = (await refused.json()) as { error: { code: string } };

		expect(refused.status).toBe(429);
		expect(body.error.code).toBe("TOO_MANY_REQUESTS");
		// Set before the throw, and it has to survive `app.onError`. Two, not one:
		// a refusal settles the bucket just below zero, so the caller waits out the
		// debt token as well as the one it wants to spend.
		expect(refused.headers.get("Retry-After")).toBe("2");
		// The only assertion in this suite that catches the write bucket reading the
		// read budget's env key: 600 in place of 60 leaves every count here unchanged.
		expect(refused.headers.get("RateLimit-Limit")).toBe(String(WRITE_BUDGET));
		expect(remainingOf(refused)).toBe(0);
	});

	/**
	 * The whole budget spent for real, not primed: the loop proves every request up
	 * to the budget is allowed, which an off-by-one in the fresh row's starting level
	 * would break. It cannot catch the capacity reading the wrong env key — the read
	 * budget is ten times the write budget, so sixty requests would all be allowed
	 * anyway, and the `RateLimit-Limit` assertions are what catch that. `remaining`
	 * is not asserted either: a slow runner earns a token back mid-loop.
	 */
	it("lets a client spend the whole budget as a burst", async () => {
		const app = buildApp(freshActor());
		let last = await app.request("/things", { method: "POST" });
		for (let spent = 1; spent < WRITE_BUDGET; spent += 1) {
			// biome-ignore lint/performance/noAwaitInLoops: a burst has to be serial to be countable — issued in parallel these would interleave with the refill and the request that tips the bucket over would no longer be a known one.
			last = await app.request("/things", { method: "POST" });
		}
		expect(last.status).toBe(200);
	});

	/**
	 * The single-statement upsert is what serialises concurrent spends; a
	 * read-then-write version would let much of a burst spend the same token. The
	 * serial burst above cannot see that, so here the burst arrives together and
	 * three times over the budget, which puts the assertion on the ceiling rather
	 * than on the boundary one request past it.
	 *
	 * Bounds and not an exact count of losers: the bucket refills a token a second,
	 * so a burst that takes a moment legitimately lets a few extra through, which is
	 * the flake the exact count had. The run this was written against settled all
	 * 180 requests in about twenty milliseconds.
	 */
	it("lets no more than the budget through when a burst arrives at once", async () => {
		const app = buildApp(freshActor());
		const responses = await Promise.all(
			Array.from({ length: WRITE_BUDGET * 3 }, () =>
				app.request("/things", { method: "POST" })
			)
		);
		const allowed = responses.filter((response) => response.status === 200);
		const refused = responses.filter((response) => response.status === 429);

		expect(allowed.length).toBeGreaterThanOrEqual(WRITE_BUDGET);
		expect(allowed.length).toBeLessThanOrEqual(WRITE_BUDGET + REFILL_SLACK);
		// Nothing else happened: every request was either allowed or refused.
		expect(refused.length).toBe(responses.length - allowed.length);
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
