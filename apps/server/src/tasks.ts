import { db } from "@keel/db";
import { rateLimit } from "@keel/db/schema/auth";
import { lt } from "drizzle-orm";
import { sweepExpiredKeys } from "@/lib/idempotency.repository";

/**
 * Periodic maintenance: `bun dist/tasks.mjs`.
 *
 * Two tables grow without bound and neither has an owner that prunes them, so
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

process.stdout.write(
	`[tasks] swept ${expiredKeys} idempotency key(s), ${staleCounters.length} rate-limit counter(s)\n`
);
