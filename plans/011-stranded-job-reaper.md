# Stranded Job Reaper Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** CORR-01 (`plans/audit-report.md:111-117`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Ordering:** this is the second of three queue plans — **010 (CORR-02) → 011 (this one) → 016 (TEST-04/05)**. Land `plans/010-*.md` first. 010 separates settlement from execution inside `apps/server/src/lib/jobs.ts`; this plan does not touch that file and must not re-specify that change. The relationship runs the other way: once settlement is separated, a settle that fails on both paths leaves the row `running` with nobody left to move it, and the reaper built here is the net that catches it. 016 extracts the worker loop for testability and comes after both.

**Goal:** Give a `running` job row a way out that does not depend on the process that claimed it still being alive, so a SIGKILL or an OOM costs a retry rather than the work.

**Architecture:** `claim` stamps `locked_at`, `locked_by` and `status = 'running'` in one statement (`apps/server/src/lib/jobs.repository.ts:86-89`), and `locked_at` is then never read again by anything. The only statements that move a row out of `running` are `complete` and `fail`, both fenced on the claiming worker's own id — and the worker id is `hostname():pid` (`apps/server/src/worker.ts:122`), so not even a restarted worker on the same host can settle rows its predecessor left behind. The fix adds one statement, `reclaimStrandedJobs`, that requeues rows whose lock has outlived any legitimate hold, and calls it from `apps/server/src/tasks.ts` beside the existing sweeps. The whole difficulty is in one place: requeueing a row to `pending` re-enters it into the partial unique index on `dedupe_key`, which a newer pending row may already occupy.

**Tech Stack:** Bun, Drizzle ORM (raw `sql` template), PostgreSQL 18, bun:test.

---

## Verified evidence (do not re-litigate)

**CONFIRMED.** A repo-wide grep for `locked_at` / `lockedAt` returns writes and definitions only:

| Site | What it does |
|---|---|
| `apps/server/src/lib/jobs.repository.ts:86` | `claim` writes `locked_at = now()` |
| `apps/server/src/lib/jobs.repository.ts:125` | `complete` writes `lockedAt: null` |
| `apps/server/src/lib/jobs.repository.ts:153` | `fail` writes `locked_at = null` |
| `packages/db/src/schema/job.ts:43` | the column definition |
| `packages/db/src/migrations/0001_organizations_jobs.sql:8`, `0002_zone_aware_timestamps_and_seek_index.sql:24` | DDL |

There is no `WHERE` and no `SELECT` over it anywhere. `locked_by` *is* read, in exactly two places — `jobs.repository.ts:127` and `:167` — and both are the settle fence, not a recovery path.

`sweepSettledJobs` (`jobs.repository.ts:187-195`) deletes `done` and `failed` only, so a stranded `running` row is not even pruned: it sits in the table forever, permanently occupying the `job_status_runAt_idx` partition.

The test suite already names the gap. `apps/server/src/lib/jobs.ownership.test.ts:29-35`:

```ts
/**
 * Exclusivity: who may take a job, and who may settle one.
 *
 * Split from the lifecycle suite because these three cases are one property, and
 * it is the property that decides whether a stuck-job reaper can be added later
 * without turning stalled rows into double execution.
 */
```

### Two corrections to the audit

1. **The audit says "graceful shutdown covers only SIGTERM". That is wrong.** `apps/server/src/worker.ts:209-215` registers both:

   ```ts
   // SIGTERM is what an orchestrator sends; SIGINT is Ctrl-C. Both take the same
   // path so that a local run exercises the production shutdown.
   for (const signal of ["SIGINT", "SIGTERM"] as const) {
   	process.on(signal, () => {
   		shutdown(signal).catch(() => process.exit(1));
   	});
   }
   ```

   Do not go looking for a missing signal handler; there isn't one. The finding survives for a stronger reason: SIGKILL and the OOM killer are uncatchable by construction, and `shutdown` itself calls `process.exit(1)` when the drain overruns `SHUTDOWN_DEADLINE_MS` (`worker.ts:117`, `:177-182`) — abandoning exactly the rows it was trying to protect. No signal handler can close that.

