# Worker Loop and Sweep Coverage Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** TEST-04 (remainder) + TEST-05 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Cover the two worker behaviors no suite exercises: the full-batch poll decision, and the settlement sweep + backoff ceiling. The audit's TEST-04 (worker process coverage) is mostly done — `runOnce` is already extracted and tested — so this plan targets the remaining glue and the two TEST-05 gaps.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/worker.ts:138-159` — `loop()`: `processed = await runOnce(...)`; `if (processed < env.WORKER_BATCH_SIZE) await sleep(env.WORKER_POLL_MS)` — the full-batch decision is a one-liner inline at `:153-157`, untested.
2. `apps/server/src/lib/jobs.ts:65-186` — `runOnce` is exported and already unit-tested (`jobs.test.ts:126,149,158`, `jobs.settlement.test.ts:167,185`). The poll/sleep/drain glue with `process.exit` is entrypoint code; only the decision itself needs extraction.
3. `apps/server/src/lib/jobs.repository.ts:30,37` — `BACKOFF_BASE_MS = 1000`, `BACKOFF_MAX_MS = 5 * 60 * 1000`; the retry ladder at `:217-219` computes `least(base * 2^attempts, max) / 1000` seconds.
4. `apps/server/src/lib/jobs.test.ts:70-97` — the retry test drives attempts to `MAX_ATTEMPTS=5` and asserts poll-exclusion, but never asserts the exact backoff values (1s, 2s, 4s, … capped at 300s).
5. **No test calls `sweepSettledJobs` anywhere** (grep: only `tasks.ts` and `jobs.repository.ts`). `sweepSettledJobs` at `jobs.repository.ts:248-257` deletes `done`/`failed` older than the cutoff.
6. Plan 017 (landed before this one in the wave order) changes `jobs.test.ts`'s cleanup to per-test id staging — read the current file state after it lands and build on it.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- Test DB is up; `bun run db:test:migrate` once before DB tests.
- No file over 200 code lines.
- Do not run the full `bun run check` mid-flight (concurrent suites race the job table); run only explicit test paths.

## Do not

