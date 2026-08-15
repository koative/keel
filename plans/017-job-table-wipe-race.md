# Job-Table Wipe Race Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** TEST-01 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Stop the two server job suites from deleting the whole `job` table in `beforeEach`, which can remove another concurrently-running suite's rows mid-assertion (CI runs server and mail suites concurrently against one `keel_test` DB). Each suite must delete only the rows it created.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/lib/jobs.test.ts:53-55` — `beforeEach(async () => { await db.delete(job); });`
2. `apps/server/src/lib/jobs.ownership.test.ts:39-41` — the same full-table wipe.
3. The fix model already exists in the repo: `packages/mail/src/queue.test.ts:76-81` — `afterEach` deletes only `keys.splice(0)` (keys its own tests registered via a `freshKey()` helper, queue.test.ts:46-57). No full-table delete anywhere.
4. `apps/server/src/lib/jobs.reaper.test.ts` (landed in plan 011) already uses the id-scoped pattern — it stages rows and cleans up by id in `afterEach`, and deliberately does not wipe.
   > **Corrected after execution — this item was false, and the falsehood scoped the plan.** It originally also named `jobs.dedupe.test.ts` (plan 024) as already id-scoped. That suite has run `beforeEach(async () => { await db.delete(job); })` since the commit that created it (`d84471a`, 25 commits before this plan landed at `1c3265d`), with no `afterEach` and no `staged` array at all. Believing it clean is why this plan's file structure lists only two suites: `jobs.settlement.test.ts` was wiping too and was never looked at, and plan 026 then added a third at `sweep.test.ts`. The wipe race was therefore only ever closed for `jobs.test.ts` and `jobs.ownership.test.ts`; the other three are closed by the follow-up work recorded under "Done when".

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- Test DB is up (`keel-postgres-test` on :5433). Run `bun run db:test:migrate` once before DB tests.
- The suites must still pass in isolation AND when run concurrently with the mail suite (that is the point).

## Do not

- Do not remove the `beforeEach` without replacing it with per-suite cleanup — rows would leak across tests and order-dependence would appear.
- Do not introduce a shared global registry file; keep the pattern local to each suite (like the mail queue's module-scoped `keys` array).
- Do not touch `packages/mail/src/queue.test.ts` — it is the model, not the target.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/jobs.test.ts` | **Modify.** Track enqueued ids; delete only those in `afterEach`. |
| `apps/server/src/lib/jobs.ownership.test.ts` | **Modify.** Same. |

### Task 1: Scope the wipe in jobs.test.ts

**Files:** `apps/server/src/lib/jobs.test.ts`

- [x] **Step 1:** Read the whole suite first. Find every place it inserts a job row (direct `db.insert(job)` or through `enqueue`/helpers), and every assertion that depends on table state (e.g. `claim` returning an exact batch length, `pendingFor` emptiness).
- [x] **Step 2:** Add a module-scoped `const staged: string[] = []` and a helper that registers a row id (or wrap the insert/enqueue call sites so each created id is pushed). Follow the mail queue's naming (`staged`, `freshKey`-style).
- [x] **Step 3:** Replace `beforeEach`'s `db.delete(job)` with an `afterEach` that deletes only the staged ids:
  ```ts
  afterEach(async () => {
    if (staged.length > 0) {
      await db.delete(job).where(inArray(job.id, staged.splice(0)));
    }
  });
  ```
  (Check the existing imports — `inArray` may already be imported in `jobs.test.ts`; `jobs.reaper.test.ts` uses exactly this shape at its `afterEach`.)
- [x] **Step 4:** Audit every assertion that previously relied on the table being empty. A `claim` returning an exact length may now see leftovers from another concurrent suite — change it to assert by id (as `jobs.reaper.test.ts:116-120` does) or filter by the suite's own keys. Run the suite alone until green: `cd apps/server && bun test src/lib/jobs.test.ts` (explicit path).
- [x] **Step 5:** Run it concurrently with the mail suite to prove the race is gone: `bun test src/lib/jobs.test.ts packages/mail/src/queue.test.ts` won't work across packages in one invocation — instead run the two package test tasks concurrently via `bunx turbo run test --filter=@keel/server --filter=@keel/mail` (or the closest equivalent) and confirm both stay green. If turbo flags are awkward, run `bun test src/lib/jobs.test.ts` in the background while `cd packages/mail && bun test src/queue.test.ts` runs, and check both exit 0.
- [x] **Step 6:** Commit: `test(jobs): a suite deletes only the rows it created`.

### Task 2: Same for jobs.ownership.test.ts

**Files:** `apps/server/src/lib/jobs.ownership.test.ts`

- [x] **Step 1:** Apply the same id-scoped pattern (Steps 1-4 of Task 1) to this suite.
- [x] **Step 2:** Run both server suites together with explicit paths: `cd apps/server && bun test src/lib/jobs.test.ts src/lib/jobs.ownership.test.ts` — green.
- [x] **Step 3:** Commit: `test(jobs): ownership suite stops wiping the table too`.

## Done when

- Neither of the two suites this plan owns — `jobs.test.ts` and `jobs.ownership.test.ts` — runs `db.delete(job)` with no filter anymore.
  > **Scope note.** As written this bullet reads as a claim about the repository, and as such it was false when the plan was closed: `jobs.dedupe.test.ts:47`, `jobs.settlement.test.ts:92` and `sweep.test.ts:64` were all still wiping the whole table, for the reason recorded against evidence item 4. All three were converted in follow-up work, so `db.delete(job)` now appears in `apps/server` only behind a filter — by staged id, by the suite's own `kind`, or by `dedupe_key`. Two of them also needed their assertions weaned off an empty table rather than merely re-scoped: `jobs.runner.test.ts` and `jobs.settlement.test.ts` drive `runOnce`, which claims globally and hands every foreign due row to `runJob`, so they now backdate their own rows and bound the batch instead of relying on being alone in the table.
- Both suites pass in isolation and concurrently with the mail suite.
- No other file was touched.

## Out of scope

- **TEST-04/05** (worker loop and sweep/backoff tests) — plan 016, which may add tests to `jobs.test.ts` after this plan lands; coordinate if concurrent (this plan owns the wipe and the staged-ids helper, 016 owns new test cases).
- Changing `packages/mail/src/queue.test.ts`.
