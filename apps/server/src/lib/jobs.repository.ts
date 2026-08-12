import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { and, eq, inArray, lt, sql } from "drizzle-orm";

/**
 * The only file allowed to touch Drizzle for the queue, mirroring the per-module
 * repositories. It lives under lib/ because the queue is infrastructure: the
 * worker and every module that enqueues share this one instance.
 *
 * Every timestamp comparison here is made with Postgres' `now()` rather than a
 * `Date` from the process. The database is the one clock all workers already
 * agree on; scheduling against a local clock would make two replicas with a few
 * seconds of drift disagree about which jobs are due.
 */

/**
 * Enqueueing is the exception: it moved to `@keel/db/jobs` because `@keel/auth`
 * and `@keel/mail` both enqueue, and a package cannot import app code. It is
 * re-exported here so that server callers keep reaching the queue through this
 * pair rather than learning a second import path.
 */
// biome-ignore lint/performance/noBarrelFile: not a barrel — this module owns the rest of the queue's SQL and forwards exactly one binding that had to move out of the app. The alternative the rule leaves, importing then exporting, is what noExportedImports forbids.
export {
	type EnqueueInput,
	type EnqueueResult,
	enqueue,
} from "@keel/db/jobs";

/** First retry delay. Doubles per attempt, so 1s, 2s, 4s, 8s... */
const BACKOFF_BASE_MS = 1000;

/**
 * Ceiling for the doubling. Without it attempt 20 would be scheduled for some
 * time next year, which reads as "the queue lost my job" rather than "it is
 * still retrying".
 */
const BACKOFF_MAX_MS = 5 * 60 * 1000;

/**
 * A driver error can carry the entire offending row and a stack trace has no
 * upper bound, while `last_error` is read in a dashboard listing every job. The
 * diagnosis is in the first line; the rest is a cost paid on every read.
 */
const MAX_ERROR_LENGTH = 1000;

export interface ClaimedJob {
	attempts: number;
	id: string;
	kind: string;
	maxAttempts: number;
	payload: unknown;
}

function describeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Takes up to `limit` due jobs for this worker and marks them running.
 *
 * One statement, deliberately. Selecting candidates and then updating them would
 * leave a window in which a second worker reads the same rows as pending and
 * both run the job; no ordering of two statements closes it, because the gap is
 * between them.
 *
 * `for update skip locked` is what makes a second worker useful rather than
 * merely safe: it locks the rows this statement is claiming and steps over rows
 * another worker is already claiming, so N workers each take a disjoint batch
 * instead of queueing behind one lock.
 */
export async function claim(
	workerId: string,
	limit: number
): Promise<ClaimedJob[]> {
	const claimed = await db.execute(sql`
		with claimable as (
			select ${job.id} from ${job}
			where ${job.status} = 'pending' and ${job.runAt} <= now()
			order by ${job.runAt}
			limit ${limit}
			for update skip locked
		)
		update ${job}
		set
			locked_at = now(),
			locked_by = ${workerId},
			status = 'running',
			updated_at = now()
		from claimable
		where ${job.id} = claimable.id
		returning
			${job.attempts},
			${job.id},
			${job.kind},
			${job.maxAttempts} as "maxAttempts",
			${job.payload}
	`);

	// A raw statement's row type is `Record<string, unknown>`, so the compiler
	// cannot check the `returning` list above. Read the fields rather than assert
	// the shape: an assertion would still compile after someone edits that list,
	// and the first sign would be a handler receiving `undefined` at runtime.
	return claimed.rows.map((row) => ({
		attempts: Number(row.attempts),
		id: String(row.id),
		kind: String(row.kind),
		maxAttempts: Number(row.maxAttempts),
		payload: row.payload,
	}));
}

/**
 * Marks a job done, and reports whether it was this call that did it. Terminal:
 * no index and no query looks at a `done` row again.
 *
 * Fenced on `status = 'running'` and on the claiming worker's own id, so it can
 * only settle a job this worker still owns. Keyed on `id` alone it would be a
 * double-execution bug waiting for a reaper: the moment anything reclaims a
 * stalled row, a merely slow original worker finishing its handler would mark
 * done work a second worker is still running.
 *
 * The boolean is what makes the fence usable rather than merely safe. Zero rows
 * is not an error — it is "the row is no longer both running and mine", which
 * happens when a previous attempt at this same statement committed but its
 * acknowledgement was lost, and again when a reaper has already taken the row
 * away. The caller has to be able to tell that apart from a settled job, because
 * one of them means the queue now has a record of the outcome and the other
 * means it does not.
 */
