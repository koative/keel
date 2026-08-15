import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq, inArray } from "drizzle-orm";
import {
	claim,
	complete,
	type EnqueueResult,
	enqueue,
	fail,
} from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.dedupe"));
}

const WORKER = "test-worker";
const KIND = "test.echo";

/**
 * Ids this suite created, so cleanup only ever removes its own rows. The server
 * and mail suites run concurrently against one database, so a full
 * `db.delete(job)` would wipe another suite's rows mid-assertion.
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
 * every row a concurrent suite creates — which is what lets the claims below
 * take a batch of one and know which row they got, without touching a peer's.
 */
async function stage(dedupeKey?: string): Promise<EnqueueResult> {
	const result = await enqueue({
		dedupeKey,
		kind: KIND,
		payload: {},
		runAt: new Date(Date.now() - 3_600_000),
	});
	if (result.id !== null) {
		staged.push(result.id);
	}
	return result;
}

async function enqueueId(dedupeKey?: string): Promise<string> {
	const { id } = await stage(dedupeKey);
	if (id === null) {
		throw new Error(`expected ${KIND} to be enqueued, but it collapsed`);
	}
	return id;
}

/** Every row still carrying the key, whatever its status, oldest first. */
async function rowsFor(dedupeKey: string) {
	const rows = await db
		.select()
		.from(job)
		.where(eq(job.dedupeKey, dedupeKey))
		.orderBy(job.createdAt);
	return rows;
}

/**
 * What a dedupe key promises, and for exactly how long.
 *
 * Split from the lifecycle suite because this is one property with one owner —
 * a partial unique index — and the interesting cases are the boundaries of its
 * predicate, not the queue's happy path. The key is held from enqueue until the
 * job is `done` or `failed`; being claimed is not settling.
 */
describe.skipIf(!ready)("job dedupe window", () => {
	it("collapses two pending enqueues of the same dedupe key", async () => {
		const dedupeKey = crypto.randomUUID();

		const first = await stage(dedupeKey);
		const second = await stage(dedupeKey);

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.id).toBeNull();
		expect(await rowsFor(dedupeKey)).toHaveLength(1);
	});

	/**
	 * The window this suite exists for. A claimed job is work in flight, not work
	 * finished: "resend verification" pressed while the first mail is being sent
	 * must collapse into it, and an `ai.generate` row must not be paid for twice.
	 */
	it("collapses an enqueue that arrives while the first job is running", async () => {
		const dedupeKey = crypto.randomUUID();
		const id = await enqueueId(dedupeKey);
		await claim(WORKER, 1);

		const second = await stage(dedupeKey);

		expect(second.created).toBe(false);
		expect(second.id).toBeNull();
		const rows = await rowsFor(dedupeKey);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.id).toBe(id);
		expect(rows[0]?.status).toBe("running");
	});

	/**
	 * `fail` puts a retryable job back to `pending`, so the key is held straight
	 * through the backoff. If it were released here, every transient provider
	 * error would open the duplicate window this suite just closed.
	 */
	it("keeps the key held while a failed attempt waits for its retry", async () => {
		const dedupeKey = crypto.randomUUID();
		const id = await enqueueId(dedupeKey);
		await claim(WORKER, 1);
		await fail(id, WORKER, new Error("boom"));

		const again = await stage(dedupeKey);

		expect((await rowsFor(dedupeKey))[0]?.status).toBe("pending");
		expect(again.created).toBe(false);
		expect(await rowsFor(dedupeKey)).toHaveLength(1);
	});

	// The index stays partial, so the key is a debounce rather than a permanent
	// reservation: the next round of the same work must be enqueueable.
	it("frees the dedupe key once the first job is done", async () => {
		const dedupeKey = crypto.randomUUID();
		const id = await enqueueId(dedupeKey);
		await claim(WORKER, 1);
		await complete(id, WORKER);

		const again = await stage(dedupeKey);

		expect(again.created).toBe(true);
		expect(again.id).not.toBe(id);
	});

	// Postgres treats every null as distinct, which is what makes an unkeyed job
	// "always enqueue" — and what lets the migration retire a legacy duplicate by
	// nulling its key instead of deleting the row.
	it("never collapses two jobs that carry no dedupe key", async () => {
		const first = await enqueueId();
		const second = await enqueueId();

		expect(second).not.toBe(first);
	});
});
