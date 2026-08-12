import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq, inArray } from "drizzle-orm";
import { claim, complete, enqueue, fail } from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.ownership"));
}

const WORKER = "test-worker";
const BATCH = 10;

/**
 * Ids this suite created, so cleanup only ever removes its own rows. The
 * server and mail suites run concurrently against one database, so a full
 * `db.delete(job)` in `beforeEach` would wipe another suite's rows
 * mid-assertion; deleting by id leaves the table as it was found.
 */
const staged: string[] = [];

afterEach(async () => {
	if (staged.length > 0) {
		await db.delete(job).where(inArray(job.id, staged.splice(0)));
	}
});

async function enqueueId(kind = "test.echo"): Promise<string> {
	const { id } = await enqueue({ kind, payload: {} });
	if (id === null) {
		throw new Error(`expected ${kind} to be enqueued, but it collapsed`);
	}
	staged.push(id);
	return id;
}

async function rowFor(id: string) {
	const [found] = await db.select().from(job).where(eq(job.id, id)).limit(1);
	return found;
}

/**
 * Exclusivity: who may take a job, and who may settle one.
 *
 * Split from the lifecycle suite because these three cases are one property, and
 * it is the property that decides whether a stuck-job reaper can be added later
 * without turning stalled rows into double execution.
 */
describe.skipIf(!ready)("job ownership", () => {
	// `claim` is global by design — a worker takes whatever is due, and rows a
	// concurrent suite created are claimable here. Cleanup is scoped to the ids
	// this suite created; wiping the table in `beforeEach` would delete another
	// suite's rows mid-assertion when the server and mail suites run against one
	// database.

	// The whole point of claiming and locking in one statement: a second worker
	// polling immediately afterwards must see nothing rather than a duplicate.
	it("never hands the same job to a second worker", async () => {
		const id = await enqueueId();

		const first = await claim("worker-a", BATCH);
		const second = await claim("worker-b", BATCH);

		// By id, not batch length: `claim` is global, so a concurrent suite's due
		// rows can share the batch. The property is that the second worker never
		// sees this job.
		expect(first.map((entry) => entry.id)).toContain(id);
		expect(second.map((entry) => entry.id)).not.toContain(id);
	});

	/**
	 * Settling is keyed on the claiming worker, so a slow original worker finishing
	 * after something else reclaimed its job cannot mark done work the new owner is
	 * still running.
	 */
	it("refuses to let a worker settle a job it does not own", async () => {
		const id = await enqueueId();
		await claim(WORKER, BATCH);

		await complete(id, "some-other-worker");
		expect((await rowFor(id))?.status).toBe("running");

		await fail(id, "some-other-worker", new Error("boom"));
		const untouched = await rowFor(id);
		expect(untouched?.status).toBe("running");
		expect(untouched?.attempts).toBe(0);

		// The owner still can.
		await complete(id, WORKER);
		expect((await rowFor(id))?.status).toBe("done");
	});

	/** A settled row must stay settled: `fail` may not re-arm it. */
	it("refuses to resurrect a job that has already finished", async () => {
		const id = await enqueueId();
		await claim(WORKER, BATCH);
		await complete(id, WORKER);

		await fail(id, WORKER, new Error("late"));

		const row = await rowFor(id);
		expect(row?.status).toBe("done");
		expect(row?.attempts).toBe(0);
	});
});
