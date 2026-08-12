# CI Test Gate and Turbo Cache Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** TEST-02 + TEST-03 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** (TEST-03) stop turbo from caching the `test` task so a repeat `bun run check` re-runs every suite; (TEST-02) run the whole server suite once per CI run and grep the skip count from that one captured log, including the mail package's output.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `turbo.json:10-14` — `"test": { "dependsOn": ["^check-types"], "env": ["DATABASE_URL", "NODE_ENV"], "outputs": [] }` with **no `cache: false`**. `cache: false` already exists on 9 other tasks (dev:20, db:push:24, db:generate:28, db:migrate:32, db:studio:36, db:start:41, db:stop:45, db:down:48, db:watch:52) — the pattern is established; `test` just lacks it.
2. `.github/workflows/ci.yml:54-56` runs `bun run check` (which runs `turbo run check-types test` per `package.json:49`), then `ci.yml:60-69` runs `bun test` **again** inside `apps/server` purely to grep the skip count. The second run's scope never sees `packages/mail/src/queue.test.ts:76` (`describe.skipIf(!ready)`), so a mail-package skip is invisible to the grep.
3. `bun run check`'s turbo output is prefixed per task (`server:test:`, `mail:test:`) — a skip line inside turbo output reads `server:test:  0 pass / N skip` style, or `mail:test: (skip) ...`. The grep must match skips in that prefixed stream.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- CI workflow syntax must remain valid GitHub Actions (validate with `bunx yaml-lint` if available, or careful reading).

## Do not

- Do not remove the audit job or the `bun audit` gate in ci.yml.
- Do not touch `turbo.json`'s `build`/`check-types`/db task configs — only the `test` task gets `cache: false`.
- Do not add a `--force` flag anywhere permanent; the fix is the cache flag, not forcing.

## File structure

| File | Responsibility |
|---|---|
| `turbo.json:10-14` | **Modify.** Add `"cache": false` to the `test` task. |
| `.github/workflows/ci.yml:54-69` | **Modify.** Capture `bun run check` output to a log, grep skips from it, delete the second `bun test` run. |

### Task 1: Stop turbo from skipping the test gate

**Files:** `turbo.json`

- [x] **Step 1:** Add `"cache": false` to the `test` task, keeping the existing `dependsOn`, `env` and `outputs` keys.
- [x] **Step 2:** Prove it locally: `bun run check` twice in a row. The second run must **not** print `FULL TURBO` for the `test` task (check-types may still be cached — that is fine and desirable). Before the change, the second run was `19 cached, FULL TURBO, 27ms` for tests.
- [x] **Step 3:** Commit: `fix(turbo): the test gate must never be a cache hit`.

### Task 2: One suite run per CI run, one skip grep

**Files:** `.github/workflows/ci.yml`

- [ ] **Step 1:** Replace the `- run: bun run check` step with one that captures output:
  ```yaml
  - name: typecheck, tests, lint, catalog drift, and the architecture rules
    run: bun run check 2>&1 | tee /tmp/check.log
  ```
- [ ] **Step 2:** Rewrite the `Fail if any test was skipped` step to grep the captured log instead of re-running tests, and to cover the mail package's prefixed output:
  ```yaml
  - name: Fail if any test was skipped
    run: |
      if grep -qE '(^|:)[[:space:]]*[1-9][0-9]* skip|\(skip\)' /tmp/check.log; then
        echo "::error::integration tests were skipped — the test database was not reachable"
        exit 1
      fi
    env:
      TEST_DATABASE_URL: ${{ env.TEST_DATABASE_URL }}
  ```
  The pattern must match both turbo-prefixed lines (`server:test:  3 skip`) and the mail package's `(skip)` marker. Verify by reading `packages/mail/src/queue.test.ts:76` and `apps/server/test-db.ts` `skipNotice()` to know the exact shapes the suites print.
- [ ] **Step 3:** Delete the second `cd apps/server && bun test` block entirely — no test runs twice anymore.
- [ ] **Step 4:** Sanity-check the YAML indentation against the rest of the file; steps and `run:` blocks must align with the existing `- name:` / `run:` convention.
- [ ] **Step 5:** Commit: `ci: run the suite once and grep its own skip count`.

## Done when

- A repeat `bun run check` runs every test (no FULL TURBO on `test`).
- CI runs the server suite exactly once per run, and a skip anywhere — server, mail, or any package — fails the build with the error message naming the test database.
- The `bun run check` step still fails loudly when the suite itself fails (the `2>&1 | tee` pipe must not mask `bun run check`'s exit code — the step fails on the pipeline's last command; verify with `set -o pipefail` semantics in the runner, or note in the step comment).

## Out of scope

- **TEST-01** (job-table wipe race) — plan 017.
- **TEST-09** (gen-module tests) — plan 028.
- The `audit` job and `bun audit` policy.
