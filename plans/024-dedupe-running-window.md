# Dedupe Across the Running Window Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** CORR-08 (`plans/audit-report.md:167-173`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Depends on:** plan 011 (CORR-01, the stuck-job reaper). Land 011 first. This plan makes a `running` row hold its dedupe key, and today nothing ever moves a row out of `running` except the worker that owns it — so a worker killed mid-handler would burn that key permanently. 011's reaper is what bounds that window. This plan does not re-specify the reaper and does not edit the files 010, 011 or 016 own.

**Goal:** Make `dedupe_key` exclusive for as long as the work is in flight — from enqueue until the job is `done` or `failed` — instead of releasing it the instant a worker claims the row.

**Architecture:** One partial unique index is the whole mechanism. `packages/db/src/schema/job.ts:71-73` restricts it to `status = 'pending'`, and `claim` (`apps/server/src/lib/jobs.repository.ts:84-89`) sets `status = 'running'` in the same statement that takes the row — so the row leaves the index at the exact moment the work starts, and a second enqueue of the same key inserts a row that runs concurrently with the first. The fix widens the predicate to the two unsettled statuses and renames the index to match, then repeats the wider predicate as `enqueue`'s conflict target. Nothing in `jobs.repository.ts` changes: the transitions that matter (`pending → running`, `running → pending`, `running → done|failed`) either keep the row's index entry unchanged or drop it, and none of them can collide.

**Tech Stack:** PostgreSQL partial unique indexes, Drizzle ORM `pgTable` / `onConflictDoNothing`, drizzle-kit `generate`, bun:test.

---

## Verified evidence (do not re-litigate)

**Lead with this: it is a documented, deliberate tradeoff, not an undiscovered defect.** The audit calls it a defect; the source calls it the design. Both are half right, and the executing engineer needs to know which half.

1. **The narrow predicate is deliberate and explained.** `packages/db/src/schema/job.ts:59-73` spends fourteen lines on it:

   > ```
   > // Partial on purpose, and this is the load-bearing part of the design.
   > //
   > // Restricted to `pending`, the index makes a second enqueue of a key that
   > // is already waiting a no-op: duplicate work collapses into the one row
   > // that has not started yet. Once that job settles — picked up, done or
   > // failed — it leaves the index, and the same key is immediately usable
   > // again for the next round of work.
   > ```

   Note "picked up, done or failed": the author counted being claimed as settling. That is the assumption this plan changes.

2. **`packages/mail/src/queue.ts:19-26` states the consequence in prose, as a feature:**

   > ```
   >  * While a mail for the same key is still pending, a second enqueue collapses
   >  * into it; once that one is claimed the key is free again, so a genuine resend
   >  * an hour later still works.
   > ```

   And `packages/auth/src/index.ts:158-161` repeats it at the call site:

   > ```
   > // Keyed on the address, not the token: "forgot password" clicked three
   > // times is three tokens and should still be one email. The key frees
   > // itself as soon as the pending job is claimed, so an honest retry
   > // minutes later sends again.
   > ```

3. **The mechanism is exactly as described.** `packages/db/src/jobs.ts:52-57` repeats the index predicate as its arbiter:

   ```ts
   .onConflictDoNothing({
     target: job.dedupeKey,
     // Repeats the partial index's predicate, which is how Postgres knows
     // which index arbitrates the conflict.
     where: sql`${job.status} = 'pending'`,
   })
   ```

   `claim` at `apps/server/src/lib/jobs.repository.ts:84-89` writes `status = 'running'` in the same statement that locks the row. From that commit onward the row has no entry in `job_dedupeKey_pending_idx`, so the next `enqueue` of the same key inserts.

4. **The consequence is real, and it is money.** "Resend verification" pressed while the first `mail.send` job is mid-flight produces a second row that a second worker can execute concurrently — two identical emails. For `ai.generate` (`packages/ai/src/queue.ts:40-51`) the same window is a second paid completion. The audit's impact statement is correct here; only its framing as an oversight is wrong.