2. **The audit's claim that the dedupe slot is freed on claim is correct, and it is the trap.** `job_dedupeKey_pending_idx` (`packages/db/src/schema/job.ts:71-73`) is unique on `dedupe_key` `WHERE status = 'pending'`. A claimed row is `running`, so it has left the index and a second `enqueue` of the same key is accepted (`packages/db/src/jobs.ts:52-57`). Nothing performs that re-enqueue today, so the audit's "nothing even blocks a re-enqueue that never happens" is accurate — but the moment a reaper exists, that accepted row is a live conflict: requeueing the stranded row would put a second `pending` entry with the same key into a unique index, and the statement would abort. Task 1 solves this rather than noting it.

### One consequence found while designing the fix

`fail` (`jobs.repository.ts:143-170`) sets `status` back to `'pending'` while leaving `dedupe_key` intact, so it has the same exposure: a job that was claimed, had its key re-enqueued behind it, and then threw, will raise `23505` out of `fail`. That rejection propagates out of `runJob` → `runOnce` → the worker loop's catch at `worker.ts:145-152`, which logs `poll failed` and keeps polling — abandoning the failing row *and every remaining row in that batch* in `running`. The reaper built here is a complete net for that path: the conflicting row gets collapsed (a pending duplicate provably exists, since that is the only way the violation can happen) and its batch-mates get requeued. Hardening `fail` itself is deliberately out of scope — see the last section for why it is not a one-liner.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, 16 architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`; comment lines and multi-line template literals do not count — which is why the long `sql` block in Task 1 is free).
- **No environment variable gets a default.** This plan adds no env key at all; Task 2 explains why the threshold is a derived constant instead. If you disagree and add one anyway, it must be required and present in `.env.example`, `apps/server/.env`, `.env.test` **and** `docker-compose.prod.yml`'s `x-app-env` per plan 019 — or `.optional()` and guarded by a `resolve*` that throws naming it.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts`; `tools/check-naming.ts` enforces it. `jobs.reaper.test.ts` passes because `jobs.ts` exists in the same directory and the stem starts with `jobs.`.
- Tests live beside the code, never in `__tests__`. Integration suites gate on `testDbReady()` from `apps/server/test-db.ts` and announce the skip. Never mock Drizzle.
- Anything that can outlive a request runs in `dist/tasks.mjs` or `dist/worker.mjs`, never a `setInterval` in the API.
- The queue's SQL lives in `jobs.repository.ts` and nowhere else. `tasks.ts` already imports `sweepSettledJobs` from it directly (`apps/server/src/tasks.ts:5`); follow that, do not route the reaper through `@/lib/jobs`.

## Do not

