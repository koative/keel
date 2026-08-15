import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { and, eq, inArray, lt } from "drizzle-orm";
import { sweepSettledJobs } from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.sweep"));
}

/**
 * How far behind the sweep's cutoff this suite stages its old rows, and how
 * far behind it stages the one it expects to keep.
 *
 * The cutoff itself is an hour back from now, the way `jobs.reaper.test.ts`
 * reclaims locks an hour stale: nothing else in the suite run settles a row
 * that old — every row the server and mail suites create is seconds old — so
 * this suite can never sweep a row another suite is still asserting on. The
 * old rows are staged ten minutes before that cutoff, the kept row a minute
 * after it; both derive from the same captured instant, so the sweep's
 * verdict cannot drift with how long the test itself takes.
 */
const CUTOFF_AGE_MS = 60 * 60 * 1000;
const OLD_MS = 10 * 60 * 1000;
const NEW_MS = 60 * 1000;

/**
 * Ids this suite created, so cleanup only ever removes its own rows. The
 * server and mail suites run concurrently against one database, so a full
 * `db.delete(job)` in `beforeEach` would wipe another suite's rows
 * mid-assertion; deleting by id leaves the table as it was found — the swept
 * rows are already gone, and deleting a missing row is a no-op.
 */
const staged: string[] = [];

afterEach(async () => {
	if (staged.length > 0) {
		await db.delete(job).where(inArray(job.id, staged.splice(0)));
	}
});

/**
 * A settled or unsettled row at an explicit age, written directly rather than
 * enqueued-then-settled: the sweep's one filter is `status` and `updated_at`,
 * so the two columns the behavior lives in are the only ones the staging needs
 * to control, and nothing else in this suite has to run to get there.
 */
async function stageRow(
	status: "done" | "failed" | "running" | "pending",
	updatedAt: Date
): Promise<string> {
	const [row] = await db
		.insert(job)
		.values({ kind: "test.echo", payload: {}, status, updatedAt })
		.returning({ id: job.id });

	if (row === undefined) {
		throw new Error("expected the staged job to be inserted");
	}
	staged.push(row.id);
	return row.id;
}

async function rowFor(id: string) {
	const [found] = await db.select().from(job).where(eq(job.id, id)).limit(1);
	return found;
}

/**
 * How many rows the sweep is entitled to remove, counted without it.
 *
 * The sweep's predicate is global — it takes a cutoff and no kind — so a
 * leftover settled row from a crashed run is eligible too, and a literal count
 * could only be made exact by deleting rows this suite did not stage. Counting
 * the eligible set first is exact without that: a sweep that also took the
 * `running` or `pending` row below reports more rows than were eligible, and one
 * that stopped a batch early reports fewer.
 */
async function eligibleFor(cutoff: Date): Promise<number> {
	const rows = await db
		.select({ id: job.id })
		.from(job)
		.where(
			and(inArray(job.status, ["done", "failed"]), lt(job.updatedAt, cutoff))
		);
	return rows.length;
}

describe.skipIf(!ready)("settled job sweep", () => {
	it("drops settled rows past the cutoff and leaves every unsettled row", async () => {
		const cutoff = new Date(Date.now() - CUTOFF_AGE_MS);
		const oldDone = await stageRow("done", new Date(cutoff.getTime() - OLD_MS));
		const oldFailed = await stageRow(
			"failed",
			new Date(cutoff.getTime() - OLD_MS)
		);
		const newDone = await stageRow("done", new Date(cutoff.getTime() + NEW_MS));
		const oldRunning = await stageRow(
			"running",
			new Date(cutoff.getTime() - OLD_MS)
		);
		const oldPending = await stageRow(
			"pending",
			new Date(cutoff.getTime() - OLD_MS)
		);

		const eligible = await eligibleFor(cutoff);
		const removed = await sweepSettledJobs(cutoff);

		expect(removed).toBe(eligible);
		expect(await rowFor(oldDone)).toBeUndefined();
		expect(await rowFor(oldFailed)).toBeUndefined();
		// Newer than the cutoff: the sweep must not read "settled" as
		// "old enough to go".
		expect(await rowFor(newDone)).not.toBeUndefined();
		// Older than the cutoff but not settled: `done`/`failed` are terminal,
		// and removing a `running` row while its worker still owns it is what
		// plan 011's reaper exists to rule out — the sweep must never touch it.
		expect(await rowFor(oldRunning)).not.toBeUndefined();
		expect(await rowFor(oldPending)).not.toBeUndefined();
	});
});
