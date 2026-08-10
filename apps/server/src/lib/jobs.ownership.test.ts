import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq } from "drizzle-orm";
import { claim, complete, enqueue, fail } from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.ownership"));
}

const WORKER = "test-worker";
const BATCH = 10;

async function enqueueId(kind = "test.echo"): Promise<string> {
	const { id } = await enqueue({ kind, payload: {} });
	if (id === null) {
		throw new Error(`expected ${kind} to be enqueued, but it collapsed`);
	}
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
	// `claim` is global by design — a worker takes whatever is due — so the table
	// has to start empty or one test claims another's rows.
	beforeEach(async () => {
		await db.delete(job);
	});

	// The whole point of claiming and locking in one statement: a second worker
	// polling immediately afterwards must see nothing rather than a duplicate.
	it("never hands the same job to a second worker", async () => {
		await enqueueId();

		const first = await claim("worker-a", BATCH);
		const second = await claim("worker-b", BATCH);

		expect(first).toHaveLength(1);
		expect(second).toHaveLength(0);
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
