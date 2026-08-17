import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq, inArray } from "drizzle-orm";
import { type JobRegistry, runOnce } from "@/lib/jobs";
import {
	complete,
	enqueue,
	markUnsettled,
	SETTLEMENT_ERROR_PREFIX,
} from "@/lib/jobs.repository";
import { claimUntilFound, skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.settlement"));
}

const WORKER = "test-worker";

/** A second worker id, used wherever a test needs the fence to exclude someone. */
const THIEF = "other-worker";

/** Matches `MAX_ERROR_LENGTH` in `jobs.repository.ts`, the way `jobs.test.ts` mirrors the attempts default. */
const MAX_ERROR_LENGTH = 1000;

/** Ids this suite created, so cleanup only ever removes its own rows. */
const staged: string[] = [];

afterEach(async () => {
	mock.restore();
	if (staged.length > 0) {
		await db.delete(job).where(inArray(job.id, staged.splice(0)));
	}
});

/**
 * Enqueues one row, backdated an hour, and records its id for cleanup.
 *
 * The backdating puts the row ahead of anything a concurrent suite enqueues
 * while this one runs. It does not put it ahead of a row an *interrupted* run
 * left due and pending, which is why `claimed` below drains rather than trusting
 * position.
 */
async function enqueueId(kind = "test.echo"): Promise<string> {
	const { id } = await enqueue({
		kind,
		payload: {},
		runAt: new Date(Date.now() - 3_600_000),
	});
	if (id === null) {
		throw new Error(`expected ${kind} to be enqueued, but it collapsed`);
	}
	staged.push(id);
	return id;
}

/**
 * Enqueues a job and takes it as WORKER.
 *
 * Every settling call starts from here, because both statements are fenced on
 * `status = 'running'` and on the claiming worker's own id — a job that was never
 * claimed cannot be settled by anyone, which is the point of the fence.
 *
 * A batch of one, so no peer's row is ever handed to `runJob`, which has no
 * handler for it and would fail it. `claimUntilFound` then repeats that
 * single-row claim until this row comes back and puts every other row it took
 * back where it found it — the assumption that one claim lands on the oldest row
 * and the oldest row is ours held until a table with 14 due rows left over from
 * an interrupted run failed all five tests here.
 */
async function claimed(): Promise<string> {
	const id = await enqueueId();
	const mine = await claimUntilFound(id, WORKER, 1);
	if (mine === undefined) {
		throw new Error(
			`expected to claim ${id}, but the queue drained without it`
		);
	}
	return id;
}

async function rowFor(id: string) {
	const [found] = await db.select().from(job).where(eq(job.id, id)).limit(1);
	return found;
}

/** Collects the runner's report, keeping the test output clean. */
function captureStderr(): string[] {
	const written: string[] = [];

	spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
		written.push(String(chunk));

		return true;
	}) as typeof process.stderr.write);

	return written;
}

/**
 * Settlement: writing down an outcome that already happened.
 *
 * Split from the lifecycle suite because it is a different question. `jobs.test.ts`
 * asks what the queue does with work that failed; this asks what it does when the
 * work succeeded and the queue could not say so — and the answer must not be the
 * same answer, because an attempt is what a handler spends, not what a pool does.
 */
describe.skipIf(!ready)("job settlement", () => {
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

	it("neither fails nor re-runs a job whose handler finished but whose settlement did not land", async () => {
		const runs: string[] = [];
		const registry: JobRegistry = new Map();

		// Taking the row's lock away from inside the handler is the one way real
		// input makes the fenced settling UPDATE match zero rows, and it lands in
		// exactly the window that matters: after the work, before the queue writes
		// it down. Nothing is mocked — this is an ordinary UPDATE against the test
		// database, which is what the repo's ban on Drizzle doubles leaves.
		registry.set("test.steal", async (_payload, jobId) => {
			runs.push(jobId);
			await db.update(job).set({ lockedBy: THIEF }).where(eq(job.id, jobId));
		});

		const id = await enqueueId("test.steal");
		const reported = captureStderr();

		expect(await runOnce(registry, WORKER, 1)).toBe(1);
		expect(runs).toEqual([id]);

		const row = await rowFor(id);
		// `fail` was not called. An attempt is what a handler spends, and this
		// handler succeeded; a settlement that could not be written down must not
		// cost the job one of its five, nor overwrite a diagnosis with a pool
		// error. `running` is also what keeps a later poll off the row — `claim`
		// only takes `pending` rows — so the handler cannot run a second time on
		// the strength of a settlement that did not happen.
		expect(row?.attempts).toBe(0);
		expect(row?.lastError).toBeNull();
		expect(row?.status).toBe("running");
		expect(row?.lockedBy).toBe(THIEF);
		// Unsettled work is not allowed to be silent: the row is now stuck until
		// plan 011's reaper exists, and a human needs the job id to find it.
		expect(reported.join("")).toContain(id);
		expect(reported.join("")).toContain("no longer owns");
	});
});