- **Do not settle the stranded row and re-enqueue the work as a new row.** It is the obvious way to dodge the unique index and it breaks billing. `ai.generate` guards a repeat charge with `hasUsageForJob(jobId)` against a unique `ai_usage.job_id` (`apps/server/src/worker.ts:66-88`), and `mail.send` passes `jobId` to the provider as an idempotency key (`worker.ts:58-63`). Both depend on the row id being stable across every attempt. A new id is a new charge and a second email.
- **Do not restore the `dedupe_key` on a row you requeue.** The row gave up its collapse slot the moment it was claimed — that is the documented behaviour of the partial index, not an accident. Re-acquiring it would let a repeatedly stranded row block a fresh enqueue of the same work, and it is precisely what makes the requeue able to raise `23505`.
- **Do not make reclaiming free of an attempt.** A payload that reliably OOMs the worker leaves no `last_error`, because nothing catches an OOM. Free reclaims would loop it forever, killing a worker each round. `attempts` is the only poison-job bound this queue has; a reclaim must spend one.
- **Do not pick a round number for the age threshold.** `claim` stamps `locked_at` on the whole batch at once and `runOnce` runs it serially, so the worst legitimate hold is `WORKER_BATCH_SIZE` × the slowest handler's timeout. Task 2 derives it. A threshold shorter than that reclaims rows a live worker is still executing, and the ownership fences make that safe for the *table*, not for the *side effect*.
- **Do not add a `setInterval` to `apps/server/src/index.ts`.** Three replicas would each run it; a scale-to-zero deployment would run it never. `tasks.ts:15-18` already argues this.
- **Do not empty the `job` table in the new suite.** `jobs.test.ts:59-61` and `jobs.ownership.test.ts:39-41` do, and TEST-01 is the finding about it. The new suite stages its own rows with far-backdated locks and asserts by id, so it needs no wipe.
- **Do not add a migration.** `locked_at` already exists and is already `timestamptz` (`0002_zone_aware_timestamps_and_seek_index.sql:24`). Nothing in this plan changes the schema, so `check-migrations` must stay silent.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/jobs.repository.ts` | **Modify.** Add `reclaimStrandedJobs`, the one statement that can move a row out of `running` without the claiming worker. |
| `apps/server/src/lib/jobs.reaper.test.ts` | **Create.** Integration suite: stale is reclaimed, fresh is not, reclaimed is claimable, attempts are spent, and every dedupe-index case. |
| `apps/server/src/tasks.ts` | **Modify.** Derive the threshold from `WORKER_BATCH_SIZE` and the slowest handler timeout, call the reaper, report it. |

---

### Task 1: `reclaimStrandedJobs`, and the index conflict it must survive

**Files:**
- Create: `apps/server/src/lib/jobs.reaper.test.ts`
- Modify: `apps/server/src/lib/jobs.repository.ts:195` (append after `sweepSettledJobs`)

**Interfaces:**
- Consumes: `job` from `@keel/db/schema/job`, `db` from `@keel/db`, `enqueue` and `claim` from this same module — all already imported or exported there.
- Produces: `export interface ReclaimedJobs { collapsed: number; exhausted: number; requeued: number }` and `export async function reclaimStrandedJobs(staleAfterMs: number): Promise<ReclaimedJobs>`. Task 2 imports both names from `@/lib/jobs.repository`.

- [x] **Step 1: Write the failing test**

Create `apps/server/src/lib/jobs.reaper.test.ts`:

```ts
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
```

- [x] **Step 2: Run it and watch it fail for the right reason**

```bash
bun run db:test:start && bun run db:test:migrate
cd apps/server && bun test src/lib/jobs.reaper.test.ts
```

Expected: the file fails to resolve — `SyntaxError: Export named 'reclaimStrandedJobs' not found in module '.../apps/server/src/lib/jobs.repository.ts'`. If instead you see `[skip] jobs.reaper needs the test database`, the test Postgres is not up; start it and rerun. Any other failure means Step 1 was mistyped.

- [x] **Step 3: Write the statement**

Append to `apps/server/src/lib/jobs.repository.ts`, after `sweepSettledJobs`:

```ts
export interface ReclaimedJobs {
	/** Stranded rows whose work a newer pending row already covers. */
	collapsed: number;
	/** Stranded rows that spent their last attempt and are now `failed`. */
	exhausted: number;
	/** Stranded rows put back on the queue. */
	requeued: number;
}

