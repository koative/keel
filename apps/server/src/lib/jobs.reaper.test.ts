import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq, inArray } from "drizzle-orm";
import { claim, enqueue, reclaimStrandedJobs } from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.reaper"));
}

/**
 * An hour, against locks backdated two and three. Nothing else in the suite run
 * holds a lock for anywhere near an hour, so this file can never reclaim a row
 * another suite is using — which is why, unlike `jobs.test.ts` and
 * `jobs.ownership.test.ts`, it does not have to empty the table to isolate
 * itself. It cleans up only the ids it created.
 */
const STALE_AFTER_MS = 60 * 60 * 1000;
const hoursAgo = (hours: number) =>
	new Date(Date.now() - hours * 60 * 60 * 1000);

const WORKER = "dead-worker:1";
const BATCH = 100;

/** Matches the column default; the attempt test walks to the last rung. */
const MAX_ATTEMPTS = 5;

const staged: string[] = [];

afterEach(async () => {
	if (staged.length > 0) {
		await db.delete(job).where(inArray(job.id, staged.splice(0)));
	}
});

/**
 * A row in exactly the state a hard-killed worker leaves behind.
 *
 * Inserted rather than enqueued-then-claimed, because `claim` is global: it
 * would take whatever else happens to be due and drag other suites' rows into
 * this one. The post-claim state is what is under test, so it is written
 * directly.
 */
async function strand(input: {
	attempts?: number;
	dedupeKey?: string;
	lockedAt: Date;
}): Promise<string> {
	const [row] = await db
		.insert(job)
		.values({
			attempts: input.attempts ?? 0,
			dedupeKey: input.dedupeKey,
			kind: "test.echo",
			lockedAt: input.lockedAt,
			lockedBy: WORKER,
			payload: {},
			runAt: input.lockedAt,
			status: "running",
		})
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

async function enqueueStaged(dedupeKey: string): Promise<string> {
	const { id } = await enqueue({ dedupeKey, kind: "test.echo", payload: {} });
	if (id === null) {
		throw new Error("expected the replacement job to be enqueued");
	}
	staged.push(id);
	return id;
}

describe.skipIf(!ready)("stranded job reaper", () => {
	it("puts a job back on the queue when its worker never came back", async () => {
		const id = await strand({ lockedAt: hoursAgo(2) });

		const result = await reclaimStrandedJobs(STALE_AFTER_MS);

		// At least, not exactly: the reaper is global like `claim`, and asserting
		// an exact count would make this suite depend on what else is in the table.
		// The row assertions below are what actually pin the behaviour.
		expect(result.requeued).toBeGreaterThanOrEqual(1);

		const row = await rowFor(id);
		expect(row?.status).toBe("pending");
		expect(row?.lockedAt).toBeNull();
		expect(row?.lockedBy).toBeNull();
		// The dead worker is named on the row, because it is the only record that
		// this job was reclaimed rather than retried by its own handler.
		expect(row?.lastError).toContain(WORKER);
	});

	// The threshold is the whole safety argument: reclaiming a row a live worker
	// is still executing is a second email, not a second database write.
	it("leaves a lock younger than the threshold alone", async () => {
		const id = await strand({ lockedAt: new Date() });

		await reclaimStrandedJobs(STALE_AFTER_MS);

		const row = await rowFor(id);
		expect(row?.status).toBe("running");
		expect(row?.lockedBy).toBe(WORKER);
		expect(row?.attempts).toBe(0);
	});

	it("hands a reclaimed job to the next worker that polls", async () => {
		const id = await strand({ lockedAt: hoursAgo(2) });

		await reclaimStrandedJobs(STALE_AFTER_MS);
		const claimed = await claim("live-worker:2", BATCH);

		// Asserted by id rather than by batch length, for the same reason the
		// count above is a lower bound.
		expect(claimed.map((entry) => entry.id)).toContain(id);
		// The id survives the round trip, which is what `ai_usage.job_id` and the
		// provider idempotency key in `mail.send` are both keyed on.
		expect((await rowFor(id))?.status).toBe("running");
	});

	// A reclaim is an attempt. An OOM leaves no `last_error` because nothing
	// catches it, so without this a payload that kills the worker would be
	// reclaimed forever.
	it("spends an attempt on every reclaim", async () => {
		const id = await strand({ attempts: 1, lockedAt: hoursAgo(2) });

		await reclaimStrandedJobs(STALE_AFTER_MS);

		expect((await rowFor(id))?.attempts).toBe(2);
	});

	it("fails a job that strands on its last attempt instead of requeueing it", async () => {
		const id = await strand({
			attempts: MAX_ATTEMPTS - 1,
			lockedAt: hoursAgo(2),
		});

		await reclaimStrandedJobs(STALE_AFTER_MS);

		const row = await rowFor(id);
		expect(row?.status).toBe("failed");
		expect(row?.attempts).toBe(MAX_ATTEMPTS);
		expect(row?.lastError).toContain("no attempts left");
	});

	/**
	 * The trap. The partial index covers `pending` only, so the stranded row left
	 * it when it was claimed and a replacement was accepted behind it. Requeueing
	 * the stranded row naively would put a second `pending` entry with the same
	 * key into a unique index and abort the whole statement.
	 */
	it("collapses a stranded job whose dedupe key a newer pending job holds", async () => {
		const dedupeKey = crypto.randomUUID();
		const stranded = await strand({ dedupeKey, lockedAt: hoursAgo(2) });
		const replacement = await enqueueStaged(dedupeKey);

		await reclaimStrandedJobs(STALE_AFTER_MS);

		const abandoned = await rowFor(stranded);
		expect(abandoned?.status).toBe("failed");
		expect(abandoned?.lastError).toContain("dedupe key");
		// Kept on the settled row: it is out of the partial index anyway, and it
		// is how someone reading the table finds the row that took over.
		expect(abandoned?.dedupeKey).toBe(dedupeKey);

		// The row that will actually do the work is untouched.
		const kept = await rowFor(replacement);
		expect(kept?.status).toBe("pending");
		expect(kept?.attempts).toBe(0);
	});

	// Two workers can both hold a `running` row for one key, because the second
	// enqueue was accepted while the first was in flight. One statement must not
	// requeue both.
	it("requeues the older of two stranded jobs sharing a key and collapses the other", async () => {
		const dedupeKey = crypto.randomUUID();
		const older = await strand({ dedupeKey, lockedAt: hoursAgo(3) });
		const newer = await strand({ dedupeKey, lockedAt: hoursAgo(2) });

		await reclaimStrandedJobs(STALE_AFTER_MS);

		expect((await rowFor(older))?.status).toBe("pending");

		const collapsed = await rowFor(newer);
		expect(collapsed?.status).toBe("failed");
		expect(collapsed?.lastError).toContain("dedupe key");
	});

	/**
	 * The reason the requeue can never raise 23505, even against an `enqueue`
	 * committed a microsecond after the reaper read the table: the row it writes
	 * back to `pending` carries no key, so it creates no index entry at all.
	 */
	it("releases the dedupe key of the job it requeues", async () => {
		const dedupeKey = crypto.randomUUID();
		const id = await strand({ dedupeKey, lockedAt: hoursAgo(2) });

		await reclaimStrandedJobs(STALE_AFTER_MS);

		expect((await rowFor(id))?.dedupeKey).toBeNull();
		// And the key is therefore free, which is what it already was for the two
		// hours this row spent stranded.
		await enqueueStaged(dedupeKey);
	});
});