export async function complete(id: string, workerId: string): Promise<boolean> {
	const settled = await db
		.update(job)
		.set({ lockedAt: null, lockedBy: null, status: "done" })
		.where(
			and(eq(job.id, id), eq(job.lockedBy, workerId), eq(job.status, "running"))
		)
		.returning({ id: job.id });

	return settled.length === 1;
}

/**
 * What `last_error` says when the failure was the queue's, not the handler's.
 *
 * A prefix rather than a column, because this is for whoever reads a job row and
 * has to know that the work in it happened — inventing a column would mean a
 * migration for a string only a human ever reads. It is deliberately not a
 * control signal: nothing branches on it, because a handler is free to throw a
 * message starting with anything. What tells the two kinds apart mechanically is
 * the row itself — a handler failure leaves `status` pending or failed with
 * `locked_by` null, a settlement failure leaves it running and still locked.
 */
export const SETTLEMENT_ERROR_PREFIX =
	"settlement failed after handler succeeded: ";

/**
 * Notes on a job that ran but could not be marked done.
 *
 * The point of this statement is everything it does NOT set. `attempts`,
 * `run_at` and `status` are untouched: the handler succeeded, so no attempt was
 * spent, there is nothing to back off from, and re-arming the row would be a
 * request to run the side effect a second time. `locked_at` and `locked_by` are
 * untouched too, so the lease a reaper reads is neither extended nor released by
 * a purely diagnostic write. `updated_at` does move, because the column's
 * `$onUpdate` fires on every Drizzle update — which is why a lease must be keyed
 * off `locked_at` and never off `updated_at`.
 *
 * Fenced exactly like `complete`, so a worker whose row has already been taken
 * away writes nothing rather than scribbling on a job somebody else is running.
 * That makes this a best-effort note by design: it is written over the same pool
 * that just refused, and losing it costs a line of context, not correctness.
 */
export async function markUnsettled(
	id: string,
	workerId: string,
	error: unknown
): Promise<void> {
	await db
		.update(job)
		.set({
			lastError: `${SETTLEMENT_ERROR_PREFIX}${describeError(error)}`.slice(
				0,
				MAX_ERROR_LENGTH
			),
		})
		.where(
			and(eq(job.id, id), eq(job.lockedBy, workerId), eq(job.status, "running"))
		);
}

/**
 * Records an attempt that threw and decides whether the job gets another one.
 *
 * Once `attempts` reaches `maxAttempts` the job becomes `failed`, which no claim
 * can select again. A poison payload — one that will throw for every worker,
 * forever — therefore costs a bounded number of attempts instead of occupying a
 * worker in a loop that never converges.
 *
 * Fenced like `complete`, and here the guard also prevents resurrection: keyed on
 * `id` alone this statement would set a `done` or `failed` row back to `pending`
 * and re-arm `run_at`, putting a settled job back in the claim index.
 */
export async function fail(
	id: string,
	workerId: string,
	error: unknown
): Promise<void> {
	await db.execute(sql`
		update ${job}
		set
			attempts = ${job.attempts} + 1,
			last_error = ${describeError(error)},
			locked_at = null,
			locked_by = null,
			run_at = now() + make_interval(
				secs => least(
					${BACKOFF_BASE_MS}::bigint * power(2, ${job.attempts}),
					${BACKOFF_MAX_MS}::bigint
				) / 1000.0
			),
			status = case
				when ${job.attempts} + 1 >= ${job.maxAttempts} then 'failed'
				else 'pending'
			end,
			updated_at = now()
		where ${job.id} = ${id}
			and ${job.lockedBy} = ${workerId}
			and ${job.status} = 'running'
	`);
}

/**
 * Drops every settled job older than the cutoff and reports how many went.
 *
 * Two reasons, and neither carries this on its own. The table has no owner that
 * prunes it: `done` and `failed` are terminal, so without a sweep every job the
 * system has ever run stays on disk forever and the claim index degrades behind
 * a history nothing reads. And a settled job's payload is not inert — a
 * `mail.send` row holds the rendered message, which for a verification or a
 * password reset means a live one-time link sitting in a table long after the
 * mail it belonged to was delivered.
 *
 * `failed` goes with `done` deliberately. A failed row is worth keeping while
 * someone might still read `last_error` to find out what broke; it is not worth
 * keeping forever, and it holds the same one-time link a delivered one does.
 */
export async function sweepSettledJobs(olderThan: Date): Promise<number> {
	const removed = await db
		.delete(job)
		.where(
			and(inArray(job.status, ["done", "failed"]), lt(job.updatedAt, olderThan))
		)
		.returning({ id: job.id });
	return removed.length;
}

export interface ReclaimedJobs {
	/** Stranded rows whose work a newer pending row already covers. */
	collapsed: number;
	/** Stranded rows that spent their last attempt and are now `failed`. */
	exhausted: number;
	/** Stranded rows put back on the queue. */
	requeued: number;
}