5. **The window has no test.** `apps/server/src/lib/jobs.test.ts` has exactly two dedupe tests:
   - `"collapses two pending enqueues of the same dedupe key"` (lines 76-86) — the pending-pending case.
   - `"frees the dedupe key once the first job has settled"` (lines 88-100) — enqueue, `claim`, `complete`, enqueue again, expect `created: true`.

   The second one calls `claim` and then `complete` before re-enqueuing, so it never observes the state between them. `apps/server/src/lib/jobs.ownership.test.ts` covers exclusivity of claiming and settling and touches no dedupe key. There is no assertion anywhere about enqueuing while a job is `running`.

6. **`enqueue` is the only writer.** Grepping every `.ts` under `apps/` and `packages/` for `schema/job` returns four files: `packages/db/src/jobs.ts` (the insert), `apps/server/src/lib/jobs.repository.ts` (claim/complete/fail/sweep), and the two test suites. No other code path inserts a job row or writes `dedupe_key`.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, 16 architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`). Test files are **not** exempt — `biome.jsonc:137-153` turns that rule off only for `packages/ui/src/components/**`.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts`; `tools/check-naming.ts` enforces it. `apps/server/src/lib/jobs.ownership.test.ts` is the precedent this plan's new file follows.
- Tests live beside the code, never in `__tests__`. Integration suites gate on `testDbReady()` from `apps/server/test-db.ts` and announce the skip with `skipNotice(...)`. Never mock Drizzle.
- A schema change needs a generated migration. Run `bun run db:generate`; never hand-author the DDL. (This plan does add one **data** statement to the generated file by hand — see Task 1, Step 7, where the reason is spelled out. drizzle-kit emits schema, not data, and there is no other place for it.)
- No environment variable is added or changed by this plan.

## Do not

- **Do not make the index non-partial.** Dropping the `WHERE` entirely makes `dedupe_key` unique across the whole table, which permanently burns the key after its first use: `mail:verification:alice@example.com` would be enqueueable exactly once in the lifetime of the deployment. The partial predicate is the feature; this plan widens it by one status, it does not remove it.
- **Do not edit `apps/server/src/lib/jobs.repository.ts`.** `claim`, `complete` and `fail` need no change — Task 1, Step 5 proves it statement by statement. That file is also being changed by plans 010, 011 and 016; a gratuitous edit here collides with them for nothing.
- **Do not add an in-flight `SELECT` inside `enqueue`** as well as, or instead of, the index. The reasoning is in Task 1, Step 4. Two mechanisms enforcing the same rule is worse than one, because the weaker one hides when the stronger one is misconfigured.
- **Do not add an advisory lock, a transaction or a retry loop around `enqueue`.** `INSERT … ON CONFLICT DO NOTHING` against a unique index already serialises correctly: a second inserter blocks on the first one's index entry and is re-arbitrated against the committed result. Wrapping that in application locking adds a failure mode and buys nothing.
- **Never move a `done` or `failed` row back to `pending` or `running`.** This is the one transition the widened index cannot absorb: a settled row released its key, another row may legitimately hold it now, and re-entering the index would raise a unique violation at whatever statement did it. Nothing in the tree does this today (`fail` is fenced on `status = 'running'` precisely to prevent resurrection — `apps/server/src/lib/jobs.repository.ts:139-141,168`), and a future "retry this failed job" button must clear `dedupe_key` in the same statement. Task 2 writes that down in the schema comment.
- **Do not touch `README.md`'s test/file counts or `AGENTS.md`'s length.** Plan 021 owns both. Task 2 rewrites one README paragraph of prose and replaces one word on one AGENTS.md line, keeping the line count identical.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/jobs.dedupe.test.ts` | **Create.** The whole dedupe contract in one suite, including the running window that had no coverage. |
| `apps/server/src/lib/jobs.test.ts` | **Modify.** Give up the two dedupe tests that move to the new suite, and the import they alone needed. |
| `packages/db/src/schema/job.ts` | **Modify.** Widen the partial index predicate to `pending` + `running`, rename it, rewrite the comment that explains it. |
| `packages/db/src/jobs.ts` | **Modify.** Match the conflict target to the new predicate; correct the two doc comments that describe the old one. |
| `packages/db/src/migrations/0005_dedupe_unsettled_window.sql` | **Create** (generated, plus one data statement). Unkey legacy in-flight duplicates, drop the old index, create the new one. |
| `packages/db/src/migrations/meta/*` | **Modify** (generated only — never hand-edited). |
| `packages/mail/src/queue.ts` | **Modify.** The `dedupeKey` paragraph documents the old release point. |
| `packages/auth/src/index.ts` | **Modify.** The password-reset comment documents the old release point. |
| `packages/ai/src/queue.ts` | **Modify.** Say what a key now costs for the paid path. |
| `README.md` | **Modify.** One paragraph describing the index predicate. |
| `AGENTS.md` | **Modify.** One word on one line. |

---

### Task 1: Hold the key until the job settles

**Files:**
- Create: `apps/server/src/lib/jobs.dedupe.test.ts`
- Modify: `apps/server/src/lib/jobs.test.ts:6-12,76-100`
- Modify: `packages/db/src/schema/job.ts:59-73`
- Modify: `packages/db/src/jobs.ts:52-57`
- Create: `packages/db/src/migrations/0005_dedupe_unsettled_window.sql`

**Interfaces:**
- Consumes: `enqueue(input: EnqueueInput): Promise<EnqueueResult>` from `@/lib/jobs.repository`; `claim(workerId: string, limit: number): Promise<ClaimedJob[]>`; `complete(id: string, workerId: string): Promise<void>`; `fail(id: string, workerId: string, error: unknown): Promise<void>`; `testDbReady(): Promise<boolean>` and `skipNotice(suite: string): string` from `apps/server/test-db.ts`.
- Produces: no new exported symbol. It produces a changed database invariant: **at most one row with a given non-null `dedupe_key` may have `status IN ('pending','running')`**, enforced by the unique index `job_dedupeKey_unsettled_idx`. Task 2 documents this invariant and adds nothing to it.

- [x] **Step 1: Make sure the test database is up**

```bash
bun run db:test:start && bun run db:test:migrate
```

Expected: the `postgres-test` container is running and drizzle-kit reports the migrations as applied (or "No migrations to apply"). Every suite in this task is an integration suite; without this they skip and report green while proving nothing.

- [x] **Step 2: Write the dedupe suite**

Create `apps/server/src/lib/jobs.dedupe.test.ts`. Three of these five cases exist to hold the semantics still; the second one is the new coverage and is the case that fails today.

```ts
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
```

- [x] **Step 3: Take the moved tests out of the lifecycle suite**

In `apps/server/src/lib/jobs.test.ts`, delete lines 76-100 — the `"collapses two pending enqueues of the same dedupe key"` test, the comment above `"frees the dedupe key once the first job has settled"`, and that test. Both now live in the new suite; leaving them here would run the same assertions twice and split one contract across two files.

`complete` was used only by the test that just left, so the import block at lines 6-12 must lose it or `noUnusedImports` fails the lint. It becomes:

```ts
import {
	claim,
	type EnqueueInput,
	enqueue,
	fail,
} from "@/lib/jobs.repository";
```

`enqueue` stays: `enqueueId` at line 27 calls it.

- [x] **Step 4: Run the suite and watch exactly one case fail**

```bash
cd apps/server && bun test src/lib/jobs.dedupe.test.ts
```

Expected: `4 pass, 1 fail`. The failure is `collapses an enqueue that arrives while the first job is running`, at the first assertion:

```
error: expect(received).toBe(expected)

Expected: false
Received: true
```

`second.created` is `true` because the claimed row left `job_dedupeKey_pending_idx` and the key was free. If any other case fails, or if the run reports `[skip] jobs.dedupe needs the test database`, stop — the database is not up and nothing below is being verified.

- [x] **Step 5: Prove the widened predicate cannot be violated, before writing it**

This is the design pass the audit's `Risk: MED` is about. Do it on paper first; the statements are short and the answer decides whether the rest of the task is safe.

The proposed invariant: **at most one row per non-null `dedupe_key` with `status IN ('pending','running')`.** Every statement in the tree that writes `status` or `dedupe_key`:

| Statement | Transition | Effect on the index | Can it collide? |
|---|---|---|---|
| `enqueue` (`packages/db/src/jobs.ts:44-58`) | insert as `pending` | adds an entry | Yes, and that is the point — `ON CONFLICT DO NOTHING` swallows it. |
| `claim` (`jobs.repository.ts:84-91`) | `pending → running` | entry stays, same key, same row | No. The row already held the key exclusively; updating a row to a key it already owns is not a duplicate. |
| `complete` (`jobs.repository.ts:122-128`) | `running → done` | entry disappears | No. Leaving a partial index is always legal. |
| `fail`, exhausted (`jobs.repository.ts:161-164`) | `running → failed` | entry disappears | No, same reason. |
| `fail`, retrying (`jobs.repository.ts:161-164`) | `running → pending` | entry stays, same key, same row | **No — and this is the case worth spelling out.** |
| plan 011's reaper | `running → pending` (or `→ failed`) | entry stays, or disappears | No, by the same two arguments. |
| `sweepSettledJobs` (`jobs.repository.ts:187-193`) | deletes `done`/`failed` | those rows have no entry | No. |

The case to hunt, in the task's own words: *what does `fail`'s requeue do if a new pending row took the key while the first was running?*

**Under the widened predicate that situation cannot arise.** While row A is `running` it still holds an index entry for key K. Any `enqueue` of K in that interval inserts a row that also satisfies the predicate, collides on that entry, and is swallowed by `ON CONFLICT DO NOTHING`. So no second row with key K exists to conflict with when A goes `running → pending`. The hazard is *created* by the narrow predicate and *removed* by the wide one; widening does not introduce it.

Two follow-ups that do need care, and are handled:

1. **Legacy rows.** The pair the widened index forbids can already exist in a live database, created under the narrow one: A `running` with key K plus B `pending` with key K, or even two `running` rows with key K (B was enqueued while A ran, then claimed). `CREATE UNIQUE INDEX` aborts on either. Step 7 repairs this in the same migration.
2. **Resurrection.** `done`/`failed` → `pending`/`running` re-enters the index for a key the row released, and can collide. `fail` is already fenced on `status = 'running'` (`jobs.repository.ts:168`) and `complete` on the same (`:127`), so no statement in the tree can do it. Task 2 records the constraint in the schema comment so the next one does not.

**Now the three options, and why one of them wins.**

*Option A — widen the index predicate to `status IN ('pending','running')`.* The table above is the whole risk analysis and it comes out clean. Costs: one generated migration with a data repair; a hard dependency on plan 011's reaper, because a key held by a row stuck in `running` is a key nothing releases (`sweepSettledJobs` only deletes `done` and `failed`, so a stalled row lives forever); and a behaviour change users can observe — a resend issued while the first job is in flight is now silently collapsed rather than duplicated. For `mail.send` the collapsed message is byte-identical to the one already being sent, so the user still gets their email. For `ai.generate` the collapse is the entire reason the caller passed a key.

*Option B — an in-flight check inside `enqueue`*, e.g. `INSERT … SELECT … WHERE NOT EXISTS (SELECT 1 FROM job WHERE dedupe_key = $1 AND status IN ('pending','running'))`. **Rejected**, on two grounds.

  It is racy in a way the index is not, and the difference is snapshot versus lock. Under READ COMMITTED the `NOT EXISTS` subquery reads committed state at the instant its statement snapshot is taken and nothing holds that state: two enqueues whose snapshots both fall after `complete` committed both proceed, and the only thing that stops them producing two rows is the unique index underneath — the mechanism this option was supposed to replace. The index has the same boundary in time, but it is a *transactional* one: the row's entry vanishes in the same commit that settles it, and a concurrent inserter blocks on that entry and is re-arbitrated against the committed outcome rather than against a snapshot it took earlier. So the check narrows the window without closing it, and leaves the outcome depending on which side of a commit a caller's millisecond landed.

  And it is unenforceable. An index binds every writer, including a psql session, a fixture and whatever inserts jobs next year. A `WHERE NOT EXISTS` binds only the callers of one function — and `enqueue` is already re-exported through `apps/server/src/lib/jobs.repository.ts:22-27` and `apps/server/src/lib/jobs.ts:12-17`, which is two more places for a future insert to route around it. For a rule whose failure mode is spending money twice, "usually correct" is not a category.

*Option C — accept the behaviour and document a dedupe-key policy per job kind.* **Rejected.** The only lever a caller has is the key itself, and a key cannot express "collapse while pending, and also while running". `packages/ai/src/queue.ts:11-21` already documents the policy this option proposes, in careful prose, and it does not prevent the duplicate charge — because the collapse point is not the caller's to choose. Option C is "write more prose about a hazard we could remove".

**Decision: Option A.** It is the only one that puts the rule where every writer meets it, and the settle-path analysis above shows the widening costs nothing in the statements that already exist.

- [x] **Step 6: Widen the index**

In `packages/db/src/schema/job.ts`, replace lines 59-73 — the comment and the `uniqueIndex(...)` — with:

```ts
		// Partial on purpose, and this is the load-bearing part of the design.
		//
		// Restricted to the two unsettled statuses, the index makes a second
		// enqueue of a key that is already in flight a no-op: duplicate work
		// collapses into the row that is doing it, whether that row is still
		// waiting or already running. Only when the job reaches `done` or
		// `failed` does it leave the index and free the key for the next round
		// of the same work.
		//
		// `running` is inside the predicate deliberately. With `pending` alone
		// the key was released by `claim` — the same statement that starts the
		// work — so "resend verification" pressed while the first mail was being
		// sent produced a second row that ran concurrently, and a keyed
		// `ai.generate` was paid for twice.
		//
		// So one index is both a debounce and a mutex, enforced by Postgres. A
		// non-partial index would instead permanently burn the key after its
		// first use, and getting the same behaviour in the application would
		// need a read-then-write under an advisory lock on every enqueue.
		uniqueIndex("job_dedupeKey_unsettled_idx")
			.on(table.dedupeKey)
			.where(sql`${table.status} in ('pending', 'running')`),
```

The rename is not cosmetic. `job_dedupeKey_pending_idx` would be a false name, and renaming guarantees drizzle-kit emits an unambiguous drop-and-create rather than trying to diff a predicate in place.

- [x] **Step 7: Generate the migration and add the one thing drizzle-kit cannot**

```bash
bun run db:generate -- --name dedupe_unsettled_window
```

If turbo does not forward the flag, run the form `tools/check-migrations.ts:44` already uses:

```bash
cd packages/db && bunx drizzle-kit generate --name dedupe_unsettled_window
```

Expected: `packages/db/src/migrations/0005_dedupe_unsettled_window.sql` appears, plus a new `meta/0005_snapshot.json` and a fifth entry in `meta/_journal.json`. Never hand-edit either meta file — `tools/check-migrations.ts` regenerates from the snapshot and a hand-edit there is what makes drift undetectable.

Open the SQL. **Both** statements must be present:

```sql
DROP INDEX "job_dedupeKey_pending_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "job_dedupeKey_unsettled_idx" ON "job" USING btree ("dedupe_key") WHERE "job"."status" in ('pending', 'running');
```

Compare against `packages/db/src/migrations/0001_organizations_jobs.sql:67`, which is the original `CREATE UNIQUE INDEX … WHERE "job"."status" = 'pending';`, to confirm the emitted predicate is the new one and the qualified `"job"."status"` form is unchanged. If the `DROP INDEX` is missing, the generate ran against a stale `meta/` — restore `packages/db/src/migrations/meta` from git, delete the generated `0005_*` files, and run it again.

Now prepend the data repair. A live database can already hold two unsettled rows with the same key, because the old index permitted it; `CREATE UNIQUE INDEX` on such a table aborts and takes the deploy with it. drizzle-kit emits schema, not data, so this statement is written by hand — the only hand-written line in the file. Insert it as the **first** statement, before the `DROP INDEX`:

```sql
-- Legacy rows: the old index allowed a second unsettled row to take a key while
-- the first was running, so a live table can hold pairs the new index forbids.
-- Keep the oldest in-flight row per key and unkey the rest rather than deleting
-- them: those jobs were always going to run, the duplicate execution already
-- happened under the old rule, and a null dedupe key is how the schema already
-- spells "this row does not participate in dedupe". Nothing queued is lost.
UPDATE "job" SET "dedupe_key" = NULL WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", row_number() OVER (
			PARTITION BY "dedupe_key" ORDER BY "created_at", "id"
		) AS rn
		FROM "job"
		WHERE "dedupe_key" IS NOT NULL AND "status" IN ('pending', 'running')
	) ranked WHERE ranked.rn > 1
);--> statement-breakpoint
```

Keep the `--> statement-breakpoint` separator exactly as drizzle-kit writes it between its own statements; the migrator splits on it. Editing the SQL body is safe with respect to the gate: `tools/check-migrations.ts:44-50` fails only when a generate produces a **new file**, and it diffs the schema against `meta/`, which this does not touch.

- [x] **Step 8: Match the conflict target to the index**

In `packages/db/src/jobs.ts`, replace lines 52-57:

```ts
		.onConflictDoNothing({
			target: job.dedupeKey,
			// Repeats the partial index's predicate, which is how Postgres knows
			// which index arbitrates the conflict. It has to match
			// `job_dedupeKey_unsettled_idx` exactly: a predicate Postgres cannot
			// match to an index is not a silent fallback, it is
			// `there is no unique or exclusion constraint matching the ON
			// CONFLICT specification`.
			where: sql`${job.status} in ('pending', 'running')`,
		})
```

- [x] **Step 9: Apply the migration to the test database**

```bash
bun run db:test:migrate
```

Expected: drizzle-kit applies `0005_dedupe_unsettled_window`. Use `db:test:migrate`, not `db:test:push` — `push` diffs the live database against the schema and would create the index without running the repair statement, which is the one part of the migration this task needs to see work.

- [x] **Step 10: Run the suite and watch it pass**

```bash
cd apps/server && bun test src/lib/jobs.dedupe.test.ts
```

Expected: `5 pass, 0 fail`.

- [x] **Step 11: Run the neighbouring suites**

```bash
cd apps/server && bun test src/lib/jobs.test.ts src/lib/jobs.ownership.test.ts
```

Expected: both green. This is where a mistake in Step 5's analysis would surface — `jobs.test.ts` walks the full retry ladder five times (`retries with a later runAt and stops at maxAttempts`), which is five `running → pending` transitions on a row, and `jobs.ownership.test.ts` drives `complete` and `fail` from the wrong worker. A unique-violation error from any of them means a transition was missed in the table above.

- [x] **Step 12: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful; `check-naming` reports one more suite than before; 16 architecture rules verified; `check-migrations: 5 migration(s), schema matches.`

- [x] **Step 13: Commit**

```bash
git add packages/db/src/schema/job.ts packages/db/src/jobs.ts packages/db/src/migrations apps/server/src/lib/jobs.dedupe.test.ts apps/server/src/lib/jobs.test.ts
git commit -m "fix(db): dedupe now holds the key for the whole in-flight window

The partial unique index covered \`status = 'pending'\` only, and \`claim\` sets
\`running\` in the same statement that takes the row — so the key was released by
the statement that starts the work, not by the one that finishes it. Pressing
\"resend verification\" while the first mail was being sent inserted a second row
that a second worker ran concurrently, and a keyed \`ai.generate\` was paid for
twice. The behaviour was deliberate and documented; the release point was one
transition too early.

The predicate is now \`status in ('pending','running')\` and the index is renamed
to say so. Every statement that writes \`status\` was checked against it before
the change: \`claim\` and a retrying \`fail\` keep the row's own entry under the
same key, \`complete\` and an exhausted \`fail\` leave the index, and the sweep only
touches rows that were never in it. The pair the new index forbids — one running
row and one pending row sharing a key — is exactly what the old predicate
allowed and the new one prevents, so \`fail\`'s requeue has nothing to collide
with. The one transition that could collide, a settled row returning to
\`pending\`, is already fenced off by \`complete\` and \`fail\` requiring
\`status = 'running'\`.

An in-flight \`WHERE NOT EXISTS\` inside \`enqueue\` was the cheaper option and was
rejected: it reads a snapshot where the index takes a lock, so it narrows the
window instead of closing it, and it binds only the callers of one function
while an index binds every writer.

The migration unkeys legacy duplicates before creating the index rather than
deleting them — those rows were already going to run, and a null key is how the
schema spells \"does not participate in dedupe\". Nothing queued is lost.

The running window had no test. \`jobs.test.ts\` covered the pending collapse and
the reuse after settling and never looked between them; the dedupe contract now
has its own suite, and the case that failed before this commit is in it."
```

---

### Task 2: Correct every comment that documents the old release point

**Files:**
- Modify: `packages/db/src/schema/job.ts` (the resurrection constraint)
- Modify: `packages/db/src/jobs.ts:24-28,30-42`
- Modify: `packages/mail/src/queue.ts:19-26`
- Modify: `packages/auth/src/index.ts:158-161`
- Modify: `packages/ai/src/queue.ts:11-21`
- Modify: `README.md:252-255`
- Modify: `AGENTS.md:48`

**Interfaces:**
- Consumes: Task 1's invariant — at most one row per non-null `dedupe_key` with `status IN ('pending','running')`.
- Produces: nothing executable. This task changes only comments and prose, so `bun run check` must be green at the start of it and green at the end for the same reasons.

- [ ] **Step 1: Record the one transition the index cannot absorb**

In `packages/db/src/schema/job.ts`, immediately after the `uniqueIndex(...)` clause Task 1 wrote and before the `check(...)` at what was line 74, add:

```ts
		// The one transition this index cannot absorb: a `done` or `failed` row
		// released its key, so moving one back to `pending` or `running` can
		// collide with whatever legitimately took it since. No statement does
		// that today — `complete` and `fail` are both fenced on
		// `status = 'running'`, which is what stops a late worker resurrecting a
		// settled row. A future "retry this failed job" must therefore clear
		// `dedupe_key` in the same statement, or enqueue a fresh row.
```

- [ ] **Step 2: Correct the enqueue documentation**

In `packages/db/src/jobs.ts`, the `EnqueueResult` comment at line 25 says "already pending". Replace lines 24-28:

```ts
export interface EnqueueResult {
	/** False when an equal dedupe key was already in flight, so nothing was added. */
	created: boolean;
	id: string | null;
}
```

And the function's doc at lines 30-42, whose first line says "already waiting":

```ts
/**
 * Adds a job, unless `dedupeKey` names work that is already in flight.
 *
 * In flight means `pending` or `running`: the key is held from the moment the
 * work is queued until the moment it settles, so a duplicate raised while the
 * first job is executing collapses into it rather than running beside it.
 *
 * The conflict is swallowed rather than raised, which is the opposite of what
 * `withUniqueConflict` does for a user-facing insert: there a duplicate is the
 * caller's mistake and deserves a 409, here it is the whole point. Two requests
 * that both decide "this tenant needs re-indexing" should produce one re-index,
 * and the caller has nothing to fix.
 *
 * The conflict target is stated explicitly instead of a bare `do nothing`, which
 * would also silently swallow a primary-key collision — a real bug that must not
 * be reported as successful deduplication.
 */
