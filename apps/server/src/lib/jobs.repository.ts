import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { and, eq, sql } from "drizzle-orm";

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

export interface EnqueueInput {
	dedupeKey?: string;
	kind: string;
	payload: unknown;
	runAt?: Date;
}

export interface EnqueueResult {
	/** False when an equal dedupe key was already pending, so nothing was added. */
	created: boolean;
	id: string | null;
}

function describeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	return message.slice(0, MAX_ERROR_LENGTH);
}

/**
 * Adds a job, unless `dedupeKey` names work that is already waiting.
 *
 * The conflict is swallowed rather than raised, which is the opposite of what
 * `withUniqueConflict` does for a user-facing insert: there a duplicate is the
 * caller's mistake and deserves a 409, here it is the whole point. Two requests
 * that both decide "this tenant needs re-indexing" should produce one re-index,
 * and the caller has nothing to fix.
 *
 * The conflict target is stated explicitly instead of a bare `do nothing`, which
 * would also silently swallow a primary-key collision — a real bug that must not
 * be reported as successful deduplication.
 */
export async function enqueue(input: EnqueueInput): Promise<EnqueueResult> {
	const [created] = await db
		.insert(job)
		.values({
			dedupeKey: input.dedupeKey,
			kind: input.kind,
			payload: input.payload,
			runAt: input.runAt,
		})
		.onConflictDoNothing({
			target: job.dedupeKey,
			// Repeats the partial index's predicate, which is how Postgres knows
			// which index arbitrates the conflict.
			where: sql`${job.status} = 'pending'`,
		})
		.returning({ id: job.id });

	return { created: created !== undefined, id: created?.id ?? null };
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
 * Marks a job done. Terminal: no index and no query looks at it again.
 *
 * Fenced on `status = 'running'` and on the claiming worker's own id, so it can
 * only settle a job this worker still owns. Keyed on `id` alone it would be a
 * double-execution bug waiting for a reaper: the moment anything reclaims a
 * stalled row, a merely slow original worker finishing its handler would mark
 * done work a second worker is still running.
 */
export async function complete(id: string, workerId: string): Promise<void> {
	await db
		.update(job)
		.set({ lockedAt: null, lockedBy: null, status: "done" })
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
