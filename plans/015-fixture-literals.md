# Fixture Literals Shaped Like Live Credentials Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** SEC-08 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Remove the two fixture literals that are shaped like live credentials, so secret scanners stop tripping and copy-paste into real configs is not invited. Nothing in the tests depends on the literal values.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `packages/crypto/src/seal.test.ts:7` — `const SECRET = "sk_live_51H8xQ2LkdIwHu7ix";` — a Stripe live-secret shape.
2. `packages/http/src/response.fixtures.ts:22` — `export const LEAKED_SECRET = "postgres://admin:hunter2@10.0.0.4/prod";` — a deliberate leak-test fixture whose whole point is proving a secret never reaches the response. The comment at fixtures.ts:15-21 says exactly that. The host `10.0.0.4` and the `hunter2` password are the scanner-tripping parts; the test's purpose survives renaming them.
3. Both are test-only fixtures; no production code reads them. Verified: no real credential is committed anywhere (`.env.example`/`.env.test` are clean).

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- The leak-test fixture must still prove its point: a credential-shaped string fed to the error path never reaches the response envelope.

## Do not

- Do not delete `LEAKED_SECRET` or the test that uses it — the leak test is a feature.
- Do not invent a `sk_live_`-looking replacement; the replacement must be obviously fake.
- Do not change `packages/http/src/response.failure.test.ts`'s assertions unless the literal value is asserted (it is not).

## File structure

| File | Responsibility |
|---|---|
| `packages/crypto/src/seal.test.ts:7` | **Modify.** Use an obviously fake key. |
| `packages/http/src/response.fixtures.ts:22` | **Modify.** Use an obviously fake DSN. |

### Task 1: Rename to obviously fake values

**Files:** `packages/crypto/src/seal.test.ts`, `packages/http/src/response.fixtures.ts`

- [ ] **Step 1:** In `seal.test.ts`, replace the literal with a test-shaped key, e.g. `"sk_test_51H8xQ2LkdIwHu7ix"` (or `"test-secret-key-32-bytes-long-..."` — any obviously-fake value; check whether any test asserts the exact string — it must not, since the fixture generates its own).
- [ ] **Step 2:** In `response.fixtures.ts`, replace the DSN with an RFC 2606-reserved-host version that still exercises the leak path, e.g. `"postgres://admin:hunter2@db.example.invalid/prod"` — `example.invalid` is reserved for exactly this. Keep the comment explaining the fixture's purpose.
- [ ] **Step 3:** Run the affected suites with explicit paths: `cd packages/crypto && bun test src/seal.test.ts` and `cd packages/http && bun test src/response.failure.test.ts` (or whichever test file exercises `LEAKED_SECRET`). Expected: all green, no assertion on the literal.
- [ ] **Step 4:** Confirm no other file references the old literal: `grep -rn "sk_live_51H8xQ2LkdIwHu7ix\|10.0.0.4" --include="*.ts" .` → zero hits outside git history.
- [ ] **Step 5:** Commit: `chore(fixtures): live-key-shaped literals invite copy-paste`.

## Done when

- No `sk_live_`/`10.0.0.4`/`hunter2@` literal remains in the working tree.
- The leak-test fixture still proves a credential never reaches the response.
- Both affected suites pass.

## Out of scope

- Rotating any real credential (none exist in the repo).
- The `hunter2` password appearing in git history — the audit already verified no real credential was ever committed.