```

- [ ] **Step 3: Correct the mail queue's paragraph**

In `packages/mail/src/queue.ts`, replace lines 19-26 — the paragraph ending `*/`:

```ts
 * `dedupeKey` is required, not optional, because the endpoints that produce mail
 * here are all ones a user can hit repeatedly on purpose: "resend verification"
 * pressed three times is three requests, and the right outcome is one email.
 * The key is held for as long as the mail is in flight — queued or being sent —
 * so a second enqueue collapses into the first for the whole of it, and the key
 * frees itself once the send has finished. A genuine resend an hour later still
 * works. Callers pick a key that names the message — the recipient and what it
 * is for — not one that names the attempt.
 */
```

- [ ] **Step 4: Correct the password-reset call site**

In `packages/auth/src/index.ts`, replace the comment at lines 158-161:

```ts
				// Keyed on the address, not the token: "forgot password" clicked three
				// times is three tokens and should still be one email. The key is held
				// until the send has finished, so a burst collapses into one message
				// while an honest retry once that one has gone out sends again.
```

The two `enqueueMail` calls below it are unchanged; their keys were already right.

- [ ] **Step 5: Say what the key now costs on the paid path**

In `packages/ai/src/queue.ts`, replace the `dedupeKey` comment at lines 11-21:

```ts
	/**
	 * Optional, unlike mail's, and the caller has to think about it.
	 *
	 * Collapsing two identical AI calls saves real money, which argues for always
	 * setting one. But an LLM call is also the thing a user most legitimately
	 * repeats — "try that again" is a feature, not a double submit — and a key
	 * derived from the prompt would silently swallow it. So: a key when the work
	 * is idempotent by nature (summarise this document), none when the user asked
	 * for another answer.
	 *
	 * A key is held until the generation settles, not until a worker picks it up,
	 * so "try that again" pressed while the first completion is still running is
	 * swallowed too. That is the point for the idempotent case — it is the second
	 * charge that does not happen — and it is the reason the other case must pass
	 * no key at all rather than a slightly different one.
	 */
	dedupeKey?: string;
