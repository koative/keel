import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { and, eq, lt } from "drizzle-orm";
import { deleteInBatches } from "@/lib/sweep";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("sweep"));
}

/**
 * `job` is the subject table because it is the one sweep target with no foreign
 * key: a row needs nothing seeded before it. The helper is table-agnostic, so
 * what is under test is the loop, not the queue.
 */
const KIND = "sweep.test";

/** Every seeded row sits either well before this or well after it. */
const CUTOFF = new Date(Date.now() - 60_000);
const OLD = new Date(Date.now() - 3_600_000);

/** The shape a real sweep passes, narrowed to this suite's rows. */
const eligible = and(eq(job.kind, KIND), lt(job.updatedAt, CUTOFF));

async function seed(count: number, updatedAt: Date): Promise<void> {
	await db.insert(job).values(
		Array.from({ length: count }, () => ({
			kind: KIND,
			payload: {},
			status: "done" as const,
			updatedAt,
		}))
	);
}

async function remaining(): Promise<number> {
	const rows = await db
		.select({ id: job.id })
		.from(job)
		.where(eq(job.kind, KIND));
	return rows.length;
}

/** Collects the ceiling notice instead of letting it bleed into test output. */
function captureStderr(): { restore: () => void; written: string[] } {
	const written: string[] = [];
	const spy = spyOn(process.stderr, "write").mockImplementation(((
		chunk: string
	) => {
		written.push(String(chunk));

		return true;
	}) as typeof process.stderr.write);

	return { restore: () => spy.mockRestore(), written };
}

describe.skipIf(!ready)("deleteInBatches", () => {
	// Same reason jobs.test.ts starts empty: the table is shared, and a row left
	// by another suite would be counted by this one.
	beforeEach(async () => {
		await db.delete(job);
	});

	// Five rows at a batch size of two is three statements: 2, 2, then 1. The
	// count has to survive being assembled from them.
	it("removes every eligible row across several batches and counts them all", async () => {
		await seed(5, OLD);

		const removed = await deleteInBatches({
			batchSize: 2,
			primaryKey: job.id,
			table: job,
			where: eligible,
		});

		expect(removed).toBe(5);
		expect(await remaining()).toBe(0);
	});

	// The predicate has to be re-applied by every batch, not just the first.
	it("leaves the rows the predicate excludes", async () => {
		await seed(3, OLD);
		await seed(2, new Date());

		const removed = await deleteInBatches({
			batchSize: 2,
			primaryKey: job.id,
			table: job,
			where: eligible,
		});

		expect(removed).toBe(3);
		expect(await remaining()).toBe(2);
	});

	it("stops at the batch ceiling, says so, and leaves the rest for the next run", async () => {
		await seed(5, OLD);
		const stderr = captureStderr();

		const first = await deleteInBatches({
			batchSize: 2,
			maxBatches: 1,
			primaryKey: job.id,
			table: job,
			where: eligible,
		});
		stderr.restore();

		const second = await deleteInBatches({
			batchSize: 2,
			primaryKey: job.id,
			table: job,
			where: eligible,
		});

		expect(first).toBe(2);
		expect(stderr.written.join("")).toContain("[sweep] job");
		expect(second).toBe(3);
		expect(await remaining()).toBe(0);
	});

	// `and()` is typed to return undefined, so an all-undefined predicate is one
	// typo away from an unfiltered delete of the whole table.
	it("refuses to run without a predicate", async () => {
		await seed(1, OLD);

		await expect(
			deleteInBatches({ primaryKey: job.id, table: job, where: undefined })
		).rejects.toThrow("no predicate");
		expect(await remaining()).toBe(1);
	});
});
