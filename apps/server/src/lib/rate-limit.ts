import { env } from "@keel/env/server";
import { tooManyRequests } from "@keel/http/errors";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";
import { consume } from "./rate-limit.repository";

/**
 * The public face of rate limiting. Everything outside this subsystem goes
 * through here; `rate-limit.repository.ts` is private to it, which is why the
 * sweep is re-exported at the bottom rather than imported from the repository
 * by `tasks.ts`.
 */

const SECONDS_PER_MINUTE = 60;

/**
 * The methods that draw on the write budget. `HEAD` and `OPTIONS` fall to the
 * read budget by omission, which is correct: neither changes anything, and a
 * preflight never reaches here anyway — CORS short-circuits it several
 * middlewares earlier.
 */
const IS_MUTATING: Record<string, true> = {
	DELETE: true,
	PATCH: true,
	POST: true,
	PUT: true,
};

/**
 * A per-minute budget becomes a bucket whose capacity is that budget and whose
 * refill is a sixtieth of it per second. The burst therefore equals the minute's
 * allowance — a client may spend it all at once — and it comes back smoothly
 * instead of all at once on a window boundary.
 *
 * Read at import: `env` is validated at startup, so a bad value fails there
 * rather than on the first request that happens to be limited.
 */
const READ = {
	capacity: env.RATE_LIMIT_READ_PER_MINUTE,
	refillPerSecond: env.RATE_LIMIT_READ_PER_MINUTE / SECONDS_PER_MINUTE,
};

const WRITE = {
	capacity: env.RATE_LIMIT_WRITE_PER_MINUTE,
	refillPerSecond: env.RATE_LIMIT_WRITE_PER_MINUTE / SECONDS_PER_MINUTE,
};

/**
 * Bounds what one actor can spend, in two buckets: one for the methods that
 * change something and one for the methods that do not.
 *
 * MUST be mounted after `requireUser`, which is what puts `actorId` on the
 * context. In front of it there is no actor and the only key left is the client
 * address — forgeable behind a misconfigured proxy, and shared by everyone in an
 * office, so one script would throttle a whole building. Better Auth keys its own
 * limiter on IP for `/api/auth/*` because there is genuinely no actor yet there;
 * everywhere else there is one, and it is the better key.
 *
 * The method class is part of the key rather than one shared bucket because a
 * read and a write are not the same request. Sharing a bucket means a client that
 * polls a list endpoint spends the allowance its writes need, so the two budgets
 * could never be tuned independently and a busy dashboard would look exactly like
 * an abusive one. Two keys per actor is also two rows, which is a rounding error
 * next to the sessions the same actor already has.
 */
export const rateLimit = createMiddleware<AppEnv>(async (c, next) => {
	const mutating = IS_MUTATING[c.req.method] === true;
	const bucket = mutating ? "write" : "read";
	const spec = mutating ? WRITE : READ;

	const decision = await consume(`${c.get("actorId")}|${bucket}`, spec);

	// `RateLimit-Reset` is seconds until the bucket is full again, derived rather
	// than fixed at the minute the budget is stated in: a caller one token down is
	// a second from full, and telling it to sleep for sixty would leave a
	// well-behaved client slower than a badly-behaved one. A refusal reads as an
	// empty bucket here, since `remaining` is floored at zero, so the answer is
	// short by the fraction of a token the refusal went into debt for — which
	// `Retry-After` reports exactly and this header does not need to.
	c.header("RateLimit-Limit", String(spec.capacity));
	c.header("RateLimit-Remaining", String(decision.remaining));
	c.header(
		"RateLimit-Reset",
		String(
			Math.ceil((spec.capacity - decision.remaining) / spec.refillPerSecond)
		)
	);

	// On the request's single wide event, the way `requireUser` records the actor.
	// Without it a 429 is a status code with no explanation, and the first question
	// asked of one — which bucket, and how far over — needs a log line to answer.
	c.get("log").set({
		rateLimit: {
			allowed: decision.allowed,
			bucket,
			remaining: decision.remaining,
		},
	});

	if (!decision.allowed) {
		// Set before the throw on purpose, and it survives it: `c.header` writes to
		// the context's prepared headers and `app.onError` renders the problem+json
		// off that same context, so the 429 carries all four headers. Asserted in
		// `rate-limit.test.ts` rather than assumed — a Hono upgrade could change it
		// quietly, and a 429 without `Retry-After` tells a client nothing.
		c.header("Retry-After", String(decision.retryAfterSeconds));
		throw tooManyRequests(decision.retryAfterSeconds);
	}

	await next();
});

// biome-ignore lint/performance/noBarrelFile: not a barrel — this module owns the limiter and re-exports exactly one entry point, the same shape `@/lib/jobs` uses, so that the repository stays private to the subsystem. Importing then exporting the binding, the alternative the rule leaves, is what noExportedImports forbids.
export { sweepIdleBuckets } from "./rate-limit.repository";