- Do not refactor the shutdown/exit paths (plans 009 owns the stdout flush there; keep away).
- Do not touch `sweepSettledJobs`'s signature or behavior — plan 026 (a later wave) owns its batching; this plan only tests it as it is.
- Do not change `BACKOFF_*` constants or the `least(...)` formula.
- Do not add a `sleep`-injected timer abstraction to worker.ts unless the extraction genuinely needs it — a pure decision function needs no timers.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/jobs.ts` | **Modify.** Export a pure `shouldPollImmediately(processed, batchSize)` (or equivalent) that `worker.ts` uses. |
| `apps/server/src/worker.ts:153-157` | **Modify.** Call the exported decision instead of the inline comparison. |
| `apps/server/src/lib/jobs.test.ts` (or a new `worker.loop.test.ts` — follow naming) | **Add.** Decision-function tests + backoff-value assertions + `sweepSettledJobs` test. |

### Task 1: The full-batch decision, extracted and pinned

**Files:** `apps/server/src/lib/jobs.ts`, `apps/server/src/worker.ts`

- [x] **Step 1:** Extract the decision to a pure exported function. Place it in `apps/server/src/lib/jobs.ts` beside `runOnce` (it is queue policy, and `worker.ts` can import it; check the file's import direction rules — lib/jobs.ts may not import worker.ts, but worker.ts may import lib/jobs.ts, which is already the case for `runOnce`):
  ```ts
  /**
   * Whether the worker should poll again immediately instead of sleeping.
   * A full batch means more work was already due when it was claimed, so
   * sleeping with a backlog just delays the next batch.
   */
  export function shouldPollImmediately(processed: number, batchSize: number): boolean {
    return processed >= batchSize;
  }
  ```
- [x] **Step 2:** In `worker.ts`, replace the inline comparison with the function call, keeping the comment (or moving it onto the function).
- [x] **Step 3:** Add tests (a new suite `worker.loop.test.ts` beside `jobs.ts` or inside the existing jobs suite — follow `tools/check-naming.ts`): boundary table — `(0, n) → false`, `(n-1, n) → false`, `(n, n) → true`, `(n+1, n) → true`, `(0, 0) → ?` (decide the degenerate case and pin it). Pure function, no DB needed. (Named `jobs.loop.test.ts` — `check-naming.ts` rejects `worker.loop.test.ts` because `lib/` has no `worker` module; `jobs.loop` names `jobs.ts`, which is where the decision lives.)
- [x] **Step 4:** Run with explicit paths: `cd apps/server && bun test src/lib/jobs.loop.test.ts` — green.
- [x] **Step 5:** Commit: `test(worker): the full-batch poll decision is pinned`.

### Task 2: The backoff ladder's exact values

**Files:** `apps/server/src/lib/jobs.test.ts`

- [x] **Step 1:** Read the existing retry test (`:70-97`). Extend it (or add a sibling) to assert, per attempt, that the new `run_at` is `now + min(1000 * 2^attempts, 300000)` ms — capture `run_at` before and after each `claimThenFail` step and assert the delta within a small tolerance (the suite runs fast; use e.g. ±1500ms or assert `>= min(...) - tolerance && <= min(...) + tolerance` — pick a tolerance that cannot pass with a wrong base or a missing cap). (Extended the existing retry test: mirrored `BACKOFF_BASE_MS`/`BACKOFF_MAX_MS` as literals (the repository keeps them private, matching the existing `MAX_ATTEMPTS` mirror), `BACKOFF_TOLERANCE_MS = 750` — far smaller than the 1000ms doubling step and the 212s a missing cap moves — and asserted the delta per attempt: 1s after the first fail, then 2s/4s/8s/16s inside the walk.)
- [x] **Step 5 (cap):** The cap binds from attempt 9 (2^9 s = 512s > 300s) — driving to attempt 9 is expensive. Instead, pin the cap by asserting the formula's shape: add a focused test that walks attempts 0..8 through the repository's backoff SQL (or, if that is impractical, assert the two constants exist with the documented values and that the formula `least(base * 2^attempts, max)` is the one used — read how `fail` embeds it at `:217-219` and choose the honest, deterministic option; do not fake a 9-attempt walk if it would take minutes). (Chose the honest walk: new `jobs.backoff.test.ts` stages one row per rung 0..10 in the strand state — `running`, locked, `attempts` set — and fails each through the real SQL; ~5ms per rung, no 9-attempt time sink. Rungs 0..8 assert 1s..256s exactly, rung 9 asserts the cap binds at 300s, rung 10 asserts it holds. Staging avoids the global `claim`, which would sweep concurrent suites' due rows out of their own tests.)
- [x] **Step 6:** Run: `cd apps/server && bun test src/lib/jobs.test.ts src/lib/jobs.backoff.test.ts` — green, 3x stable (7 pass, 0 fail each run).
- [x] **Step 7:** Commit: `test(jobs): the retry ladder's exact backoff is pinned`.

### Task 3: The settlement sweep

**Files:** `apps/server/src/lib/jobs.test.ts` (or a sibling suite)

- [ ] **Step 1:** Add a `sweepSettledJobs` test: stage rows via the DB (enqueue then settle some, or insert directly like `jobs.reaper.test.ts` does — read its `strand` helper pattern) covering:
  - a `done` row older than the cutoff → removed;
  - a `failed` row older than the cutoff → removed;
  - a `done` row newer than the cutoff → kept;
  - a `running` row older than the cutoff → **kept** (the sweep must not touch unsettled rows — this is the behavior plan 011's reaper depends on);
  - the returned count equals the number removed.
- [ ] **Step 2:** Clean up after the test by id (per plan 017's staged-ids pattern), never a full wipe.
- [ ] **Step 3:** Run with explicit paths and commit: `test(jobs): the settled-job sweep keeps unsettled rows`.

## Done when

- The full-batch poll decision is a pure tested function used by `worker.ts`.
- The retry ladder's backoff values (base, doubling, cap) are asserted.
- `sweepSettledJobs` is tested: settled-older removed, newer kept, `running`/`pending` untouched, count correct.
- No full-table wipes introduced; no `bun run check` run mid-flight.

## Out of scope

- The shutdown/exit paths (plan 009 owns the stdout flush).
- Batching `sweepSettledJobs` itself (plan 026, a later wave — this plan tests the current shape; if 026 changes it first, adapt the test to the new signature).
- **TEST-01** (the wipe race) — plan 017, landed in an earlier wave; this plan builds on its cleanup pattern.