/**
 * Takes back rows a worker claimed and never settled, and reports what happened
 * to them.
 *
 * `claim` is the only writer of `locked_at`, and until this function existed
 * nothing read it: the sole way out of `running` was the claiming worker's own
 * `complete` or `fail`, both fenced on `locked_by`. The worker id is
 * `hostname():pid`, so a restarted worker gets a new pid and cannot settle its
 * predecessor's rows either. A SIGKILL or an OOM therefore turned at-least-once
 * delivery into at-most-once, silently and permanently — `sweepSettledJobs`
 * does not even prune `running`, so the row stayed in the claim index forever.
 *
 * `staleAfterMs` is the caller's, not this module's, because the honest value
 * depends on `WORKER_BATCH_SIZE` — `tasks.ts` derives it and says why there.
 *
 * ## The dedupe index
 *
 * `job_dedupeKey_pending_idx` is unique on `dedupe_key` where `status =
 * 'pending'`. A claimed row is `running`, so it has already left that index and
 * a second `enqueue` of its key was accepted while it ran. Putting the stranded
 * row back to `pending` would then be a second entry for one key, and the
 * violation would abort the whole batch — one poisoned row costing every other
 * row its recovery.
 *
 * Two independent things stop that, and both are needed.
 *
 * Policy: a row is only requeued when no `pending` row already holds its key,
 * and when it is the oldest lock among the stranded rows that share it.
 * Otherwise the work is already covered, so the row is settled `failed` with the
 * reason on it rather than duplicated.
 *
 * Safety: a requeued row is written back with `dedupe_key = null`, so it creates
 * no index entry and the statement cannot raise 23505 even against an `enqueue`
 * that commits between the policy read and this write. That is not a loss — the
 * row released its collapse slot when it was claimed, and a reclaim restores the
 * attempt, not the claim. Rows that stay settled keep their key, because a
 * `failed` row is outside the index anyway and the key is how someone reading
 * the table finds the row that took over.
 *
 * `for update skip locked` mirrors `claim`: a concurrent reaper takes a disjoint
 * set instead of blocking, and a row a live worker is mid-settle on is stepped
 * over rather than fought with. The repeated `status = 'running'` on the update
 * itself is the recheck that makes a lost race a no-op rather than a second
 * attempt increment.
 */
export async function reclaimStrandedJobs(
	staleAfterMs: number
): Promise<ReclaimedJobs> {
	const reclaimed = await db.execute(sql`
		with stale as materialized (
			select ${job.id} as id from ${job}
			where ${job.status} = 'running'
				and ${job.lockedAt} < now() - make_interval(
					secs => ${staleAfterMs}::bigint / 1000.0
				)
			for update skip locked
		),
		ranked as (
			select
				j.id as id,
				j.dedupe_key as dedupe_key,
				row_number() over (
					partition by j.dedupe_key order by j.locked_at, j.id
				) as slot
			from ${job} j
			join stale on stale.id = j.id
		),
		decided as (
			select
				r.id as id,
				(
					r.dedupe_key is null
					or (
						r.slot = 1
						and not exists (
							select 1 from ${job} p
							where p.dedupe_key = r.dedupe_key
								and p.status = 'pending'
						)
					)
				) as requeue
			from ranked r
		)
		update ${job}
		set
			attempts = ${job.attempts} + 1,
			dedupe_key = case when d.requeue then null else ${job.dedupeKey} end,
			last_error = 'stranded: worker '
				|| coalesce(${job.lockedBy}, 'unknown')
				|| ' stopped without settling this job'
				|| case
					when not d.requeue
						then '; a newer pending job holds its dedupe key'
					when ${job.attempts} + 1 >= ${job.maxAttempts}
						then '; no attempts left'
					else ''
				end,
			locked_at = null,
			locked_by = null,
			run_at = now(),
			status = case
				when not d.requeue then 'failed'
				when ${job.attempts} + 1 >= ${job.maxAttempts} then 'failed'
				else 'pending'
			end,
			updated_at = now()
		from decided d
		where ${job.id} = d.id and ${job.status} = 'running'
		returning ${job.id}, ${job.status}, d.requeue
	`);

	// Read out of the returned rows rather than counted with three statements:
	// the outcome per row is decided inside the update, and asking the table
	// again afterwards would be asking a different snapshot.
	let collapsed = 0;
	let exhausted = 0;
	let requeued = 0;
	for (const row of reclaimed.rows) {
		if (row.requeue !== true) {
			collapsed += 1;
		} else if (row.status === "failed") {
			exhausted += 1;
		} else {
			requeued += 1;
		}
	}

	return { collapsed, exhausted, requeued };
}
```

Two details that are easy to get wrong and will not fail loudly:

- `run_at = now()`, not the backoff ladder `fail` uses. The row has already waited out `staleAfterMs`, which is longer than `BACKOFF_MAX_MS` at any sane threshold, so a rung on top would be delay for its own sake.
- `${job.attempts}`, `${job.lockedBy}` and `${job.dedupeKey}` on the right of `set` read the **old** row values. That is standard `UPDATE` semantics and is what `fail` at `jobs.repository.ts:148-165` already relies on.

- [x] **Step 4: Run the test and watch it pass**

```bash
cd apps/server && bun test src/lib/jobs.reaper.test.ts
```

Expected: `8 pass, 0 fail`. If instead you get `duplicate key value violates unique constraint "job_dedupeKey_pending_idx"`, the `dedupe_key = case ... end` line is missing or inverted — that error is the exact failure this design exists to make impossible.

- [x] **Step 5: Prove the whole gate is green**

```bash
bun run check
```

Expected: every turbo task successful; `check-naming` reports one more suite than the run before this task and no violations; 16 architecture rules verified; `check-migrations` reports migrations match, because no schema changed.

- [x] **Step 6: Commit**

```bash
git add apps/server/src/lib/jobs.repository.ts apps/server/src/lib/jobs.reaper.test.ts
git commit -m "feat(queue): reclaim jobs a killed worker never settled