/**
 * Takes back rows a worker claimed and never settled, and reports what happened
 * to them.
 *
 * `claim` is the only writer of `locked_at`, and until this function existed
 * nothing read it: the sole way out of `running` was the claiming worker's own
 * `complete` or `fail`, both fenced on `locked_by`. The worker id is
 * `hostname():pid`, so a restarted worker gets a new pid and cannot settle its
 * predecessor's rows either. A SIGKILL or an OOM therefore turned at-least-once
 * delivery into at-most-once, silently and permanently — `sweepSettledJobs`
 * does not even prune `running`, so the row stayed in the claim index forever.
 *
 * `staleAfterMs` is the caller's, not this module's, because the honest value
 * depends on `WORKER_BATCH_SIZE` — `tasks.ts` derives it and says why there.
 *
 * ## The dedupe index
 *
 * `job_dedupeKey_pending_idx` is unique on `dedupe_key` where `status =
 * 'pending'`. A claimed row is `running`, so it has already left that index and
 * a second `enqueue` of its key was accepted while it ran. Putting the stranded
 * row back to `pending` would then be a second entry for one key, and the
 * violation would abort the whole batch — one poisoned row costing every other
 * row its recovery.
 *
 * Two independent things stop that, and both are needed.
 *
 * Policy: a row is only requeued when no `pending` row already holds its key,
 * and when it is the oldest lock among the stranded rows that share it.
 * Otherwise the work is already covered, so the row is settled `failed` with the
 * reason on it rather than duplicated.
 *
 * Safety: a requeued row is written back with `dedupe_key = null`, so it creates
 * no index entry and the statement cannot raise 23505 even against an `enqueue`
 * that commits between the policy read and this write. That is not a loss — the
 * row released its collapse slot when it was claimed, and a reclaim restores the
 * attempt, not the claim. Rows that stay settled keep their key, because a
 * `failed` row is outside the index anyway and the key is how someone reading
 * the table finds the row that took over.
 *
 * `for update skip locked` mirrors `claim`: a concurrent reaper takes a disjoint
 * set instead of blocking, and a row a live worker is mid-settle on is stepped
 * over rather than fought with. The repeated `status = 'running'` on the update
 * itself is the recheck that makes a lost race a no-op rather than a second
 * attempt increment.
 */
export async function reclaimStrandedJobs(
	staleAfterMs: number
): Promise<ReclaimedJobs> {
	const reclaimed = await db.execute(sql`
		with stale as materialized (
			select ${job.id} as id from ${job}
			where ${job.status} = 'running'
				and ${job.lockedAt} < now() - make_interval(
					secs => ${staleAfterMs}::bigint / 1000.0
				)
			for update skip locked
		),
		ranked as (
			select
				j.id as id,
				j.dedupe_key as dedupe_key,
				row_number() over (
					partition by j.dedupe_key order by j.locked_at, j.id
				) as slot
			from ${job} j
			join stale on stale.id = j.id
		),
		decided as (
			select
				r.id as id,
				(
					r.dedupe_key is null
					or (
						r.slot = 1
						and not exists (
							select 1 from ${job} p
							where p.dedupe_key = r.dedupe_key
								and p.status = 'pending'
						)
					)
				) as requeue
			from ranked r
		)
		update ${job}
		set
			attempts = ${job.attempts} + 1,
			dedupe_key = case when d.requeue then null else ${job.dedupeKey} end,
			last_error = 'stranded: worker '
				|| coalesce(${job.lockedBy}, 'unknown')
				|| ' stopped without settling this job'
				|| case
					when not d.requeue
						then '; a newer pending job holds its dedupe key'
					when ${job.attempts} + 1 >= ${job.maxAttempts}
						then '; no attempts left'
					else ''
				end,
			locked_at = null,
			locked_by = null,
			run_at = now(),
			status = case
				when not d.requeue then 'failed'
				when ${job.attempts} + 1 >= ${job.maxAttempts} then 'failed'
				else 'pending'
			end,
			updated_at = now()
		from decided d
		where ${job.id} = d.id and ${job.status} = 'running'
		returning ${job.id}, ${job.status}, d.requeue
	`);

	// Read out of the returned rows rather than counted with three statements:
	// the outcome per row is decided inside the update, and asking the table
	// again afterwards would be asking a different snapshot.
	let collapsed = 0;
	let exhausted = 0;
	let requeued = 0;
	for (const row of reclaimed.rows) {
		if (row.requeue !== true) {
			collapsed += 1;
		} else if (row.status === "failed") {
			exhausted += 1;
		} else {
			requeued += 1;
		}
	}

	return { collapsed, exhausted, requeued };
}
