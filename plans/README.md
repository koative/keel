# keel — Audit plans index

- **Audited commit**: `39fd32c`
- **Full report**: [`plans/audit-report.md`](./audit-report.md) — all findings, with evidence and fix sketches.
- **Independently verified** against the same commit: 30 CONFIRMED, 14 PARTIAL, 1 FALSE (ARCH-08 — `oven/bun:1-slim` does ship a `node` wrapper and `node -e` works, so the dev compose healthcheck is fine). No finding was invented. The PARTIALs are real code with an overstated or misdirected impact — read the notes below before turning one into a plan.

## Execution order (revised after verification)

| Order | Plan | Finding | Why here |
|---|---|---|---|
| 1 | [Relative `VITE_SERVER_URL`](./001-relative-vite-server-url.md) | CORR-04 | The only live crash. Reproduced in a browser: a `/api` build dies with `Invalid environment variables`, an absolute build loads. Worst bug in a repo shipped as a template |
| 2 | `MAIL_DRIVER=log` guard | SEC-04 | `.env.example:74` ships `MAIL_DRIVER=log`, so `cp .env.example .env` plus the prod compose puts one-time links in retained container logs with no warning |
| 3 | turbo `test` cache + CI double run | TEST-03 + TEST-02 | **Must ship together.** `turbo run test` twice in a row is `19 cached, FULL TURBO, 27ms` — the gate does not run. Only CI's redundant second run currently catches tests, so anyone who removes that redundancy alone disables testing entirely |
| 4 | Trusted-proxy posture | SEC-03, revised | Better Auth reads `x-forwarded-for` by default, so `packages/auth/src/index.ts:66-69`'s "coarse but unforgeable bucket" is wrong: a forged single-value header wins its own bucket and evades the limit. It also already logs a warning, so this is promoting an existing runtime warning to a startup refusal |
| 5 | Unverified sign-in | SEC-02 | Confirmed and worse than written: `autoSignIn` is unset too, so sign-up returns a live session before any verification |
| 6 | Settlement-failure separation | CORR-02 | Confirmed, but narrower than written — `fail` is fenced on `status = 'running'`, and both shipped handlers are already idempotent. The live defect is a completed job burning attempts and recording a settlement error as a work error |
| 7 | Open-redirect fix | SEC-01 | Confirmed: an absolute `href` makes TanStack Router set `reloadDocument` and hit `window.location.href`. The allowlist blocks `javascript:`, not a cross-origin `https:` |
| 8 | Reaper for `running` jobs | CORR-01 | Confirmed. One correction: both SIGINT and SIGTERM are handled (`worker.ts:211`); the finding survives because SIGKILL is uncatchable, not because a signal was missed |
| 9 | Mail fetch timeout | PERF-01 | Confirmed outright |

### Reframe before planning

- **CORR-07** is not a tenancy hole. `requireOrg` verifies membership before `idempotent` runs, so nothing reaches an unauthorized party; the harm is a silently dropped write after an organization switch.
- **CORR-03**'s loser gets a **409**, not a 200. The double execution is signalled, and `idempotency.ts:110-116` chose that deliberately.
- **TEST-01**'s mechanism is wrong: `bun test` runs files sequentially unless `--parallel` is passed. Only the turbo-level server-vs-mail concurrency can race.
- **ARCH-03** is inverted: Renovate's native bun manager already bumps literal ranges; the customManager exists for the un-bumpable `catalog:` strings. Only "move the shadcn CLI to devDependencies" survives.
- **PERF-02** is capped by the pool's `statement_timeout`; the real failure is a sweep that aborts and never prunes. Two of the three sweeps are already indexed.
- **TEST-05**'s backoff cap is dead code (`maxAttempts` defaults to 5, the cap binds from attempt 9), so it cannot be tested without changing configuration first.
- **TEST-06**: Bun's `S3Client` owns SigV4, not this repo. The one signing choice the repo does own — the `virtualHostedStyle` inversion — is already covered.
- **TEST-08**: `idempotency.test.ts:121` already drives a real throw to a 500 through the same `onError`, and the security headers are asserted in `app.test.ts:96`. Only `requestBodyLimit` is genuinely untested.
- **ARCH-04**: `packages/db` does use `dotenv`, in `drizzle.config.ts`. The fix is moving it to `devDependencies`, not deleting it.
- **ARCH-06**: the duplicate zod hangs off the shadcn CLI and never enters the bundle graph. The duplicate `@tanstack/react-store` is real and does double-ship.
- **ARCH-07**: the server bundle is not minified, so line and column survive; the loss is source-file attribution only.

### Missed by the report

- `biome.jsonc:187-217` — the `noRestrictedImports` block policing `*.repository.ts`, `*.schema.ts` and `*.fixtures.ts` inside modules has **no** `check-rules` fixture, directly contradicting the claim at `biome.jsonc:184` that every one of them is proven to still fire. More valuable than either rule TEST-10 names.

