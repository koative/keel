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

async function enqueueId(input: EnqueueInput): Promise<string> {
	const { id } = await enqueue(input);
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

		const processed = await runOnce(new Map(), WORKER, BATCH);
		const row = await rowFor(id);

		// A lower bound, not an exact count: `claim` is global, so a concurrent
		// suite's due rows would be processed here too. The row assertions below
		// pin the unknown-kind outcome.
		expect(processed).toBeGreaterThanOrEqual(1);
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

		const processed = await runOnce(registry, WORKER, BATCH);

		// A lower bound for the same reason as the unknown-kind test: the batch is
		// global, and the per-row assertions below pin each outcome.
		expect(processed).toBeGreaterThanOrEqual(2);
		expect(seen).toEqual([{ n: 7 }]);
		expect((await rowFor(boomId))?.status).toBe("pending");
		expect((await rowFor(boomId))?.lastError).toBe("handler exploded");
		expect((await rowFor(okId))?.status).toBe("done");
		// The loop survives the throw: the next pass runs rather than rejecting,
		// and leaves this suite's rows where the first pass put them. No exact
		// count — a concurrent suite's due rows would be claimed here.
		await runOnce(registry, WORKER, BATCH);
		expect((await rowFor(boomId))?.status).toBe("pending");
		expect((await rowFor(okId))?.status).toBe("done");
	});
});
