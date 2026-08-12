# Unbounded Sweep Batching Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** PERF-02 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Bound the three single-statement sweeps so a cron gap cannot turn one sweep into a single long transaction deleting millions of rows while buffering every id in memory. Add the index the `updated_at` filter is missing.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/lib/jobs.repository.ts:248-257` — `sweepSettledJobs(olderThan)`: `db.delete(job).where(and(inArray(job.status, ["done","failed"]), lt(job.updatedAt, olderThan))).returning({ id: job.id })` — one unbounded statement, `RETURNING` buffers every id just to count.
2. `apps/server/src/tasks.ts:97-100` — the auth rate-limit counter sweep: `db.delete(rateLimit).where(lt(rateLimit.lastRequest, ...)).returning({ id: rateLimit.id })` — same shape.
3. `apps/server/src/lib/idempotency.repository.ts:57-65` — `sweepExpiredKeys(now)`: `db.delete(idempotencyKey).where(lt(idempotencyKey.expiresAt, now)).returning({ id: idempotencyKey.id })` — same shape.
4. `packages/db/src/schema/job.ts:58` — indexes are `job_status_runAt_idx` and the partial dedupe index; **no `updated_at` index** — the sweep's `lt(updatedAt)` predicate is unsupported. (`rate_limit` has `idx(updated_at)`? — scout listed `rate-limit.ts: idx(updated_at)`; verify; `idempotency_key` has `idx(expires_at)` — both supported.)
5. Plan 016 (an earlier wave) may add a `sweepSettledJobs` test; this plan changes the function's *shape* (batching) — keep the signature `sweepSettledJobs(olderThan: Date): Promise<number>` so 016's test (if landed) still passes; update it only if the count semantics change.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- Test DB is up; `bun run db:test:migrate` once before DB tests.
- No file over 200 code lines.
- This plan owns a migration (the `job` index) — it is the only plan in its wave that runs `drizzle-kit generate`; migration numbering: 0006 (012), 0007 (023), 0008 (025) — this plan owns the **next** number. Confirm the current highest before generating.

## Do not

- Do not change the deletion window semantics: rows aged past the cutoff between batches are fine to delete (the audit's own note: batching changes the deletion window only in the safe direction).
- Do not count via `RETURNING` anymore — use the statement's affected-row count (`rowCount` on the drizzle result, or a `returning` on a bounded set only). The audit's sketch: loop `DELETE ... LIMIT 1000` keyed on a cursor until zero rows, count via `rowCount`.
- Do not add a new env variable for the batch size — a module constant is the repo's pattern (precedent: `BACKOFF_*`, webhook `TOLERANCE_MS`).
- Do not run the full `bun run check` mid-flight (concurrent suites race the job table); explicit test paths only.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/jobs.repository.ts` | **Modify.** Batch `sweepSettledJobs`; add the batch constant. |
| `apps/server/src/tasks.ts` | **Modify.** Batch the auth counter sweep (it currently inlines the delete — consider moving it into a small helper in the same file or using the same pattern). |
| `apps/server/src/lib/idempotency.repository.ts` | **Modify.** Batch `sweepExpiredKeys`. |
| `packages/db/src/schema/job.ts` | **Modify.** Add the `updated_at` index. |
| `packages/db/src/migrations/0009_job_updated_at_idx.sql` + meta | **Create** (drizzle-kit generate). |
| `apps/server/src/lib/jobs.test.ts` (or sibling) | **Modify/Add** only if the sweep's count semantics need a new assertion (016's test covers behavior; add a batching proof if cheap — e.g. stage >batch-size settled rows and assert all removed and the count is right). |

### Task 1: The index

**Files:** `packages/db/src/schema/job.ts`, migration 0009

- [ ] **Step 1:** Add an index on `updated_at` (a plain `index("job_updatedAt_idx").on(table.updatedAt)` — the filter is a bare `lt(updatedAt)`; a composite `(status, updated_at)` is only worth it if the sweep is the dominant query, which it is not — the claim query dominates. Choose plain `updated_at` and comment why).
- [ ] **Step 2:** Generate migration 0009 via `drizzle-kit generate`, format meta files like the committed ones, `bun run db:test:migrate`, `bun tools/check-migrations.ts` green.
- [ ] **Step 3:** Commit: `feat(db): the settled-job sweep has an index on updated_at`.

### Task 2: The three bounded sweeps

**Files:** `apps/server/src/lib/jobs.repository.ts`, `apps/server/src/tasks.ts`, `apps/server/src/lib/idempotency.repository.ts`

- [ ] **Step 1:** Read the three current sweeps and their call sites (tasks.ts calls `sweepSettledJobs` at `:106-108` and inlines the counter sweep at `:97-100`; the reaper report line at `:117-121` prints the settled count — keep that number's meaning).
- [ ] **Step 2:** In `jobs.repository.ts`, rewrite `sweepSettledJobs` as a bounded loop: a module constant `SWEEP_BATCH_SIZE = 1000` (comment: a batch must stay well under the statement timeout and far smaller than a cron-gap backlog), and a loop that deletes `LIMIT <batch>` rows matching the predicate until zero, accumulating `rowCount`. Keyset vs plain LIMIT: the predicate is `lt(updatedAt, cutoff)` with no cursor needed — a plain `LIMIT` loop is correct because each iteration removes rows, so the next iteration's `LIMIT` sees the remainder; no cursor required (document this). Count via the result's `rowCount` (check drizzle's node-postgres result shape — `db.execute` returns `{ rowCount }`; `db.delete(...).returning(...)` returns rows — the loop should use `db.execute(sql`...`)` or `.limit()`; pick the form the repo already uses elsewhere).
- [ ] **Step 3:** Same pattern for `sweepExpiredKeys` in `idempotency.repository.ts` and the counter sweep in `tasks.ts` (if the counter sweep is a one-off inline, factor it into a local helper in tasks.ts or leave it inline with the same loop — choose the smallest change; tasks.ts's counter sweep deletes rate-limit rows by `lastRequest < now() - retention`).
- [ ] **Step 4:** Prove behavior with the DB: stage (via direct inserts, the `jobs.reaper.test.ts` pattern) more than one batch's worth of settled-old rows plus one newer settled row plus one running row; run each sweep; assert: all old settled removed, newer and running untouched, count equals the removed number. Run with explicit paths: `cd apps/server && bun test src/lib/jobs.test.ts src/lib/jobs.reaper.test.ts` (and the idempotency suite for `sweepExpiredKeys` — check whether it has one; if not, a small test in the idempotency suite covering the same three cases).
- [ ] **Step 5:** Commit: `perf(jobs): sweeps delete in bounded batches`.

## Done when

- All three sweeps delete in bounded loops with no `RETURNING` id buffering; count comes from affected rows.
- The `updated_at` index exists (migration 0009) and the drift gate is green.
- Old settled rows removed, newer/running/pending untouched, counts correct — proven against the test DB.
- `sweepSettledJobs(olderThan: Date): Promise<number>` signature unchanged (016's tests stay green).

## Out of scope

- **TEST-05** sweep coverage — plan 016, an earlier wave.
- The reaper (`reclaimStrandedJobs`) — plan 011 landed; untouched here.
- Any change to retention durations or the tasks.ts schedule.
