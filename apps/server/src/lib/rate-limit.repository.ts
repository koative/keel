import { db } from "@keel/db";
import { apiRateLimit } from "@keel/db/schema/rate-limit";
import { lt, sql } from "drizzle-orm";
import { deleteInBatches } from "@/lib/sweep";

/**
 * The only file allowed to touch Drizzle for rate limiting.
 */

export interface BucketSpec {
	/** Bucket size, and therefore the largest burst a caller may spend at once. */
	capacity: number;
	/** Tokens returned per second. `capacity / refillPerSecond` is the drain time. */
	refillPerSecond: number;
}

export interface Consumption {
	allowed: boolean;
	/** Tokens left after this request, floored. For the response headers. */
	remaining: number;
	/** Whole seconds until one token is available. Zero when `allowed`. */
	retryAfterSeconds: number;
}

/**
 * The floor a refused request may drive the bucket to.
 *
 * Not zero, and this is the detail that makes one statement enough. Clamping at
 * zero makes "spent the last token" and "had no token" both leave `tokens = 0`, so
 * the row cannot say which happened and the decision needs a second read. Letting
 * it settle just below zero makes `tokens >= 0` mean allowed, unambiguously.
 *
 * Bounded at a single token so a refused burst cannot accumulate a debt that
 * outlives it: the worst case is that the next token takes one extra refill
 * interval to arrive, which a caller being rate limited has earned.
 */
const DEBT_FLOOR = -1;

/**
 * Spends one token, or reports how long until there is one.
 *
 * A single statement, and that is the whole design. Read-then-write would let two
 * concurrent requests read the same token count and both spend it — precisely the
 * case a limiter exists to prevent, and one that load makes likely rather than
 * rare. Here the refill, the spend and the clamp happen inside one
 * `on conflict do update`, so Postgres serialises them on the row.
 *
 * The refill is computed from the row's own `updated_at` against `now()`, so no
 * clock but the database's is involved and two workers cannot disagree about how
 * much time has passed.
 */
export async function consume(
	key: string,
	spec: BucketSpec
): Promise<Consumption> {
	const [row] = (
		await db.execute(sql`
			insert into ${apiRateLimit} (key, tokens, updated_at)
			values (${key}, ${spec.capacity - 1}, now())
			on conflict (key) do update set
				tokens = greatest(
					${DEBT_FLOOR},
					least(
						${spec.capacity},
						${apiRateLimit.tokens} + extract(
							epoch from now() - ${apiRateLimit.updatedAt}
						) * ${spec.refillPerSecond}
					) - 1
				),
				updated_at = now()
			returning tokens
		`)
	).rows;

	// A raw statement's row type is opaque to the compiler, so read the field
	// rather than assert the shape.
	const tokens = Number(row?.tokens ?? DEBT_FLOOR);
	const allowed = tokens >= 0;

	return {
		allowed,
		remaining: Math.max(0, Math.floor(tokens)),
		retryAfterSeconds: allowed
			? 0
			: Math.max(1, Math.ceil((1 - tokens) / spec.refillPerSecond)),
	};
}

/** Drops buckets nobody has touched since `olderThan`. Called from `tasks.ts`. */
export function sweepIdleBuckets(olderThan: Date): Promise<number> {
	return deleteInBatches({
		primaryKey: apiRateLimit.key,
		table: apiRateLimit,
		where: lt(apiRateLimit.updatedAt, olderThan),
	});
}
