import { beforeEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq } from "drizzle-orm";
import { claim, complete, enqueue, fail } from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.dedupe"));
}

const WORKER = "test-worker";
const BATCH = 10;
const KIND = "test.echo";

async function enqueueId(dedupeKey?: string): Promise<string> {
	const { id } = await enqueue({ dedupeKey, kind: KIND, payload: {} });
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
	// `claim` is global by design — a worker takes whatever is due — so the table
	// has to start empty or one test claims another's rows.
	beforeEach(async () => {
		await db.delete(job);
	});

	it("collapses two pending enqueues of the same dedupe key", async () => {
		const dedupeKey = crypto.randomUUID();

		const first = await enqueue({ dedupeKey, kind: KIND, payload: {} });
		const second = await enqueue({ dedupeKey, kind: KIND, payload: {} });

		expect(first.created).toBe(true);
		expect(second.created).toBe(false);
		expect(second.id).toBeNull();
		expect(await claim(WORKER, BATCH)).toHaveLength(1);
	});

	/**
	 * The window this suite exists for. A claimed job is work in flight, not work
	 * finished: "resend verification" pressed while the first mail is being sent
	 * must collapse into it, and an `ai.generate` row must not be paid for twice.
	 */
	it("collapses an enqueue that arrives while the first job is running", async () => {
		const dedupeKey = crypto.randomUUID();
		const id = await enqueueId(dedupeKey);
		await claim(WORKER, BATCH);

		const second = await enqueue({ dedupeKey, kind: KIND, payload: {} });

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
		await claim(WORKER, BATCH);
		await fail(id, WORKER, new Error("boom"));

		const again = await enqueue({ dedupeKey, kind: KIND, payload: {} });

		expect((await rowsFor(dedupeKey))[0]?.status).toBe("pending");
		expect(again.created).toBe(false);
		expect(await rowsFor(dedupeKey)).toHaveLength(1);
	});

	// The index stays partial, so the key is a debounce rather than a permanent
	// reservation: the next round of the same work must be enqueueable.
	it("frees the dedupe key once the first job is done", async () => {
		const dedupeKey = crypto.randomUUID();
		const id = await enqueueId(dedupeKey);
		await claim(WORKER, BATCH);
		await complete(id, WORKER);

		const again = await enqueue({ dedupeKey, kind: KIND, payload: {} });

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
		expect(await claim(WORKER, BATCH)).toHaveLength(2);
	});
});