```

- [ ] **Step 6: Correct the README paragraph**

In `README.md`, replace lines 252-255. Prose only — plan 021 owns this file's test and file counts, and none of them appear here:

```markdown
The load-bearing detail is one index: `dedupe_key` is unique only
`WHERE status IN ('pending', 'running')`. Enqueue collapses duplicate work for as
long as the earlier job is in flight — queued or executing — and the same key
becomes usable again once that job is `done` or `failed`. A debounce and a mutex
in one index, with no application-side locking.
```

- [ ] **Step 7: Correct the one word in AGENTS.md**

`AGENTS.md:48` reads `private to that module — and takes a `dedupeKey` to collapse duplicate pending`. Replace `pending` with `in-flight` on that line and change nothing else. Plan 021 owns this file's length, so the line count must not move.

- [ ] **Step 8: Prove the whole gate is green**

```bash
bun run check
```

Expected: identical to Task 1, Step 12. Nothing executable changed, so any new failure is a line-length or formatting complaint from Biome about the comments above — fix it in place rather than shortening the explanation into uselessness.

- [ ] **Step 9: Commit**

```bash
git add packages/db/src/schema/job.ts packages/db/src/jobs.ts packages/mail/src/queue.ts packages/auth/src/index.ts packages/ai/src/queue.ts README.md AGENTS.md
git commit -m "docs: the dedupe key is held until a job settles, not until claim

