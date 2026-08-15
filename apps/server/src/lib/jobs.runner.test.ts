import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq, inArray } from "drizzle-orm";
import { type JobRegistry, runOnce } from "@/lib/jobs";
import { type EnqueueInput, enqueue } from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.runner"));
}

const WORKER = "test-worker";

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

/**
 * Enqueues one row, backdated an hour, and records its id for cleanup.
 *
 * `claim` is global and orders by `run_at`, so an hour-old row sorts ahead of
 * every row a concurrent suite creates. Together with a batch bounded to this
 * suite's own row count that keeps a peer's row out of `runOnce` — this suite's
 * registries hold no handler for other kinds, so a claimed foreign row would be
 * failed: an attempt spent and a `last_error` overwritten in another suite.
 */
async function enqueueId(input: EnqueueInput): Promise<string> {
	const { id } = await enqueue({
		...input,
		runAt: new Date(Date.now() - 3_600_000),
	});
	if (id === null) {
		throw new Error(`expected ${input.kind} to be enqueued, but it collapsed`);
	}
	staged.push(id);
	return id;
}

async function rowFor(id: string) {
	const [found] = await db.select().from(job).where(eq(job.id, id)).limit(1);
	return found;
}

/**
 * What `runOnce` does with the registry it is handed: an unregistered kind and a
 * rejecting handler both have to land as a recorded failure rather than as a
 * thrown loop, because the worker calls this in an unguarded `while`.
 *
 * The queue mechanics those failures are recorded through — the claim fence, the
 * retry ladder, attempt exhaustion — are `jobs.test.ts`.
 */
describe.skipIf(!ready)("job runner", () => {
	it("fails a job of an unknown kind instead of throwing", async () => {
		const id = await enqueueId({ kind: "test.unregistered", payload: {} });

		const processed = await runOnce(new Map(), WORKER, 1);
		const row = await rowFor(id);

		// `runOnce` returned rather than rethrowing the unknown kind, which is
		// what the worker's unguarded `while` depends on. The count is exact
		// because a batch of one can only take the backdated row above.
		expect(processed).toBe(1);
		expect(row?.attempts).toBe(1);
		expect(row?.status).toBe("pending");
		expect(row?.lastError).toContain("test.unregistered");
	});

	it("fails a throwing handler and finishes the rest of the batch", async () => {
		const seen: unknown[] = [];
		const registry: JobRegistry = new Map();
		registry.set("test.boom", () =>
			Promise.reject(new Error("handler exploded"))
		);
		registry.set("test.ok", (payload) => {
			seen.push(payload);
			return Promise.resolve();
		});

		const boomId = await enqueueId({ kind: "test.boom", payload: {} });
		const okId = await enqueueId({ kind: "test.ok", payload: { n: 7 } });

		const processed = await runOnce(registry, WORKER, 2);

		// The throw did not escape the batch: `runOnce` returned, and it returned
		// after running the second job rather than stopping at the first. Both
		// rows are backdated, so a batch of two is exactly them, oldest first.
		expect(processed).toBe(2);
		expect(seen).toEqual([{ n: 7 }]);
		expect((await rowFor(boomId))?.status).toBe("pending");
		expect((await rowFor(boomId))?.lastError).toBe("handler exploded");
		expect((await rowFor(okId))?.status).toBe("done");
	});
});
