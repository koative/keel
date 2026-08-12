import { db } from "@keel/db";
import { getTableName, inArray, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

/**
 * Bounded deletes for the retention sweeps `tasks.ts` runs.
 *
 * One unbounded `DELETE` is fine until it is not. Every pooled connection
 * carries `statement_timeout` (packages/db/src/index.ts), so a sweep that has
 * fallen far enough behind is cancelled by Postgres rather than finishing —
 * and `tasks.ts` has no error handling, so the process dies, the sweeps queued
 * behind it never run, and the table is never pruned again. The next run faces
 * a bigger table and fails sooner. Batching removes the failure mode at the
 * root: every statement is small, so no statement approaches the budget.
 */

/**
 * Rows per statement. Large enough that a routine sweep is one or two round
 * trips, small enough that a batch is milliseconds of work rather than
 * something the timeout has an opinion about.
 */
const BATCH_SIZE = 1000;

/**
 * Batches per call. The ceiling is what stops a cron run spinning: without it a
 * table being written faster than it is swept keeps the loop alive forever, and
 * the ten-minute cron tick would find the previous run still going. Hitting it
 * is not an error — the run deletes what it deleted, says so on stderr, and the
 * next tick continues where this one stopped.
 */
const MAX_BATCHES = 100;

export interface BatchedDelete {
	batchSize?: number;
	maxBatches?: number;
	/** The column to page on. Any unique column works; the primary key is cheapest. */
	primaryKey: PgColumn;
	table: PgTable;
	/**
	 * `SQL | undefined` because that is what `and()` and Drizzle's own `.where()`
	 * are typed to produce. Undefined is rejected at runtime rather than accepted
	 * as "match everything".
	 */
	where: SQL | undefined;
}

/**
 * Deletes every row matching `where`, `batchSize` rows at a time, and returns
 * how many went.
 *
 * `delete … where id in (select id … limit n for update skip locked)` rather
 * than `delete … limit n`, which Postgres does not have. `skip locked` matches
 * `claim` in jobs.repository: two overlapping cron runs then take disjoint
 * batches instead of one queueing behind the other's locks.
 *
 * The count comes from the driver's `rowCount`, which is the number Postgres
 * already puts in the command tag. The `.returning({ id })` this replaced made
 * node-postgres allocate one object per deleted row so that `.length` could be
 * read — a million objects to produce the number one million.
 */
export async function deleteInBatches({
	batchSize = BATCH_SIZE,
	maxBatches = MAX_BATCHES,
	primaryKey,
	table,
	where,
}: BatchedDelete): Promise<number> {
	if (!where) {
		throw new Error(
			`deleteInBatches was called for ${getTableName(table)} with no predicate. Pass the retention filter — an unfiltered sweep would delete the whole table.`
		);
	}

	let removed = 0;

	for (let batch = 0; batch < maxBatches; batch += 1) {
		const doomed = db
			.select({ id: primaryKey })
			.from(table)
			.where(where)
			.limit(batchSize)
			.for("update", { skipLocked: true });

		// biome-ignore lint/performance/noAwaitInLoops: the serialisation is the point — each statement has to commit before the next one picks its rows, and parallel batches would hold connections the request path draws from.
		const result = await db.delete(table).where(inArray(primaryKey, doomed));

		// `number | null` in @types/pg because some commands report no count.
		// DELETE always reports one; read it defensively rather than assert.
		const deleted = result.rowCount ?? 0;
		removed += deleted;

		// A short batch means the eligible set is exhausted, so this saves the
		// round trip that would return zero. A batch shortened by `skip locked`
		// instead means a concurrent run holds those rows and will delete them.
		if (deleted < batchSize) {
			return removed;
		}
	}

	process.stderr.write(
		`[sweep] ${getTableName(table)}: stopped after ${maxBatches} batches with rows still eligible. The next run continues where this one left off.\n`
	);

	return removed;
}
