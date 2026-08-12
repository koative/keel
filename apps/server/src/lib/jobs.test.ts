import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq, inArray } from "drizzle-orm";
import { type JobRegistry, runOnce } from "@/lib/jobs";
import { claim, type EnqueueInput, enqueue, fail } from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs"));
}

const WORKER = "test-worker";
const BATCH = 10;

/** Matches the column default; the retry test walks the whole ladder. */
const MAX_ATTEMPTS = 5;

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
 * Claims the job, then fails it as its owner.
 *
 * `fail` and `complete` are fenced on `status = 'running'` and on the claiming
 * worker's id, so a job cannot be settled without first being taken — which is
 * the point of the fence and also what a worker actually does. Backdating `run_at`
 * first is how a test walks the retry ladder without waiting out the backoff.
 */
async function claimThenFail(id: string, error: unknown): Promise<void> {
	await db
		.update(job)
		.set({ runAt: new Date(Date.now() - 60_000) })
		.where(eq(job.id, id));
	await claim(WORKER, BATCH);
	await fail(id, WORKER, error);
}

describe.skipIf(!ready)("job queue", () => {
	// `claim` is global by design — a worker takes whatever is due, and rows a
	// concurrent suite created are claimable here. Cleanup is therefore scoped to
	// the ids this suite created; wiping the table in `beforeEach` would delete
	// another suite's rows mid-assertion when the server and mail suites run
	// against one database.

	it("hands an enqueued job to the first worker that claims", async () => {
		const id = await enqueueId({ kind: "test.echo", payload: { n: 1 } });

		const claimed = await claim(WORKER, BATCH);
		const mine = claimed.find((entry) => entry.id === id);

		// By id, not batch length: `claim` is global, so a concurrent suite's due
		// rows can land in the same batch.
		expect(mine?.id).toBe(id);
		expect(mine?.kind).toBe("test.echo");
		expect(mine?.payload).toEqual({ n: 1 });
		expect(mine?.attempts).toBe(0);
		expect(mine?.maxAttempts).toBe(MAX_ATTEMPTS);
	});

	it("retries with a later runAt and stops at maxAttempts", async () => {
		const id = await enqueueId({ kind: "test.echo", payload: {} });
		const before = await rowFor(id);

		await claimThenFail(id, new Error("boom"));
		const retrying = await rowFor(id);

		expect(retrying?.attempts).toBe(1);
		expect(retrying?.status).toBe("pending");
		expect(retrying?.lastError).toBe("boom");
		// Compared against the row's own previous value, both read back through
		// the same driver, so the assertion does not depend on the test process
		// and Postgres sharing a timezone.
		expect(retrying?.runAt.getTime()).toBeGreaterThan(
			before?.runAt.getTime() ?? 0
		);
		// The backoff is only useful if it actually keeps the job out of a poll.
		// Asserted by id: the batch is global, so an empty result would only mean
		// nothing else was due at that instant.
		expect((await claim(WORKER, BATCH)).map((entry) => entry.id)).not.toContain(
			id
		);

		for (let attempt = 1; attempt < MAX_ATTEMPTS; attempt += 1) {
			// biome-ignore lint/performance/noAwaitInLoops: each fail derives the next backoff from the attempt count the previous one wrote, so overlapping calls would never walk the ladder this test asserts.
			await claimThenFail(id, new Error("boom"));
		}
		const terminal = await rowFor(id);

		expect(terminal?.attempts).toBe(MAX_ATTEMPTS);
		expect(terminal?.status).toBe("failed");
	});

	it("never claims a job that has exhausted its attempts", async () => {
		const id = await enqueueId({ kind: "test.echo", payload: {} });
		for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
			// biome-ignore lint/performance/noAwaitInLoops: overlapping fails would read the same attempt count and leave the job short of exhausted, so the exclusion this test asserts would never happen.
			await claimThenFail(id, new Error("boom"));
		}

		// Backdated so that only the terminal status can be what excludes it.
		await db
			.update(job)
			.set({ runAt: new Date(Date.now() - 60_000) })
			.where(eq(job.id, id));

		// By id, not an empty batch: a concurrent suite's due rows would be
		// claimed, and only this exhausted row must stay put.
		expect((await claim(WORKER, BATCH)).map((entry) => entry.id)).not.toContain(
			id
		);
	});

	it("truncates a huge error rather than storing it whole", async () => {
		const id = await enqueueId({ kind: "test.echo", payload: {} });

		await claimThenFail(id, new Error("x".repeat(50_000)));

		expect((await rowFor(id))?.lastError?.length).toBeLessThan(50_000);
	});

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
