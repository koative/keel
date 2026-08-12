# Rate-Limit 429 Test Race Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** TEST-07 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Make the 429 test deterministic. Today it spends the whole WRITE_BUDGET serially and asserts `remaining` exactly 0, racing the bucket's one-token-per-second refill on slow runners. The suite already has a `primeBucket` helper; use it so the test cannot depend on how fast the loop runs.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/lib/rate-limit.test.ts:113-117` — `let last = await app.request("/things", { method: "POST" }); for (let spent = 1; spent < WRITE_BUDGET; spent += 1) { last = await app.request("/things", { method: "POST" }); }` — a strictly serial loop spending the whole budget; a `// biome-ignore` comment explains the burst must be serial to be countable.
2. `apps/server/src/lib/rate-limit.test.ts:122-132` — asserts the refused request returns 429, `error.code === "TOO_MANY_REQUESTS"`, `Retry-After: "2"`, `RateLimit-Limit`, `remaining: 0`.
3. `apps/server/src/lib/rate-limit.test.ts:58-64` — `primeBucket(key, tokens)` exists: `db.insert(apiRateLimit).values({ key, tokens }).onConflictDoUpdate({ set: { tokens, updatedAt: sql`now()` }, target: apiRateLimit.key })`.
4. `WRITE_BUDGET` at `:19`. The bucket refills one token per second, so the serial spend must complete in under 1s — the flake the finding names.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- Test DB is up. `bun run db:test:migrate` once before running.
- The 429 path must still be exercised through the real app, and the dedicated-bucket test (that already proves the 429 path deterministically) must stay.

## Do not

- Do not delete the serial-burst test's intent — concurrent-burst coverage is a separate test (see Task 2) — but the *refill-race* assertion must be deterministic.
- Do not change the rate limiter implementation.
- Do not weaken the assertions below `remaining: 0` — prime the bucket instead.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/rate-limit.test.ts` | **Modify.** Deterministic 429 test + optional concurrent-burst test. |

### Task 1: Prime instead of racing

**Files:** `apps/server/src/lib/rate-limit.test.ts`

- [ ] **Step 1:** Read the whole suite to see how the test app and the actor key for the write bucket are constructed, and what `primeBucket`'s callers look like.
- [ ] **Step 2:** Rewrite the budget-spend loop: prime the write bucket to `1` token, make **one** request, assert the 429 path (`remaining: 0`, `Retry-After: "2"`, `TOO_MANY_REQUESTS`). The refill can only have added a token if a whole second passed between the prime and the assertion — which would make `remaining` at most 1, and the existing `toBe(0)` assertion on a primed-to-1 spend is exact because the spend consumes the only token. If the suite already has a dedicated-bucket 429 test that does exactly this, reuse its shape rather than duplicating.
- [ ] **Step 3:** If the serial loop tested something the primed test does not (e.g. that every request up to the budget succeeds), keep that coverage but make its assertions refill-proof: assert `remaining <= 1` rather than exactly 0, or prime the bucket to the full budget first so the loop's consumption is exact again. State in a comment which choice you made and why.
- [ ] **Step 4:** Run the suite: `cd apps/server && bun test src/lib/rate-limit.test.ts` — green, several times in a row.
- [ ] **Step 5:** Commit: `test(rate-limit): the 429 assertion cannot race the refill`.

### Task 2 (optional, only if the audit's concurrent angle is genuinely uncovered)

- [ ] **Step 1:** Decide whether a concurrent burst (a `Promise.all` of WRITE_BUDGET requests against a fresh bucket) adds coverage the serial loop does not. If yes, add it with a primed-to-0 bucket and assert exactly one request failed (the loser) — or exactly budget-1 succeeded. If the added value is marginal (the middleware is a single conditional upsert), do not add it and say so in the commit message.
- [ ] **Step 2:** Commit if added: `test(rate-limit): concurrent burst leaves exactly one loser`.

## Done when

- The 429 test asserts exact values (`remaining: 0`, `Retry-After`) without a loop that must finish in under a second.
- The suite passes repeatedly.
- The rate limiter is untouched.

## Out of scope

- **TEST-08** (500-through-onError envelope) — plan 027.
- Changing the limiter's bucket math or refill rate.