\`claim\` writes \`locked_at\` and nothing has ever read it. The only statements
that move a row out of \`running\` are \`complete\` and \`fail\`, both fenced on
\`locked_by\`, and the worker id is \`hostname():pid\` — so a restarted worker gets
a new pid and cannot settle its predecessor's rows either. SIGKILL, the OOM
killer and the shutdown deadline's own \`exit(1)\` are all uncatchable by
construction, and each of them turned at-least-once delivery into at-most-once,
permanently: \`sweepSettledJobs\` prunes \`done\` and \`failed\`, so the row was not
even cleaned up. \`jobs.ownership.test.ts\` named this gap when it was written.

The interesting part is not the requeue, it is the partial unique index. A
claimed row has already left \`job_dedupeKey_pending_idx\`, so a second enqueue of
its key was accepted while it ran; requeueing it naively is a second \`pending\`
entry for one key, and the violation would abort the batch and cost every other
stranded row its recovery. Two things answer that. A row is requeued only when
no pending row holds its key and it is the oldest lock among the stranded rows
sharing it — otherwise the work is covered, and it settles \`failed\` saying so.
And a requeued row is written back with a null \`dedupe_key\`, so it creates no
index entry and cannot collide with an enqueue that commits a microsecond later.
Releasing the key costs nothing the row still had: it gave up its collapse slot
when it was claimed, and a reclaim restores the attempt, not the claim.

A reclaim spends an attempt. An OOM leaves no \`last_error\` because nothing
catches it, so a free reclaim would loop a killing payload forever; \`attempts\` is
the only poison bound this queue has.

Eight integration cases: stale is taken back, fresh is not, a reclaimed row is
claimable again under the same id, the attempt is spent, the last attempt fails
instead of requeueing, a newer pending duplicate collapses the stranded row, two
stranded rows sharing a key yield exactly one requeue, and the requeued row's key
is free afterwards. The suite stages its own rows with locks backdated hours and
asserts by id, so unlike its neighbours it never empties the table."
```

---

### Task 2: Run it from `dist/tasks.mjs`, on a threshold that is derived

**Files:**
- Modify: `apps/server/src/tasks.ts:1-6` (imports), `:49` (after the last retention constant), `:68-74` (the call and the report)