Each chosen finding becomes a self-contained plan file (`001-<slug>.md`, …) stamped with the audited commit for drift detection.

## Handoffs for unwritten plans

- **For plan 021 (README/AGENTS.md counts)**: plan 022 Task 3 Step 3 carried a replacement clause for `AGENTS.md:49-51`, which 021 owns. It reads:

  > Webhook receivers verify over `await c.req.arrayBuffer()`, refuse a delivery stamped more than five minutes from now, persist, enqueue under the provider's event id, return 200; a re-stringified body produces a different digest and rejects every event.

## Status

All 38 plans executed on top of `39fd32c`, then reviewed and repaired. `bun run check` is green: 21/21 turbo tasks, 277 tests, lint clean, and all six checkers passing.

The repair pass matters more than the table. Eight read-only reviewers were pointed at the executed program, one per subsystem, and told to judge the code at `HEAD` rather than the commit messages. They found that **the gate had been reporting green on a red tree the whole time**: `bun run check 2>&1 | tee` ran in a CI step with no `shell: bash`, so GitHub invoked it as `bash -e {0}` with no `pipefail` and the step exited with `tee`'s status. Behind that, nine files were committed unformatted, a naming violation reached `main`, and several plans ticked a box no test defended. Twelve fix agents then closed every confirmed finding. The five that would otherwise have shipped broken behaviour:

| Defect | Where it came from | Fix |
|---|---|---|
| CI reported success on a red tree | plan 003 wrote a comment asserting `pipefail` instead of enabling it | `674e488` — `defaults.run.shell: bash` |
| Every webhook delivery failed as an unregistered kind | plan 025 registered `webhook.process` inside the `ai.generate` handler body | `d89ae4a` — registry extracted to `registry.ts`, kinds pinned by a suite |
| A new user could never finish signing up | plan 008 gated sign-in without touching the form, which navigated a sessionless user into the guarded area | `ecc8ae1`, `bb61323` — an inbox state, and a verification link that points at the SPA |
| Two tenants sharing one AI dedupe key collapsed into one job | plan 035 wrote a client string into a globally unique column | `f656760` — the key is namespaced by organization server-side |
| A relative `/` in `VITE_SERVER_URL` crashed the SPA at boot | plan 001 widened the schema past what its own resolver accepts, and a test certified it | `24507b7` — schema and resolver agree, and the suite asserts the rejection |

Two further classes were structural rather than behavioural. Four job suites deleted or failed rows they did not create, so a green run depended on which suite went first. And three "proofs" passed with the fix reverted: the masked 500 ran against a hand-built Hono the plan had explicitly forbidden, the SigV4 vector re-derived its own expectation, and the generated tenancy suite gated on a table name it guessed wrong — `api-keys` probes `apikey` while the table is `api_key` — so it skipped forever while reporting nothing.

