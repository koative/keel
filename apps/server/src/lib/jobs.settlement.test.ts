import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq } from "drizzle-orm";
import {
	claim,
	complete,
	enqueue,
	markUnsettled,
	SETTLEMENT_ERROR_PREFIX,
} from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.settlement"));
}

const WORKER = "test-worker";

/** A second worker id, used wherever a test needs the fence to exclude someone. */
const THIEF = "other-worker";
const BATCH = 10;

/** Matches `MAX_ERROR_LENGTH` in `jobs.repository.ts`, the way `jobs.test.ts` mirrors the attempts default. */
const MAX_ERROR_LENGTH = 1000;

async function enqueueId(kind = "test.echo"): Promise<string> {
	const { id } = await enqueue({ kind, payload: {} });
	if (id === null) {
		throw new Error(`expected ${kind} to be enqueued, but it collapsed`);
	}
	return id;
}

/**
 * Enqueues a job and takes it as WORKER.
 *
 * Every settling call starts from here, because both statements are fenced on
 * `status = 'running'` and on the claiming worker's id — a job that was never
 * claimed cannot be settled by anyone, which is the point of the fence.
 */
async function claimed(): Promise<string> {
	const id = await enqueueId();
	await claim(WORKER, BATCH);
	return id;
}

async function rowFor(id: string) {
	const [found] = await db.select().from(job).where(eq(job.id, id)).limit(1);
	return found;
}

afterEach(() => {
	mock.restore();
});

/**
 * Settlement: writing down an outcome that already happened.
 *
 * Split from the lifecycle suite because it is a different question. `jobs.test.ts`
 * asks what the queue does with work that failed; this asks what it does when the
 * work succeeded and the queue could not say so — and the answer must not be the
 * same answer, because an attempt is what a handler spends, not what a pool does.
 */
describe.skipIf(!ready)("job settlement", () => {
	// `claim` is global by design — a worker takes whatever is due — so the table
	// has to start empty or one test claims another's rows.
	beforeEach(async () => {
		await db.delete(job);
	});

	it("reports whether it was the call that settled the job", async () => {
		const id = await claimed();

		expect(await complete(id, WORKER)).toBe(true);
		// Now `done`, so the fence excludes the second call. This is what a retry
		// of a settlement whose acknowledgement was lost looks like, and it is the
		// reason retrying is safe: it reports "not me" rather than settling twice.
		expect(await complete(id, WORKER)).toBe(false);
		expect((await rowFor(id))?.status).toBe("done");
	});

	it("reports false rather than settling a job another worker holds", async () => {
		const id = await claimed();

		expect(await complete(id, THIEF)).toBe(false);
		expect((await rowFor(id))?.status).toBe("running");
	});

	it("records a settlement failure without spending an attempt on it", async () => {
		const id = await claimed();
		const before = await rowFor(id);

		await markUnsettled(id, WORKER, new Error("pool exhausted"));

		const row = await rowFor(id);
		expect(row?.lastError).toBe(`${SETTLEMENT_ERROR_PREFIX}pool exhausted`);
		// The three columns that decide whether this job runs again, all unmoved.
		// The handler already succeeded, so this is not an attempt and not a retry.
		expect(row?.attempts).toBe(0);
		expect(row?.status).toBe("running");
		expect(row?.runAt.getTime()).toBe(before?.runAt.getTime());
		// The lease plan 011's reaper keys off. A diagnostic write must not extend
		// it, or a row nobody will ever settle becomes invisible to the reaper.
		expect(row?.lockedAt?.getTime()).toBe(before?.lockedAt?.getTime());
		expect(row?.lockedBy).toBe(WORKER);
	});

	it("refuses to annotate a row this worker no longer holds", async () => {
		const id = await claimed();

		await markUnsettled(id, THIEF, new Error("pool exhausted"));

		expect((await rowFor(id))?.lastError).toBeNull();
	});

	it("keeps the prefixed error inside the bound a handler error gets", async () => {
		const id = await claimed();

		await markUnsettled(id, WORKER, new Error("x".repeat(50_000)));

		const stored = (await rowFor(id))?.lastError ?? "";
		expect(stored.startsWith(SETTLEMENT_ERROR_PREFIX)).toBe(true);
		expect(stored).toHaveLength(MAX_ERROR_LENGTH);
	});
});
