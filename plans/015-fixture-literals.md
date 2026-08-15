# Fixture Literals Shaped Like Live Credentials Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** SEC-08 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Remove the two fixture literals that are shaped like live credentials, so secret scanners stop tripping and copy-paste into real configs is not invited. Nothing in the tests depends on the literal values.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `packages/crypto/src/seal.test.ts:7` — `const SECRET = "sk_" + "live_" + <20 alphanumerics>;` (written here in pieces on purpose; the literal itself is what a scanner matches) — a Stripe live-secret shape.
2. `packages/http/src/response.fixtures.ts:22` — `export const LEAKED_SECRET = "postgres://admin:<a well-known joke password>@<an RFC 1918 address>/prod";` — a deliberate leak-test fixture whose whole point is proving a secret never reaches the response. The comment at fixtures.ts:15-21 says exactly that. The password and the private-range host are the scanner-tripping parts; the test's purpose survives renaming them.
3. Both are test-only fixtures; no production code reads them. Verified: no real credential is committed anywhere (`.env.example`/`.env.test` are clean).

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- The leak-test fixture must still prove its point: a credential-shaped string fed to the error path never reaches the response envelope.

## Do not

- Do not delete `LEAKED_SECRET` or the test that uses it — the leak test is a feature.
- Do not invent a live-key-prefixed replacement; the replacement must be obviously fake.
- Do not change `packages/http/src/response.failure.test.ts`'s assertions unless the literal value is asserted (it is not).

## File structure

| File | Responsibility |
|---|---|
| `packages/crypto/src/seal.test.ts:7` | **Modify.** Use an obviously fake key. |
| `packages/http/src/response.fixtures.ts:22` | **Modify.** Use an obviously fake DSN. |

### Task 1: Rename to obviously fake values

**Files:** `packages/crypto/src/seal.test.ts`, `packages/http/src/response.fixtures.ts`

- [x] **Step 1:** In `seal.test.ts`, replace the literal with an obviously-fake value; check whether any test asserts the exact string — it must not, since the fixture generates its own keys. **Shipped:** `const SECRET = "test-secret-not-a-real-credential";` — no key-like prefix at all, rather than the `sk_test_…` this step first suggested.
- [x] **Step 2:** In `response.fixtures.ts`, replace the DSN with an RFC 2606-reserved-host version that still exercises the leak path. Keep the comment explaining the fixture's purpose. **Shipped:** `"postgres://admin:change-me@db.example.invalid/prod"` — this step originally suggested keeping the old password and changing only the host, which would have left the scanner-tripping half in place; the password was replaced too.
- [x] **Step 3:** Run the affected suites with explicit paths: `cd packages/crypto && bun test src/seal.test.ts` and `cd packages/http && bun test src/response.failure.test.ts` (or whichever test file exercises `LEAKED_SECRET`). Expected: all green, no assertion on the literal.
- [x] **Step 4:** Confirm no other file references the old literals. The command run was `grep -rn "<the old key>\|<the old host>" --include="*.ts" .` → zero hits. That scope was narrower than the Done-when it was meant to satisfy: it did not look at markdown, and both literals survived in `plans/015-fixture-literals.md` and `plans/audit-report.md` until they were redacted. Re-run it without `--include` before believing the tree is clean.
- [x] **Step 5:** Commit: `chore(fixtures): live-key-shaped literals invite copy-paste`.

## Done when

- Neither original literal — the `sk_`+`live_` key nor the `admin:<password>@<RFC 1918 host>` DSN — remains anywhere in the working tree, including this plan and `plans/audit-report.md`, which is the point: a scanner that reads markdown reads those too.
- The leak-test fixture still proves a credential never reaches the response.
- Both affected suites pass.

## Out of scope

- Rotating any real credential (none exist in the repo).
- The `hunter2` password appearing in git history — the audit already verified no real credential was ever committed.
- **`apps/server/src/app.test.ts:16`** — `29f2515` (the plan-027 remediation, long after this plan landed) introduced a fresh connection-string literal reusing the same joke password, to give the masked-500 test something that "reads like the connection string an unexpected failure really would carry". `4b0e133` moved it onto the reserved host and obviously-fake password `LEAKED_SECRET` already uses, so it no longer reproduces the shape SEC-08 is about. Recorded here because the recurrence, not the string, is the lesson: nothing in the gate stops the next one.
