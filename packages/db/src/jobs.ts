import { sql } from "drizzle-orm";

import { db } from "./index";
import { job } from "./schema/job";

/**
 * Enqueueing lives in this package rather than in the server app because both
 * `@keel/auth` and `@keel/mail` need it, and a package cannot import app code.
 * Duplicating the insert instead would duplicate the dedupe semantics below,
 * and the explicit partial-index conflict target is subtle enough that it must
 * exist exactly once.
 *
 * Only the write is here. Claiming, completing and failing jobs stay in the
 * app's `jobs.repository`, because only the worker performs them.
 */

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