Five comments and two documents described the old release point, and three of
them described it as the feature: \`packages/mail/src/queue.ts\` promised the key
was \"free again\" once a job was claimed, the password-reset call site repeated
it, and the README stated the predicate as \`WHERE status = 'pending'\`. A comment
that is confidently wrong about a database invariant is worse than none, because
the next person reasons from it instead of from the index.

The schema also gains the constraint the widened predicate creates: a settled row
released its key, so returning one to \`pending\` or \`running\` can collide with
whatever took it since. Nothing does that today — \`complete\` and \`fail\` are
fenced on \`status = 'running'\` — and a retry feature will have to clear
\`dedupe_key\` or enqueue a fresh row. That is written next to the index rather
than left to be rediscovered.

AGENTS.md changes one word and keeps its line count; the README paragraph is
prose and carries none of the counts plan 021 owns."
```

---

## Done when

- A `dedupe_key` inserted by `enqueue` cannot be re-used while an earlier row carrying it has `status` `pending` or `running`; `enqueue` returns `{ created: false, id: null }` for the whole of that interval.
- `apps/server/src/lib/jobs.dedupe.test.ts` runs five cases green against a real Postgres, and the second one — an enqueue arriving while the first job is `running` — fails on the commit before Task 1.
- `packages/db/src/migrations/0005_dedupe_unsettled_window.sql` applies cleanly to a database that already holds an unsettled duplicate pair, leaving every queued row in place with the later duplicates' `dedupe_key` set to null.
- `job_dedupeKey_pending_idx` no longer exists in the schema, in the migrations, or in any comment.
- `bun run check` passes, reporting `check-migrations: 5 migration(s), schema matches.`
- No comment, README paragraph or AGENTS.md line still states that a claimed job frees its key.
- `apps/server/src/lib/jobs.repository.ts` is byte-identical to `39fd32c` plus whatever 010/011/016 did to it.

## Out of scope

- **The stuck-job reaper.** Plan 011 (CORR-01) owns it, and this plan depends on it rather than duplicating it. Without a reaper, a worker killed between `claim` and `complete` leaves a `running` row that now holds its dedupe key forever, because `sweepSettledJobs` deletes only `done` and `failed`.
- **Settlement in `apps/server/src/lib/jobs.ts`** — plan 010 (CORR-02).
- **Extracting the worker loop for testability** — plan 016 (TEST-04/05). This plan's suite is an integration suite against a real database and needs no such extraction.
- **Idempotency keys for HTTP requests** — a different mechanism in a different table; plan 012 owns `apps/server/src/lib/idempotency.ts`.
- **Webhook replay protection** — plan 022. It shares the word "duplicate" and nothing else: that one is about a captured request re-verifying, this one is about two rows in `job`.
- **An index on `job.updated_at` for the sweeps** — PERF-02, and it is a different index with a different justification.
- **README test/file counts and AGENTS.md length** — plan 021.