**Interfaces:**
- Consumes: `reclaimStrandedJobs` and `ReclaimedJobs` from Task 1; `env.WORKER_BATCH_SIZE` from `@keel/env/server` (`packages/env/src/server.ts:225`).
- Produces: nothing other code imports. `tasks.ts` is an entrypoint.

- [x] **Step 1: Settle the threshold before writing it**

Do the arithmetic yourself so the constant is defensible rather than inherited:

| Input | Value | Source |
|---|---|---|
| Slowest single handler | 120_000 ms | `packages/ai/src/generate.ts:17` — `DEFAULT_TIMEOUT_MS`, the `AbortSignal.timeout` on every `ai.generate` call |
| Next slowest | 8_000 ms | `RESEND_TIMEOUT_MS`, added by plan 004 to `packages/mail/src/send.ts`. Below the AI ceiling, so it does not move the number |
| Jobs per lock | `WORKER_BATCH_SIZE` | `claim` stamps `locked_at` once for the whole batch (`jobs.repository.ts:85-89`) and `runOnce` runs it serially (`jobs.ts:50-53`), so the last row in a batch legitimately holds its lock for the sum of everything ahead of it |
| Documented batch | 10 | `.env.example:115`, `apps/server/.env:18`, `.env.test:45` |

Worst honest hold at the documented batch: `10 × 120_000 = 1_200_000 ms`. Add `300_000 ms` for the claim round trip, a pool wait before a handler starts, and the 10 s a killed worker may have burned inside `shutdown` (`worker.ts:117`). **25 minutes.**

Read the batch size at runtime rather than hard-coding 25 minutes: a deployment that raises `WORKER_BATCH_SIZE` raises its own worst-case lock hold, and the threshold must move with it or the reaper starts reclaiming live work.

It is a constant and not an env key, deliberately. The value is not a deployment preference — it is a function of two timeouts that live in this repository, so a handler slower than 120 s must move this number in the same commit that adds it, where a reviewer can see both. The three retention windows beside it are constants for the same reason. And the repo's env rule has real weight: a new required key means `.env.example`, `apps/server/.env`, `.env.test` and `docker-compose.prod.yml`'s `x-app-env` (plan 019 owns that list), all to make a derived number overridable by someone with less information than the source has.

- [x] **Step 2: Add the import and the constants**

In `apps/server/src/tasks.ts`, the import block becomes:

```ts
import { closePool, db } from "@keel/db";
import { rateLimit } from "@keel/db/schema/auth";
import { env } from "@keel/env/server";
import { lt } from "drizzle-orm";
import { sweepExpiredKeys } from "@/lib/idempotency.repository";
import { reclaimStrandedJobs, sweepSettledJobs } from "@/lib/jobs.repository";
import { sweepIdleBuckets } from "@/lib/rate-limit";
```

Then, immediately after `SETTLED_JOB_RETENTION_MS` (currently `apps/server/src/tasks.ts:49`):

```ts
/**
 * The ceiling on one job, and the reason the reaper's threshold is derived from
 * the batch size instead of chosen.
 *
 * `ai.generate` aborts at `DEFAULT_TIMEOUT_MS` in `packages/ai/src/generate.ts`
 * and `mail.send` aborts well before it, so 120s is what one job can honestly
 * cost. A handler slower than this must raise this constant in the same commit,
 * because a reaper that fires early does not corrupt the table — the ownership
 * fences see to that — it sends a second email.
 */
const SLOWEST_HANDLER_MS = 120_000;

/**
 * On top of the batch: the claim round trip, a pool wait before a handler
 * starts, and the ten seconds a hard-killed worker may already have spent inside
 * its drain deadline.
 */
const RECLAIM_MARGIN_MS = 5 * 60 * 1000;

/**
 * How long a `running` row may hold its lock before another process may take it
 * back.
 *
 * `claim` stamps `locked_at` on the whole batch in one statement and `runOnce`
 * runs that batch one job at a time, so the last row in a batch waits out every
 * job ahead of it before its own handler even starts. The worst legitimate hold
 * is therefore the batch size times the slowest handler — read from the
 * environment, because a deployment that widens the batch widens exactly this.
 *
 * At the documented `WORKER_BATCH_SIZE=10` that is 25 minutes. Not an env key:
 * this is arithmetic over two timeouts that live in this repository, not a
 * deployment decision, and the three retention windows above it are constants
 * for the same reason.
 */
const STRANDED_JOB_TIMEOUT_MS =
	env.WORKER_BATCH_SIZE * SLOWEST_HANDLER_MS + RECLAIM_MARGIN_MS;
```

