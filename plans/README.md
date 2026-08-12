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

All plans executed on top of `39fd32c` via parallel agents; `bun run check` green (21/21 tasks, 20 architecture rules verified, migrations match).

| # | Plan | Finding | Status |
|---|---|---|---|
| 001 | [Relative `VITE_SERVER_URL`](./001-relative-vite-server-url.md) | CORR-04 | Executed (browser-verified boot) |
| 002 | [`MAIL_DRIVER=log` production guard](./002-mail-driver-production-guard.md) | SEC-04 | Executed (worker refuses to boot) |
| 004 | [Resend request timeout](./004-resend-request-timeout.md) | PERF-01 | Executed |
| 005 | [Body-limit 413 + coverage](./005-body-limit-status-and-coverage.md) | CORR-06 | Executed (413 declared on `/v1` POST) |
| 006 | [Client-IP posture](./006-client-ip-posture.md) | SEC-03 | Executed (startup refusal verified) |
| 010 | [Job settlement separation](./010-job-settlement-separation.md) | CORR-02 | Executed (contract for 011 landed) |
| 011 | [Stranded job reaper](./011-stranded-job-reaper.md) | CORR-01 | Executed, reconciled with 024 |
| 014 | [Enforcement coverage](./014-enforcement-coverage.md) | TEST-10 | Executed (20 rules verified) |
| 019 | [Prod compose optional keys](./019-prod-compose-optional-keys.md) | DOCS-03 | Executed (`check-env` wired into the gate) |
| 022 | [Webhook replay window](./022-webhook-replay-window.md) | SEC-05 | Executed (window + receiver contract) |
| 024 | [Dedupe across the running window](./024-dedupe-running-window.md) | CORR-08 | Executed (migration 0005) |

**Reconciliation note (011 × 024):** plan 024 widened the dedupe index to cover `running` after 011 landed. The reaper's collapse branch became unreachable and its key-nulling on requeue would have reopened the duplicate window 024 closes; the reaper now requeues with the key held until settlement. See the reconciled "Done when" in [011](./011-stranded-job-reaper.md).
