# Job-Table Wipe Race Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** TEST-01 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Stop the two server job suites from deleting the whole `job` table in `beforeEach`, which can remove another concurrently-running suite's rows mid-assertion (CI runs server and mail suites concurrently against one `keel_test` DB). Each suite must delete only the rows it created.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/lib/jobs.test.ts:53-55` — `beforeEach(async () => { await db.delete(job); });`
2. `apps/server/src/lib/jobs.ownership.test.ts:39-41` — the same full-table wipe.
3. The fix model already exists in the repo: `packages/mail/src/queue.test.ts:76-81` — `afterEach` deletes only `keys.splice(0)` (keys its own tests registered via a `freshKey()` helper, queue.test.ts:46-57). No full-table delete anywhere.
4. `apps/server/src/lib/jobs.reaper.test.ts` (landed in plan 011) and `jobs.dedupe.test.ts` (plan 024) already use the id-scoped pattern — they stage rows and clean up by id in `afterEach`, and deliberately do not wipe.

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

- [ ] **Step 1:** Read the whole suite first. Find every place it inserts a job row (direct `db.insert(job)` or through `enqueue`/helpers), and every assertion that depends on table state (e.g. `claim` returning an exact batch length, `pendingFor` emptiness).
- [ ] **Step 2:** Add a module-scoped `const staged: string[] = []` and a helper that registers a row id (or wrap the insert/enqueue call sites so each created id is pushed). Follow the mail queue's naming (`staged`, `freshKey`-style).
- [ ] **Step 3:** Replace `beforeEach`'s `db.delete(job)` with an `afterEach` that deletes only the staged ids:
  ```ts
  afterEach(async () => {
    if (staged.length > 0) {
      await db.delete(job).where(inArray(job.id, staged.splice(0)));
    }
  });
  ```
  (Check the existing imports — `inArray` may already be imported in `jobs.test.ts`; `jobs.reaper.test.ts` uses exactly this shape at its `afterEach`.)
- [ ] **Step 4:** Audit every assertion that previously relied on the table being empty. A `claim` returning an exact length may now see leftovers from another concurrent suite — change it to assert by id (as `jobs.reaper.test.ts:116-120` does) or filter by the suite's own keys. Run the suite alone until green: `cd apps/server && bun test src/lib/jobs.test.ts` (explicit path).
- [ ] **Step 5:** Run it concurrently with the mail suite to prove the race is gone: `bun test src/lib/jobs.test.ts packages/mail/src/queue.test.ts` won't work across packages in one invocation — instead run the two package test tasks concurrently via `bunx turbo run test --filter=@keel/server --filter=@keel/mail` (or the closest equivalent) and confirm both stay green. If turbo flags are awkward, run `bun test src/lib/jobs.test.ts` in the background while `cd packages/mail && bun test src/queue.test.ts` runs, and check both exit 0.
- [ ] **Step 6:** Commit: `test(jobs): a suite deletes only the rows it created`.

### Task 2: Same for jobs.ownership.test.ts

**Files:** `apps/server/src/lib/jobs.ownership.test.ts`

- [ ] **Step 1:** Apply the same id-scoped pattern (Steps 1-4 of Task 1) to this suite.
- [ ] **Step 2:** Run both server suites together with explicit paths: `cd apps/server && bun test src/lib/jobs.test.ts src/lib/jobs.ownership.test.ts` — green.
- [ ] **Step 3:** Commit: `test(jobs): ownership suite stops wiping the table too`.

## Done when

- Neither server job suite runs `db.delete(job)` with no filter anymore.
- Both suites pass in isolation and concurrently with the mail suite.
- No other file was touched.

## Out of scope

- **TEST-04/05** (worker loop and sweep/backoff tests) — plan 016, which may add tests to `jobs.test.ts` after this plan lands; coordinate if concurrent (this plan owns the wipe and the staged-ids helper, 016 owns new test cases).
- Changing `packages/mail/src/queue.test.ts`.
