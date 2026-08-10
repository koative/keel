import { closePool, db } from "@keel/db";
import { rateLimit } from "@keel/db/schema/auth";
import { lt } from "drizzle-orm";
import { sweepExpiredKeys } from "@/lib/idempotency.repository";
import { sweepIdleBuckets } from "@/lib/rate-limit";

/**
 * Periodic maintenance: `bun dist/tasks.mjs`.
 *
 * Three tables grow without bound and none has an owner that prunes them, so
 * without this they are a slow disk leak that only shows up as a query plan going
 * bad months later.
 *
 * Deliberately a command rather than a timer inside the server. A `setInterval`
 * runs once per process, so three replicas sweep three times over the same rows
 * and a scale-to-zero deployment never sweeps at all. Point whatever already runs
 * cron at this — the work is idempotent, so overlapping runs are harmless.
 */

/** How long a rate-limit counter may sit untouched before it is meaningless. */
const RATE_LIMIT_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * How long an actor's token bucket may sit untouched before it is dropped.
 *
 * Comfortably longer than the minute it takes any bucket to refill, so the sweep
 * can never delete one that still holds a debt. Past that the row says nothing:
 * a full bucket and a missing row grant a caller exactly the same thing, because
 * `consume` inserts a fresh one at capacity. Deleting is therefore free, and not
 * deleting means one row per actor per method class, forever.
 */
const IDLE_BUCKET_RETENTION_MS = 60 * 60 * 1000;

const expiredKeys = await sweepExpiredKeys();

/**
 * Better Auth owns these rows and never deletes them: it keys on IP and path, so
 * every address that ever signed in leaves a counter behind forever. Dropping a
 * stale one is safe — a missing row simply starts a fresh window, which is what an
 * expired counter already means.
 */
const staleCounters = await db
	.delete(rateLimit)
	.where(lt(rateLimit.lastRequest, Date.now() - RATE_LIMIT_RETENTION_MS))
	.returning({ id: rateLimit.id });

const idleBuckets = await sweepIdleBuckets(
	new Date(Date.now() - IDLE_BUCKET_RETENTION_MS)
);

process.stdout.write(
	`[tasks] swept ${expiredKeys} idempotency key(s), ${staleCounters.length} auth rate-limit counter(s), ${idleBuckets} idle token bucket(s)\n`
);

// The pool holds an idle client for `idleTimeoutMillis`, and its timer keeps the
// event loop alive. Without this the sweep finishes in milliseconds and the
// process then sits for another thirty seconds — so a cron firing every minute
// spends half of it dead, and anything measuring task duration reports 30s for
// 20ms of work.
await closePool();