| # | Plan | Finding | Status |
|---|---|---|---|
| 001 | [Relative `VITE_SERVER_URL`](./001-relative-vite-server-url.md) | CORR-04 | Executed; repaired — a bare `/` was accepted and crashed at boot |
| 002 | [`MAIL_DRIVER=log` production guard](./002-mail-driver-production-guard.md) | SEC-04 | Executed |
| 003 | [CI test gate + turbo cache](./003-ci-test-gate-and-turbo-cache.md) | TEST-02, TEST-03 | Executed; repaired — the `tee` pipe masked every gate |
| 004 | [Resend request timeout](./004-resend-request-timeout.md) | PERF-01 | Executed |
| 005 | [Body-limit 413 + coverage](./005-body-limit-status-and-coverage.md) | CORR-06, TEST-08 | Executed; one test nothing could make fail was deleted |
| 006 | [Client-IP posture](./006-client-ip-posture.md) | SEC-03 | Executed |
| 007 | [Open redirect](./007-open-redirect.md) | SEC-01 | Executed; repaired — a rejected target errored the login route instead of falling back |
| 008 | [Require email verification](./008-require-email-verification.md) | SEC-02 | Executed; repaired — sign-up looped, and the mailed link landed on a JSON 404 |
| 009 | [AI generation logging](./009-ai-generation-logging.md) | SEC-06 | Executed |
| 010 | [Job settlement separation](./010-job-settlement-separation.md) | CORR-02 | Executed (contract for 011 landed) |
| 011 | [Stranded job reaper](./011-stranded-job-reaper.md) | CORR-01 | Executed, reconciled with 024; plan text rewritten to the shipped design |
| 012 | [Idempotency claim-first + tenant scope](./012-idempotency-claim-first-tenant-scope.md) | CORR-03, CORR-07 | Executed (migration 0006) |
| 013 | [Session lifetime](./013-session-lifetime.md) | SEC-07 | Executed |
| 014 | [Enforcement coverage](./014-enforcement-coverage.md) | TEST-10, TEST-11 | Executed; two pattern groups were still unfixtured — now 22 fixtures |
| 015 | [Fixture literals](./015-fixture-literals.md) | SEC-08 | Executed; the literals survived in tracked markdown and were redacted |
| 016 | [Worker loop + sweep coverage](./016-worker-loop-and-sweep-coverage.md) | TEST-04, TEST-05 | Executed; the sweep's count assertion was a lower bound and is now exact |
| 017 | [Job-table wipe race](./017-job-table-wipe-race.md) | TEST-01 | Executed; repaired — three suites still wiped, and its own evidence named one of them as clean |
| 018 | [SigV4 known answer](./018-sigv4-known-answer.md) | TEST-06 | Executed; repaired — the vector lived in a comment and the date was read from the output |
| 019 | [Prod compose optional keys](./019-prod-compose-optional-keys.md) | DOCS-03 | Executed; `check-env` now also rejects a defaulted value |
| 020 | [Rate-limit 429 race](./020-rate-limit-429-race.md) | TEST-07 | Executed; the burst test reintroduced the same refill race and was rewritten |
| 021 | [README + AGENTS.md accuracy](./021-readme-agents-accuracy.md) | DOCS-01, DOCS-02 | Executed |
| 022 | [Webhook replay window](./022-webhook-replay-window.md) | SEC-05 | Executed; window and signed timestamp confirmed correct on review |
| 023 | [Migration 0001 upgrade path](./023-project-organization-backfill.md) | CORR-05 | Executed via Option A — `0001` edited in place; safe, see the note below |
| 024 | [Dedupe across the running window](./024-dedupe-running-window.md) | CORR-08 | Executed (migration 0005) |
| 025 | [Webhook receiver reference](./025-webhook-receiver-reference.md) | DIR-03 | Executed; repaired — the handler was never registered, and a failed enqueue orphaned the event |
| 026 | [Bounded retention sweeps](./026-bounded-retention-sweeps.md) | PERF-02 | Executed (migration 0008); the reaper sat outside the guard and the batch lock was inert |
| 027 | [500 through the onError envelope](./027-500-through-onerror-envelope.md) | TEST-08 | Executed; repaired — the assertion ran against a hand-built Hono the plan forbade |
| 028 | [gen-module test scaffolding](./028-gen-module-test-scaffolding.md) | TEST-09 | Executed; repaired twice — the suites did not typecheck, then gated on a guessed table name |
| 029 | [Declaration bundle `/v1` surface](./029-declaration-bundle-v1-surface.md) | ARCH-01 | Executed; the gate now asserts the absence of `/v1` literally |
| 030 | [API client credentials spread](./030-api-client-credentials-spread.md) | ARCH-02 | Executed; repaired — the caller's init still won over `credentials` |
| 031 | [Catalog + unused deps](./031-catalog-and-unused-deps.md) | ARCH-03, ARCH-04 | Executed |
| 032 | [Migration drift hand-edits](./032-migration-drift-hand-edits.md) | ARCH-05 | Executed; the gate now reads the journal and catches a migration-only column |
| 033 | [Duplicate transitive deps](./033-duplicate-transitive-deps.md) | ARCH-06 | Executed |
| 034 | [Server source maps](./034-server-source-maps.md) | ARCH-07 | Executed; repaired — the maps embedded the full TypeScript source into the image |
| 035 | [AI enqueue endpoint](./035-ai-enqueue-endpoint.md) | DIR-01 | Executed; repaired — the dedupe key was a global cross-tenant mutex |
| 036 | [Storage presigned routes](./036-storage-presigned-routes.md) | DIR-02 | Executed; repaired — mounted off the typed router, and the 503 leaked the unset keys |
| 037 | [Sealed-secrets consumer note](./037-seal-consumer-note.md) | DIR-04 | Executed |
| 038 | [Projects update comment](./038-projects-update-comment.md) | DIR-05 | Executed |

ARCH-08 has no plan: it is the one finding the verification pass rejected outright.

**Reconciliation note (011 × 024):** plan 024 widened the dedupe index to cover `running` after 011 landed. The reaper's collapse branch became unreachable and its key-nulling on requeue would have reopened the duplicate window 024 closes; the reaper now requeues with the key held until settlement. See the reconciled "Done when" in [011](./011-stranded-job-reaper.md).

**Why editing a committed migration was safe (023):** drizzle gates re-application on the stored `created_at` against the journal's `when`, and never compares the sha256 it also stores. `0001`'s `when` is unchanged, so a database that already applied the old `0001` skips it; the stored hash goes stale and nothing reads it. Verified by applying both trees to scratch databases and diffing `pg_dump --schema-only`: identical. This is an exception and not the standing rule — the rule is still a new numbered migration.

**What to carry forward.** Every defect above was invisible to a fast agent reading its own diff, and visible to a reviewer reading the code. Three habits caught all of them: run the gate rather than a scoped subset, revert the fix and require the test to fail, and treat a comment that asserts behaviour as a claim to verify rather than documentation to trust.