- [x] **Step 3: Call it and report it**

Replace the `settledJobs` assignment and the `process.stdout.write` that follows (currently `apps/server/src/tasks.ts:68-74`):

```ts
const settledJobs = await sweepSettledJobs(
	new Date(Date.now() - SETTLED_JOB_RETENTION_MS)
);

/**
 * Last, and here rather than in the worker: a worker cannot recover the rows it
 * lost by dying, and a `setInterval` in the API would run once per replica and
 * never at all under scale-to-zero — the same argument the header makes for the
 * sweeps. Overlapping runs stay harmless because the statement skips locked rows
 * and rechecks `status = 'running'` on the row it writes.
 */
const strandedJobs = await reclaimStrandedJobs(STRANDED_JOB_TIMEOUT_MS);

process.stdout.write(
	`[tasks] swept ${expiredKeys} idempotency key(s), ${staleCounters.length} auth rate-limit counter(s), ${idleBuckets} idle token bucket(s), ${settledJobs} settled job(s); requeued ${strandedJobs.requeued} stranded job(s), collapsed ${strandedJobs.collapsed}, exhausted ${strandedJobs.exhausted}\n`
);
```

- [x] **Step 4: Run the entrypoint against an empty dev database**

```bash
bun run db:start
cd apps/server && bun src/tasks.ts
```

Expected, with the counts before the semicolon depending on what is in your dev database:

```
[tasks] swept 0 idempotency key(s), 0 auth rate-limit counter(s), 0 idle token bucket(s), 0 settled job(s); requeued 0 stranded job(s), collapsed 0, exhausted 0
```

The process must exit immediately rather than hanging for thirty seconds — `closePool()` at the end of the file is what makes that true, and the reaper must not have been added after it.

- [x] **Step 5: Run it against a row that is actually stranded**

Stage one directly in the dev database, so the proof is the entrypoint and not the suite:

```bash
docker compose exec -T postgres psql -U postgres -d keel -c "insert into job (id, kind, payload, status, locked_at, locked_by, run_at) values ('reaper-smoke', 'test.echo', '{}', 'running', now() - interval '3 hours', 'dead-worker:1', now() - interval '3 hours')"
```

```bash
cd apps/server && bun src/tasks.ts
```

Expected: the line now ends `requeued 1 stranded job(s), collapsed 0, exhausted 0`. Confirm the row, then remove it:

```bash
docker compose exec -T postgres psql -U postgres -d keel -c "select status, attempts, locked_by, last_error from job where id = 'reaper-smoke'"
docker compose exec -T postgres psql -U postgres -d keel -c "delete from job where id = 'reaper-smoke'"
```

Expected from the select: `pending | 1 | <null> | stranded: worker dead-worker:1 stopped without settling this job`.

- [x] **Step 6: Prove the whole gate is green**

```bash
bun run check
```

Expected: every turbo task successful, no naming violations, 16 architecture rules verified, migrations match.

- [x] **Step 7: Commit**

