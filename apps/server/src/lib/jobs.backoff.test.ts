import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq, inArray } from "drizzle-orm";
import { fail } from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.backoff"));
}

const WORKER = "test-worker";

/**
 * Mirrors the retry ladder in `jobs.repository.ts`, which keeps both constants
 * private. The rungs below assert the `run_at` a fail actually writes, so
 * moving the ladder has to break this suite — the mirror is the point.
 */
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

/** High enough that walking to the cap never trips the terminal status. */
const MAX_ATTEMPTS = 20;

/**
 * The slack on a backoff assertion, sized like `jobs.test.ts`: far smaller
 * than the 1000ms doubling step and far smaller than the 212s the cap moves,
 * so neither a wrong base nor a missing cap can land inside the band.
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

/**
 * A row already on rung `attempts` of the ladder, in the exact state a worker
 * leaves before `fail` re-arms it.
 *
 * Inserted as `running` and locked rather than claimed, because `claim` is
 * global: it would take whatever else is due and drag other suites' rows into
 * this one. The fence `fail` enforces — the row is running and locked by this
 * worker — is what is under test, so the claim that normally creates that
 * state is not part of the setup.
 */
async function stageRung(attempts: number): Promise<string> {
	const [row] = await db
		.insert(job)
		.values({
			attempts,
			kind: "test.echo",
			lockedAt: new Date(),
			lockedBy: WORKER,
			maxAttempts: MAX_ATTEMPTS,
			payload: {},
			runAt: new Date(Date.now() - 60_000),
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

/** How far in the future a fail scheduled the next attempt, in ms. */
function backoffDeltaMs(row: { runAt: Date } | undefined): number {
	return (row?.runAt.getTime() ?? 0) - Date.now();
}

describe.skipIf(!ready)("retry backoff", () => {
	// `least(base * 2^attempt, max)` binds from attempt 9: 2^9s = 512s already
	// exceeds the 300s ceiling. The `jobs.test.ts` walk cannot see that — its
	// job goes terminal at MAX_ATTEMPTS=5 — so this suite stages one row per
	// rung (attempts 0..10), fails it through the repository's real SQL, and
	// asserts the exact wait: 1s, 2s, 4s, ..., 256s, then 300s as the cap
	// binds at attempt 9 and holds on the next attempt.
	it("doubles each attempt and caps the wait at five minutes", async () => {
		// Each rung owns its own row, so they stage concurrently; the delta is
		// measured next to its own `fail` rather than after the batch, which keeps
		// the drift a single select wide instead of eleven.
		const rungs = await Promise.all(
			Array.from({ length: 11 }, async (_, attempt) => {
				const id = await stageRung(attempt);

				await fail(id, WORKER, new Error("boom"));

				return { attempt, deltaMs: backoffDeltaMs(await rowFor(id)) };
			})
		);

		for (const { attempt, deltaMs } of rungs) {
			const expected = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
			expect(deltaMs).toBeGreaterThanOrEqual(expected - BACKOFF_TOLERANCE_MS);
			expect(deltaMs).toBeLessThanOrEqual(expected + BACKOFF_TOLERANCE_MS);
		}
	});
});
