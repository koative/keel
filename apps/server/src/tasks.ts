import { closePool } from "@keel/db";
import { rateLimit } from "@keel/db/schema/auth";
import { env } from "@keel/env/server";
import { lt } from "drizzle-orm";
import { sweepExpiredKeys } from "@/lib/idempotency.repository";
import { reclaimStrandedJobs, sweepSettledJobs } from "@/lib/jobs.repository";
import { sweepIdleBuckets } from "@/lib/rate-limit";
import { deleteInBatches } from "@/lib/sweep";

/**
 * Periodic maintenance: `bun dist/tasks.mjs`.
 *
 * Four tables grow without bound and none has an owner that prunes them, so
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

/**
 * How long a settled job is kept before it is deleted.
 *
 * Three days, because the two pressures pull opposite ways. A `failed` row is
 * the only place `last_error` lives, and a job that broke on Friday evening has
 * to still be readable on Monday morning or the retention is theatre. Past that
 * nobody is diagnosing from the table — they are reading wide events out of the
 * drain, which is where the failure was also recorded.
 *
 * The other direction is the harder limit: a `mail.send` payload holds the
 * rendered message, so a verification or reset row is a live one-time link at
 * rest. Its token has expired many times over within three days; the row itself
 * has no reason to outlive that.
 */
const SETTLED_JOB_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/**
 * The ceiling on one job, and the reason the reaper's threshold is derived from
 * the batch size instead of chosen.
 *
 * `ai.generate` aborts at `DEFAULT_TIMEOUT_MS` in `packages/ai/src/generate.ts`
 * and `mail.send` aborts well before it, so 120s is what one job can honestly
 * cost. A handler slower than this must raise this constant in the same commit,
 * because a reaper that fires early does not corrupt the table — the ownership
 * fences see to that — it sends a second email.
 */
const SLOWEST_HANDLER_MS = 120_000;

/**
 * On top of the batch: the claim round trip, a pool wait before a handler
 * starts, and the ten seconds a hard-killed worker may already have spent inside
 * its drain deadline.
 */
const RECLAIM_MARGIN_MS = 5 * 60 * 1000;

/**
 * How long a `running` row may hold its lock before another process may take it
 * back.
 *
 * `claim` stamps `locked_at` on the whole batch in one statement and `runOnce`
 * runs that batch one job at a time, so the last row in a batch waits out every
 * job ahead of it before its own handler even starts. The worst legitimate hold
 * is therefore the batch size times the slowest handler — read from the
 * environment, because a deployment that widens the batch widens exactly this.
 *
 * At the documented `WORKER_BATCH_SIZE=10` that is 25 minutes. Not an env key:
 * this is arithmetic over two timeouts that live in this repository, not a
 * deployment decision, and the three retention windows above it are constants
 * for the same reason.
 */
const STRANDED_JOB_TIMEOUT_MS =
	env.WORKER_BATCH_SIZE * SLOWEST_HANDLER_MS + RECLAIM_MARGIN_MS;

let failedSweeps = 0;

/**
 * Runs one maintenance statement so its failure cannot take the rest of the run
 * with it. The settled-job sweep is one of the last, and it is the one whose
 * payloads are live one-time links: before this wrapper existed, a statement
 * cancelled at the budget rejected and the script died on the unhandled
 * rejection — `closePool()` never ran, the work queued behind it never ran, and
 * the next cron tick met a larger table and failed sooner.
 *
 * A failure is reported on stderr and counted as `whenFailed`, which is why the
 * zero value is the caller's to supply: the reclaim reports two numbers rather
 * than a row count, and it is the least bounded statement of the lot. The run
 * continues, and `failedSweeps` turns into a non-zero exit so the failure is
 * visible to whatever runs cron rather than looking like a clean run.
 */
async function guardedSweep<T>(
	name: string,
	run: () => Promise<T>,
	whenFailed: T
): Promise<T> {
	try {
		return await run();
	} catch (error) {
		failedSweeps += 1;
		const message = error instanceof Error ? error.message : String(error);
		process.stderr.write(`[tasks] ${name} sweep failed: ${message}\n`);
		return whenFailed;
	}
}

const expiredKeys = await guardedSweep("idempotency", sweepExpiredKeys, 0);

/**
 * A backstop, not the only pruner. Better Auth does delete these rows: its
 * database rate-limit storage fires `deleteExpiredRows` in the background of any
 * request whose window has just rolled over, with a cutoff of its largest
 * configured window — tens of seconds, far tighter than the day kept here.
 *
 * It is still worth sweeping, because that prune only happens as a side effect
 * of live auth traffic and its failures are only logged. A deployment that goes
 * quiet, or one whose background delete lost a race with a restart, keeps
 * whatever was already behind. Dropping a stale counter is safe either way: a
 * missing row starts a fresh window, which is what an expired counter means.
 */
const staleCounters = await guardedSweep(
	"auth rate-limit",
	() =>
		deleteInBatches({
			primaryKey: rateLimit.id,
			table: rateLimit,
			where: lt(rateLimit.lastRequest, Date.now() - RATE_LIMIT_RETENTION_MS),
		}),
	0
);

const idleBuckets = await guardedSweep(
	"idle token bucket",
	() => sweepIdleBuckets(new Date(Date.now() - IDLE_BUCKET_RETENTION_MS)),
	0
);

const settledJobs = await guardedSweep(
	"settled job",
	() => sweepSettledJobs(new Date(Date.now() - SETTLED_JOB_RETENTION_MS)),
	0
);

/**
 * Last, and here rather than in the worker: a worker cannot recover the rows it
 * lost by dying, and a `setInterval` in the API would run once per replica and
 * never at all under scale-to-zero — the same argument the header makes for the
 * sweeps. Overlapping runs stay harmless because the statement skips locked rows
 * and rechecks `status = 'running'` on the row it writes.
 *
 * Guarded like the sweeps, and for a sharper reason than symmetry: it is the one
 * maintenance statement with no LIMIT, so it is the likeliest to be cancelled at
 * the statement budget. Bare, that rejection was an unhandled rejection at
 * module top level — the summary line below never printed even when all four
 * sweeps had succeeded, `process.exitCode` was never set, and `closePool()`
 * never ran.
 */
const strandedJobs = await guardedSweep(
	"stranded job",
	() => reclaimStrandedJobs(STRANDED_JOB_TIMEOUT_MS),
	{ exhausted: 0, requeued: 0 }
);

process.stdout.write(
	`[tasks] swept ${expiredKeys} idempotency key(s), ${staleCounters} auth rate-limit counter(s), ${idleBuckets} idle token bucket(s), ${settledJobs} settled job(s); requeued ${strandedJobs.requeued} stranded job(s), exhausted ${strandedJobs.exhausted}\n`
);

// A failed sweep already reported itself on stderr; a non-zero exit makes it
// visible to whatever runs cron instead of reading like a clean run.
if (failedSweeps > 0) {
	process.exitCode = 1;
}

// The pool holds an idle client for `idleTimeoutMillis`, and its timer keeps the
// event loop alive. Without this the sweep finishes in milliseconds and the
// process then sits for another thirty seconds — so a cron firing every minute
// spends half of it dead, and anything measuring task duration reports 30s for
// 20ms of work.
await closePool();