```bash
git add apps/server/src/tasks.ts
git commit -m "feat(tasks): run the job reaper on a derived threshold

The reaper belongs beside the sweeps for the reason the file already argues: a
\`setInterval\` in the API runs once per replica and never under scale-to-zero,
and a worker cannot recover the rows it lost by dying.

The threshold is derived, not chosen. \`claim\` stamps \`locked_at\` on the whole
batch in one statement and \`runOnce\` runs that batch serially, so the last row
in a batch legitimately holds its lock for the sum of every job ahead of it. One
job's ceiling is the slowest handler's own timeout — 120s for \`ai.generate\`,
8s for \`mail.send\` — so the worst honest hold is WORKER_BATCH_SIZE x 120s, read
from the environment rather than assumed, plus five minutes for the claim, a
pool wait and the drain deadline a killed worker may have burned. Twenty-five
minutes at the documented batch of ten, and it moves on its own if a deployment
widens the batch, which is the same knob that widens the hold.

A constant rather than an env key: it is arithmetic over two timeouts that live
in this repository, so a slower handler has to move it in the same commit where
a reviewer can see both. Making it configurable would hand the decision to
someone with less information than the source has, and cost four files to do it.

Verified by running dist/tasks.mjs's source against a real database with a row
backdated three hours: requeued 1, left \`pending\` with one attempt spent, the
dead worker named in last_error, and the process still exits immediately."
```

---

## Done when

- A row in `status = 'running'` whose `locked_at` is older than `WORKER_BATCH_SIZE × 120s + 5min` is back in `pending`, claimable by any worker, with `locked_at` and `locked_by` null, one more attempt spent, and the dead worker's id readable in `last_error`.
- A row whose lock is younger than that threshold is untouched, including its `attempts`.
- A reclaimed row keeps its `id`, so `ai_usage.job_id` and the `mail.send` provider idempotency key still suppress a repeat side effect.
- **Reconciled with plan 024 (landed after this plan):** the dedupe index now covers `running` as well as `pending`, so a claimed row holds its key through the whole in-flight window. A stranded row can no longer share a key with a `pending` replacement — the state this plan's collapse branch defended cannot be constructed — so the reaper requeues every stranded row and **keeps the key on the requeued row**, holding it until the retry settles, exactly as `fail` does. The collapse branch and the `collapsed` report count were removed; the reaper suite proves a reclaimed row's key stays held and that two unsettled rows sharing a key cannot be staged.
- A stranded row on its last attempt ends `failed`, not `pending`.
- `bun src/tasks.ts` reports the two reaper counts (requeued, exhausted) on its existing line and still exits without waiting out the pool's idle timeout.
- `bun run check` passes, with no new migration and no new environment variable.

## Out of scope

- **Separating settlement from execution** — plan 010 (CORR-02), which lands first and owns `apps/server/src/lib/jobs.ts`. This plan does not touch that file.
- **Making the worker loop testable** — plan 016 (TEST-04/05), which lands last.
- **The Resend fetch timeout** — plan 004 (PERF-01). This plan only reads its constant to bound the threshold; if 004 lands with a value above 120_000 ms, `SLOWEST_HANDLER_MS` in `tasks.ts` must be raised to match it, and that belongs in whichever of the two lands second.
- **Hardening `fail` against the same index conflict.** It is real — `fail` returns a row to `pending` with its `dedupe_key` intact, so it can raise `23505` and strand the row plus the rest of its batch — but it is not a one-line fix and it is not this finding. Clearing the key there would break the debounce that `enqueueMail` depends on (`packages/mail/src/queue.ts:19-31`: "resend verification" pressed three times must stay one email while the job is retrying), and collapsing on a read-then-write would leave the same narrow race the reaper closes with a null. Meanwhile the reaper is a complete net for it: the violation can only occur when a `pending` duplicate exists, which is exactly the case the reaper collapses, and the abandoned batch-mates are exactly the case it requeues. Worth its own finding and its own argument.
- **The `job` table wipe in `jobs.test.ts:59-61` and `jobs.ownership.test.ts:39-41`** — TEST-01. The new suite is written so it needs no wipe and adds nothing to that finding.
- **Doc counts.** `bun run check` will report one more suite than `README.md` and `AGENTS.md` currently imply. Plan 021 owns those numbers; do not edit either file here.
