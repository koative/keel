import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq, inArray } from "drizzle-orm";
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
 * Mirrors the retry ladder in `jobs.repository.ts`, which keeps both constants
 * private. The retry tests assert the actual `run_at` a fail writes, so moving
 * the ladder has to break something here — the mirror is the point.
 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

/**
 * The slack on a backoff assertion. A fail schedules `now + interval`, so the
 * measured gap is the interval plus however long the read-back takes — a few
 * milliseconds on the test DB — and a band far smaller than the 1000ms
 * doubling step cannot be flaky while still keeping a wrong base (2s, 4s, ...)
 * or a missing cap (512s at attempt 9) out of it.
 */
const BACKOFF_TOLERANCE_MS = 750;

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

/** How far in the future a fail scheduled the next attempt, in ms. */
function backoffDeltaMs(row: { runAt: Date } | undefined): number {
	return (row?.runAt.getTime() ?? 0) - Date.now();
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
		// And by how much: the first retry waits `least(1000 * 2^0, 300000)` —
		// one second, not "some time later". Asserted against `Date.now()`
		// because the interval is the whole of the gap; the row's previous
		// value is not a baseline the formula derives from.
		expect(backoffDeltaMs(retrying)).toBeGreaterThanOrEqual(
			BACKOFF_BASE_MS - BACKOFF_TOLERANCE_MS
		);
		expect(backoffDeltaMs(retrying)).toBeLessThanOrEqual(
			BACKOFF_BASE_MS + BACKOFF_TOLERANCE_MS
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

			// The attempt that just ran was `attempt`, so the next one waits
			// `least(1000 * 2^attempt, 300000)` — 2s, 4s, 8s, 16s on this walk.
			const expected = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
			const waited = await rowFor(id);
			expect(backoffDeltaMs(waited)).toBeGreaterThanOrEqual(
				expected - BACKOFF_TOLERANCE_MS
			);
			expect(backoffDeltaMs(waited)).toBeLessThanOrEqual(
				expected + BACKOFF_TOLERANCE_MS
			);
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
});
