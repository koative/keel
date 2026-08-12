# keel — Full Repository Audit

- **Date**: 2026-08-12
- **Commit audited**: `39fd32c`
- **Method**: 8 parallel read-only scout agents (one per area), then every finding vetted against the cited code by the lead. Scout coverage: server core surface, async/background surface, security pass, packages, web app, tests & tooling, infra & dependencies, docs & direction. No code was modified; the report is the only artifact.

**Verdict**: This is an unusually well-engineered starter. Tenancy, the response envelope, the queue, the auth flows, the env discipline and the migration drift gate all hold up under direct reading; the README's runtime claims check out one by one, and no committed secrets exist. The findings below are real but concentrated in four themes:

1. **Prod-safety guards are documented but not enforced** — a production deploy can silently run with `MAIL_DRIVER=log` (token URLs in container logs), no trusted proxy config (one global auth rate-limit bucket), and unverified email sign-in, all while looking healthy.
2. **The queue is correct under graceful life, wrong under crash** — no reaper for `running` jobs (hard kill = at-most-once), and a settlement failure is classified as a work failure (double execution).
3. **Shipped subsystems without triggers** — AI, storage, sealed secrets and the webhook receiver pattern are fully implemented, unit-tested and documented, but no application code can reach any of them.
4. **Small, silent drift** — a relative `VITE_SERVER_URL` crashes the SPA at boot despite being the documented deployment wiring; migration 0001 cannot apply to a 0000-era database with rows; the typed-client declaration bundle degrades the `/v1` surface to `any` under `skipLibCheck`.

---

## Findings by leverage (impact ÷ effort)

| # | Finding | Category | Impact | Effort | Risk | Confidence |
|---|---|---|---|---|---|---|
| SEC-04 | `MAIL_DRIVER=log` in production prints one-time-token URLs to stdout, no guard | Security | HIGH | S | LOW | HIGH |
| CORR-02 | Failed `complete` is treated as handler failure → completed work re-runs | Correctness | HIGH | S | LOW | HIGH |
| CORR-04 | `VITE_SERVER_URL: z.url()` rejects documented relative values → SPA crashes at boot on the Docker/Vercel wiring | Correctness | HIGH | S | LOW | HIGH |
| TEST-03 | turbo caches the `test` task → repeat `bun run check` skips every test, green | Tests/CI | MED | S | LOW | MED |
| TEST-02 | CI runs the whole server suite twice; skip-grep misses packages/mail | Tests/CI | MED | S | LOW | HIGH |
| SEC-03 | Unverified accounts can sign in (contradicts the file's own rationale) | Security | MED | S | MED | MED |
| CORR-01 | No reaper for `running` jobs — a killed worker loses work forever | Correctness | HIGH | M | MED | HIGH |
| PERF-01 | Resend `fetch` has no timeout — one hung socket stalls the entire serial worker | Performance | MED | S | LOW | HIGH |
| SEC-01 | Open redirect via `?redirect=` | Security | MED | S | LOW | HIGH |
| TEST-01 | Job-table full wipe races parallel suites in CI | Tests/CI | MED | S | LOW | HIGH |
| CORR-03 | Idempotency middleware is check-then-act — concurrent same-key double execution | Correctness | MED | M | MED | HIGH |
| DOCS-01 | README claims "thirteen rules"; fixtures hold 16 | Docs | LOW | S | LOW | HIGH |
| TEST-09 | gen-module scaffolds untested HTTP and repository surfaces | Tooling | MED | M | LOW | HIGH |
| TEST-10 | Two enabled Biome rules have no check-rules fixture | Tooling | MED | S | LOW | HIGH |
| SEC-02 | No session lifetime decision (7-day Better Auth default) | Security | LOW | S | LOW/MED | HIGH |
| PERF-02 | Unbounded single-statement sweeps (`RETURNING`, unindexed `updated_at`) | Performance | MED | M | MED | MED |

Full detail follows, grouped by category.

---

## Security

### SEC-01 Open redirect via `?redirect=`
- **Evidence**: `apps/web/src/routes/login.tsx:16-19` — `validateSearch: z.object({ redirect: z.string().optional() })` accepts any string and forwards it; `apps/web/src/components/sign-in-form.tsx` and `sign-up-form.tsx` `navigate({ href: redirectTo })` after success. TanStack Router treats a full-URL `href` as an external navigation, so `?redirect=https://evil.example` sends the just-signed-in user to an attacker-controlled page on a trusted origin.
- **Impact**: Phishing vector on the repo's own domain; the redirect is user-visible and easy to weaponize in invite/sign-in flows. The comment says "validated rather than read raw", but `z.string()` validates only that it is a string.
- **Effort**: S
- **Risk**: LOW — restricting to relative paths cannot break the legitimate flows (guards only ever pass `/dashboard`, invitation paths).
- **Confidence**: HIGH (verified both files; session cookie is `SameSite=lax` in prod, so no credential leak — the damage is the redirect itself)
- **Fix sketch**: `z.string().refine((v) => v.startsWith("/") && !v.startsWith("//"))` or validate against the router's own route tree.

### SEC-02 Unverified accounts can sign in
- **Evidence**: `packages/auth/src/index.ts:143-174` — `emailAndPassword` sets `enabled: true` and `sendResetPassword` but never `requireEmailVerification`; `emailVerification.sendOnSignUp: true` with the comment "the alternative is an account whose address has never been proven: password reset then mails a stranger".
- **Impact**: An attacker registering with a victim's address can sign in immediately, create organizations (limit 10), invite members (mailing real addresses), and trigger resets to the victim — exactly the "mails a stranger" scenario the comment claims to prevent. Better Auth's default for `requireEmailVerification` is `false`.
- **Effort**: S
- **Risk**: MED — requires the SPA to route the not-verified state; pre-verification sign-in breaks.
- **Confidence**: MED (Better Auth default behavior; the flag is verifiably absent)
- **Fix sketch**: Set `requireEmailVerification: true` and handle the not-verified response in the SPA, or document why unverified sign-in is the intended posture.

### SEC-03 Production ships the sign-in limiter as one global bucket per path
- **Evidence**: `docker-compose.prod.yml:63-64` — `TRUSTED_IP_HEADER` and `TRUSTED_PROXIES` ship as `${VAR:-}` (silently empty); `packages/auth/src/index.ts:71-78` documents that with no IP resolution "every caller shares one rate-limit bucket per path"; the credential rule is 10 per 60 s (`packages/auth/src/index.ts:263-278`).
- **Impact**: Out of the box, all sign-in/sign-up/reset traffic for the whole user base draws from one 10-per-60 s bucket per path: six legitimate sign-ins in a minute exhaust it, and one attacker locks out the entire sign-in surface for a minute. The README documents the stance, but nothing refuses or warns at startup on `NODE_ENV=production` with the header unset — the failure is silent.
- **Effort**: S
- **Risk**: LOW — a startup/compose validation changes nothing for correctly configured deployments.
- **Confidence**: MED (the hazard is documented by the repo itself; the gap is the missing guard)
- **Fix sketch**: In `@keel/env` or `resolveMailConfig`-style resolver, fail or warn on `NODE_ENV=production` without `TRUSTED_IP_HEADER`; require `TRUSTED_PROXIES` whenever the header is set (a set header without proxies silently falls back to the shared bucket behind a proxy that appends).

### SEC-04 `MAIL_DRIVER=log` in production prints one-time-token URLs to stdout
- **Evidence**: `packages/mail/src/send.ts:26-45` — `writeToLog` prints the full `message.text`/`message.html`, which carry the single-use verification/reset/invitation URLs rendered in `packages/auth/src/index.ts:174-178`; `docker-compose.prod.yml:49` requires `MAIL_DRIVER` but accepts `log`; `apps/server/src/lib/mail.ts` guards only `resend`-without-key and the sandbox sender.
- **Impact**: A production deployment running `log` ships every magic link — a bearer credential — into json-file container logs, aggregated and readable far more broadly than the app database. The repo itself classifies mail payloads as "a live one-time link at rest" (`apps/server/src/tasks.ts:41-47`). The README warns about this, but nothing enforces it.
- **Effort**: S
- **Risk**: LOW — refuse or warn on `NODE_ENV=production` + `MAIL_DRIVER=log`; dev/test unchanged.
- **Confidence**: HIGH (both files read)
- **Fix sketch**: `resolveMailConfig` (or the prod compose) refuses `MAIL_DRIVER=log` when `NODE_ENV=production`, with an explicit opt-out key.

### SEC-05 Webhook verification has no timestamp or replay window
- **Evidence**: `apps/server/src/lib/webhook.ts:41-46,75-79` — `SignatureInput` is `{ header, rawBody, secret }` only; the HMAC over raw bytes with timing-safe compare is sound, but there is no timestamp parameter and no tolerance check. The documented receiver pattern (verify → persist raw → enqueue → 200) persists a fresh row per replay; replay protection is left to a future module's choice of dedupe key.
- **Impact**: A captured valid webhook request replays indefinitely and still verifies; when the first receiver lands, replay protection is re-derived from scratch (and the queue's dedupe collapses only `pending` jobs — see CORR-08).
- **Effort**: S
- **Risk**: LOW — no consumer exists yet; the change tightens the contract receivers inherit.
- **Confidence**: MED (about the primitive; the absence of any receiver is HIGH)
- **Fix sketch**: Extend `verifySignature` with a timestamp parameter + tolerance window checked in the same pass, and document that the enqueue dedupe key must be the provider's event id.

### SEC-06 `ai.generate` prints the unbounded completion to stdout
- **Evidence**: `apps/server/src/worker.ts:105-107` — the handler writes the entire `generation.text` to stdout; the comment marks the line as a deliberate seam ("a starter has nowhere honest to put it"). Prompts persist in job payloads by design (retry semantics).
- **Impact**: Any deployment that enqueues AI jobs ships user-supplied content and its output into container logs; if prompts contain customer data, that data enters the log pipeline. `process.exit(0)` in shutdown does not flush buffered stdout to a pipe, so the write can also be lost exactly when it is the only record of the answer.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: HIGH (file read; severity MED — gated behind an unreachable feature, see DIR-01)
- **Fix sketch**: Gate the echo behind `NODE_ENV !== "production"` (or a flag) and cap its length; flush or await stdout before `process.exit` in the shutdown path.

### SEC-07 Session lifetime left at Better Auth's 7-day default
- **Evidence**: `packages/auth/src/index.ts` — no `session.expiresIn` anywhere while every other auth knob is deliberately pinned; the 7-day default is cited as fact in `apps/server/src/lib/membership.repository.ts:9-15`.
- **Impact**: A stolen session cookie stays valid for up to 7 days with no rotation. `requireOrg`'s membership re-check mitigates removed members but not cookie theft.
- **Effort**: S
- **Risk**: LOW/MED — shortening forces re-auth; the SPA must surface the 401-to-sign-in path cleanly.
- **Confidence**: HIGH that it is unset; MED on impact
- **Fix sketch**: Set an explicit `session.expiresIn` (e.g. 1 day) with Better Auth's sliding `updateAge`, so the value is a decision rather than an inherited default.

### SEC-08 Fixture literals shaped like live credentials
- **Evidence**: `packages/crypto/src/seal.test.ts:7` — `"sk_live_51H8xQ2LkdIwHu7ix"` (Stripe live-secret shape); `packages/http/src/response.fixtures.ts:22` — `"postgres://admin:hunter2@10.0.0.4/prod"` (a deliberate leak-test fixture).
- **Impact**: Live-key-prefixed literals trip every secret scanner and invite copy-paste into real configs. Verified: no real credential is committed (only `.env.example`/`.env.test` are tracked, both clean).
- **Effort**: S
- **Risk**: LOW
- **Confidence**: HIGH
- **Fix sketch**: Rename to obviously fake values (`sk_test_…`, `example.com` DSN). Nothing suggests either was ever real; if in doubt, rotate per policy.

---

## Correctness

### CORR-01 No reaper for `running` jobs — a killed worker loses work forever
- **Evidence**: `apps/server/src/lib/jobs.repository.ts:86-89` — `claim` sets `locked_at`/`locked_by`/`running`, and nothing in the repo ever reads `locked_at` again (grep across `apps/server` and `packages/db` finds no consumer); `apps/server/src/lib/jobs.ownership.test.ts:32-34` explicitly defers a reaper to "later". Graceful shutdown covers only SIGTERM (`apps/server/src/worker.ts`).
- **Impact**: SIGKILL/OOM strands the claimed batch in `running` permanently: no retry, no failure, no re-enqueue. At-least-once delivery becomes at-most-once on any hard crash. The dedupe slot is freed on claim, so nothing even blocks a re-enqueue that never happens.
- **Effort**: M
- **Risk**: MED — the ownership fences (`complete`/`fail` keyed on worker id) exist precisely to make reclaim safe; the reaper needs a `locked_at` age threshold so it never reclaims a merely-slow worker's row.
- **Confidence**: HIGH (code read; the gap is acknowledged in the test suite)
- **Fix sketch**: Requeue `status = 'running' AND locked_at < now() - timeout` to `pending` with bounded attempt credit, run from `tasks.ts`, using the existing fences.

### CORR-02 A failed `complete` is treated as a handler failure — completed work re-runs
- **Evidence**: `apps/server/src/lib/jobs.ts:78-87` — `await complete(entry.id, workerId)` sits inside the same `try` as the handler; the `catch` calls `fail(...)`, which increments `attempts`, re-arms the job `pending` and reschedules it (`jobs.repository.ts:150-172`).
- **Impact**: If `complete` throws transiently (pool hiccup) while `fail` succeeds, a job whose side effect already happened is retried. Mail is shielded today by Resend's `Idempotency-Key: jobId`; every future handler inherits the hazard. If `fail` also throws, the job stays `running` with no reaper (CORR-01).
- **Effort**: S
- **Risk**: LOW — separate settlement from execution; the semantics are unambiguous.
- **Confidence**: HIGH (code read)
- **Fix sketch**: Move `complete` out of the handler's `try` into its own error path (retry it, or record a distinct settlement-failure marker) so a settlement failure cannot look like a work failure.

### CORR-03 Idempotency middleware is check-then-act
- **Evidence**: `apps/server/src/lib/idempotency.ts:80-117` — `findByActorAndKey` is read before `await next()` runs the handler; the unique insert happens only afterwards. Two concurrent same-key requests both see no row, both run the handler, and the loser surfaces a 409 after its side effect executed. The expired-key branch (`deleteById` then re-run) has the same window.
- **Impact**: The 409 is the honest answer the code's own comment describes, but the double execution is hidden: a concurrent double-submit can write/charge twice while appearing idempotent.
- **Effort**: M
- **Risk**: MED — pre-inserting a claim row changes the stored-row shape (pending state + update path), but the unique index already arbitrates correctly.
- **Confidence**: HIGH (code read)
- **Fix sketch**: Insert a claim row keyed on actor+key before running the handler; on conflict, wait for the committed row and replay it; overwrite with the response after success. Closes the window for both the fresh and expired-key paths.

### CORR-04 `VITE_SERVER_URL: z.url()` rejects the documented relative-value wiring
- **Evidence**: `packages/env/src/web.ts:16` — `VITE_SERVER_URL: z.url()` rejects any leading-slash value; `.env.example` documents "A leading-slash value is resolved against the current origin, which is how the Docker and Vercel deployments are wired"; `apps/web/src/lib/server-url.ts:2-5` implements exactly that resolution; `apps/web/Dockerfile:9-10` passes `VITE_SERVER_URL` as a build arg. `apps/web/Dockerfile:4` sets `SKIP_ENV_VALIDATION=1`, which is what keeps the contradiction invisible.
- **Impact**: Any deployment following the documented relative wiring ships an SPA that throws at module import — the resolver that exists to handle the value never runs. Absolute-value deployments (the example default) are unaffected, which is why it has gone unnoticed.
- **Effort**: S
- **Risk**: LOW — loosening a client-only validation; `serverOrigin()` already throws with a good message on genuinely unresolvable values.
- **Confidence**: HIGH (zod `z.url()` semantics + both files read)
- **Fix sketch**: Accept relative values in `web.ts` (`z.string().min(1).refine((v) => v.startsWith("/") || URL.canParse(v))`) or validate post-resolution; add one test.

### CORR-05 Migration 0001 cannot apply to a 0000-era database with project rows
- **Evidence**: `packages/db/src/migrations/0001_organizations_jobs.sql:61` — `ALTER TABLE "project" ADD COLUMN "organization_id" text NOT NULL` with no DEFAULT and no backfill, against a table that `0000_initial.sql` created with real rows.
- **Impact**: Postgres refuses `ADD COLUMN … NOT NULL` on a non-empty table; any 0000-era deployment with projects aborts mid-migration with no recovery path documented. Fresh installs (empty DB) are unaffected.
- **Effort**: S–M
- **Risk**: MED — never edit committed 0001; the fix must be a new numbered migration.
- **Confidence**: MED (upgrade-path hazard; fresh installs fine)
- **Fix sketch**: Ship a 0005 that adds `organization_id` nullable, backfills, then `SET NOT NULL`.

### CORR-06 Body-limit rejection is a 400, but the contract says 413
- **Evidence**: `apps/server/src/lib/security.ts:50-56` — `requestBodyLimit`'s `onError` throws `badRequest(...)` → 400; `apps/server/src/index.ts:25-27` promises "a diagnosable 413"; the v1 POST contract (`projects.v1.routes.ts`) declares 201/401/403/409/422/429 — no 400 anywhere on the frozen surface.
- **Impact**: An oversized body to a `/v1` write returns a status the frozen contract does not declare, and the status contradicts the code's own documentation. Minor today (Bun's socket ceiling at `BODY_LIMIT_BYTES * 2` backstops it), but the contract is supposed to be exact.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: HIGH (both files read)
- **Fix sketch**: Decide: either emit 413 (declare it on the surface) or change `index.ts`'s comment and declare 400; keep them consistent.

### CORR-07 Idempotency replay is not tenant-scoped
- **Evidence**: `apps/server/src/lib/idempotency.ts:75-92,117-127` — the key space is `actorId` only; replay matches method/path/requestHash with no organization. `idempotency.repository.ts:24-31` — lookup and unique index on `(actorId, key)` only.
- **Impact**: If the actor switches active organization between a request and its retry, the retry replays the first organization's stored response — a wrong-tenant answer to a write. Edge case, client-controlled, but it is a tenancy-adjacent hole in a repo whose core claim is tenancy correctness.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: MED
- **Fix sketch**: Include the active organization in the stored record and the replay match (or scope the key space to actor+org).

### CORR-08 Dedupe collapses only `pending` jobs — the running window admits duplicates
- **Evidence**: `packages/db/src/jobs.ts:52-57` + `packages/db/src/schema/job.ts:71-73` — the partial unique index covers `status = 'pending'` only, and `claim` flips the row to `running` in the same statement, freeing the slot for the execution window. `packages/mail/src/queue.ts:22-25` documents the behavior ("once that one is claimed the key is free again").
- **Impact**: "Resend verification" pressed while the first job is mid-flight — or two identical decisions inside the running window — produces a second row that executes concurrently: the exact duplicate work the debounce/mutex index exists to prevent, including for paid AI calls.
- **Effort**: M
- **Risk**: MED — extending the index predicate to `status IN ('pending','running')` needs a design pass (settle-path updates must not self-conflict).
- **Confidence**: MED (documented as deliberate; the concurrent-duplicate consequence is real)
- **Fix sketch**: Investigate covering `pending` + `running` in the partial index or an in-flight check in `enqueue`; confirm `claim`/`complete`/`fail` don't trip their own dedupe index.

---

## Performance

### PERF-01 Resend `fetch` has no request timeout
- **Evidence**: `packages/mail/src/send.ts:62` — `fetch(RESEND_ENDPOINT, …)` with no `AbortSignal`; contrast `packages/ai/src/generate.ts:57` (`AbortSignal.timeout(...)`, whose comment spells out that a hung call "stops the worker from touching any other kind of work"). The worker runs jobs one at a time (`apps/server/src/lib/jobs.ts:38-46`).
- **Impact**: A stalled Resend connection holds the single worker slot indefinitely: every job kind stalls, the 10 s shutdown deadline forces `exit(1)`, and the job is left `running` with no reaper (CORR-01). One provider outage takes the whole queue down.
- **Effort**: S
- **Risk**: LOW — an abort converts a hang into a retryable `fail`.
- **Confidence**: HIGH (fetch call read directly)
- **Fix sketch**: Add `AbortSignal.timeout(...)` to the Resend fetch and read the body with the same budget.

### PERF-02 Unbounded single-statement sweeps
- **Evidence**: `apps/server/src/lib/jobs.repository.ts:187-193` — one `DELETE … WHERE status IN ('done','failed') AND updated_at < cutoff` with `.returning({id})`; same shape in `apps/server/src/tasks.ts:59-62` (auth counters) and `sweepExpiredKeys` (`idempotency.repository.ts:63-72`). The filter column `updated_at` has no index — `packages/db/src/schema/job.ts:57-73` defines only `(status, run_at)` and the partial dedupe index.
- **Impact**: After a cron gap, one sweep is a single long transaction deleting potentially millions of rows: row locks held for the whole statement, every id buffered in memory just to count them, and the `updated_at` filter forces a scan of the whole settled population.
- **Effort**: M
- **Risk**: MED — batching changes the deletion window only in the safe direction (rows aged past cutoff between batches are fine).
- **Confidence**: HIGH (pattern), MED (severity at starter scale)
- **Fix sketch**: Loop a `DELETE … LIMIT 1000` keyed on a cursor until zero rows, count via `rowCount` instead of `RETURNING`, and add an index on `(status, updated_at)`.

---

## Tests, CI & Tooling

### TEST-01 Job-table full wipe races parallel suites
- **Evidence**: `apps/server/src/lib/jobs.test.ts:60` and `apps/server/src/lib/jobs.ownership.test.ts:40` both run `db.delete(job)` in `beforeEach` (jobs.test.ts:57-58 admits `claim` is global); `packages/mail/src/queue.test.ts:77-81` inserts `mail.send` rows keyed `mail:test:<uuid>` and asserts on them. `bun test` runs files in parallel processes and turbo runs the server and mail test tasks concurrently (`turbo.json:11-14`) against the same `keel_test` DB.
- **Impact**: In CI (DB always reachable), one suite's full-table delete can remove another suite's rows mid-assertion — `claim` returns 0, `pendingFor` returns empty, tests flake red on green code.
- **Effort**: S
- **Risk**: LOW — scoping deletes to rows the suite created only tightens isolation.
- **Confidence**: HIGH (all three test files read)
- **Fix sketch**: Track enqueued ids per suite and delete only those (mail's scoped `afterEach` is the pattern), or give each suite its own worker name and delete by its own keys.

### TEST-02 CI runs the whole server suite twice; skip-detection grep misses packages/mail
- **Evidence**: `.github/workflows/ci.yml:51` runs `bun run check` (which runs `turbo run check-types test`), then `ci.yml:55-62` runs `bun test` again in `apps/server` purely to grep the skip count; the second step's scope never sees `packages/mail/src/queue.test.ts:76` (`describe.skipIf(!ready)`).
- **Impact**: Every DB integration suite runs twice per CI run — 2× wall time and doubled exposure to the TEST-01 race. If the DB service failed but suites skipped, a mail-package skip is invisible to the grep.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: HIGH (workflow read)
- **Fix sketch**: Capture the first run's output (`bun run check 2>&1 | tee`) and grep that; include the mail package's output in skip detection.

### TEST-03 turbo caches the `test` task
- **Evidence**: `turbo.json:11-14` — `test` has `outputs: []` and no `cache: false`. Turbo caches any task without `cache: false`, restoring logs on a hit and skipping execution.
- **Impact**: The repo's single verification gate can silently stop running tests on unchanged trees (same inputs → cache hit), producing false-green locally before merge. CI only catches tests because of the redundant second run in TEST-02.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: MED (standard turbo semantics; verify by running `turbo run test` twice)
- **Fix sketch**: Add `"cache": false` to the `test` task.

### TEST-04 The worker process itself has zero coverage
- **Evidence**: `apps/server/src/worker.ts` (poll loop, backoff-on-full-batch, drain, shutdown) has no test file; `jobs.test.ts` covers `runOnce`/repository but never the processed-vs-batch sleep decision, poll-failure resilience, or drain/exit paths.
- **Impact**: The two behaviors that decide whether a bad poll or a bad job kills production delivery are exercised only by eyeballing.
- **Effort**: M
- **Risk**: LOW — extract the loop decision and shutdown sequencing into testable functions with injected timers.
- **Confidence**: HIGH
- **Fix sketch**: Unit-test the loop decision with a fake `runOnce`/sleep and shutdown ordering with a fake registry.

### TEST-05 `sweepSettledJobs` and the backoff cap are untested
- **Evidence**: `apps/server/src/lib/jobs.test.ts` never calls `sweepSettledJobs` (`jobs.repository.ts:187-193`); the `BACKOFF_MAX_MS` ceiling (`jobs.repository.ts:42-45`) is never exercised — the retry test walks only attempts 0-4, far below the 300 s cap.
- **Impact**: The retention sweep (which decides whether a live one-time mail link stays at rest) and the ceiling that stops a job being scheduled "next year" ship with no behavioral guard.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: HIGH
- **Fix sketch**: Add a sweep test (settled-older removed; newer/running/pending preserved; count) and a fail test that drives attempts to the cap.

### TEST-06 SigV4 presigned URLs are asserted only for shape, never validity
- **Evidence**: `packages/storage/src/client.test.ts:16` — "Signing is checked against a real MinIO; these are the choices we make", but the suite asserts only host/path/`X-Amz-Expires`/64-hex signature; no compose service provides MinIO.
- **Impact**: A regression in canonical-request construction (region, host, encoding) passes every test and surfaces only as client 403s in production.
- **Effort**: M
- **Risk**: LOW — additive.
- **Confidence**: MED
- **Fix sketch**: Add AWS SigV4 known-answer vectors, or a `minio` service on the test compose profile with a real presigned GET/PUT round trip.

### TEST-07 The 429 test races the one-token-per-second refill
- **Evidence**: `apps/server/src/lib/rate-limit.test.ts:104-115` — spends the whole WRITE_BUDGET (60) serially and asserts `remaining` exactly 0; the bucket refills one token per second, so the loop must complete in under 1 s.
- **Impact**: On a slow runner the `toBe(0)` and derived `Retry-After` assertions flake without any code change.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: LOW (likely fine on normal hardware; timer-bound by design)
- **Fix sketch**: Prime the bucket to 1 via `primeBucket` and spend once (the dedicated-bucket test already proves the 429 path), or assert `remaining <= 1`.

### TEST-08 No route-level 500-through-`onError` test; `security.ts` untested
- **Evidence**: `apps/server/src/app.test.ts:64-100` covers terminal 404/probe responses only; no route test drives a handler 500 through `app.onError`; `lib/security.ts` has no test file (body-limit rejection path has zero tests).
- **Impact**: The envelope's most important promise — "a 5xx message never carries internals" — is enforced only by a fixture in `packages/http`, never through the real app wiring.
- **Effort**: S–M
- **Risk**: LOW
- **Confidence**: MED
- **Fix sketch**: Add a route-level test that a throwing handler produces the masked envelope via the real `app.onError`, and a body-limit rejection test.

### TEST-09 gen-module scaffolds untested HTTP and repository surfaces
- **Evidence**: `tools/gen-module.ts:46,256` — the file map emits only `*.service.test.ts`; `:406` emits `internal/*.routes.ts`, handlers, repository, and public v1 files with no tests; `:749-750` asks only for `*.v1.routes.contract.test.ts`. The reference module carries route/tenancy/repository/paging tests.
- **Impact**: A generated module passes `bun run check` on first commit with its zValidator 422s, middleware ordering, envelope, and tenancy SQL entirely untested — the exact wiring this repo's architecture makes load-bearing.
- **Effort**: M
- **Risk**: LOW — additive generator output.
- **Confidence**: HIGH
- **Fix sketch**: Generate a `*.routes.test.ts` (401/403/404/422 envelope cases) and a `*.repository.test.ts` (tenancy filter + keyset probe) skeleton; list them in the next-steps message.

### TEST-10 Two enabled Biome rules have no check-rules fixture
- **Evidence**: `biome.jsonc:37` (`useExhaustiveDependencies: "error"`) and `biome.jsonc:75` (`useSingleVarDeclarator: "error"`) are set to error, but `tools/check-rules.fixtures.ts` EXPECTATIONS (16 entries) cover only the GritQL plugin, `noRestrictedImports` ×7, `noProcessEnv`, `noExcessiveLinesPerFile`, `noUndeclaredDependencies`, `noImportCycles`, `noPrivateImports`, and one silent exemption.
- **Impact**: A Biome upgrade that renames/removes either rule silently unguards it — the exact silent-death this script exists to catch — while the check keeps printing "N architecture rules verified".
- **Effort**: S
- **Risk**: LOW
- **Confidence**: HIGH
- **Fix sketch**: Add two fixtures (`var a; var b;` for `useSingleVarDeclarator`; a `useEffect` with a missing dependency for `useExhaustiveDependencies`).

### TEST-11 check-rules writes fixtures into the real source tree
- **Evidence**: `tools/check-rules.ts:34-38` writes violating files into `apps/server/src/modules/rulecheck`, `apps/server/src/lib/rulecheck`, `packages/http/src/rulecheck`; cleanup is only the `finally` at `:76-81`.
- **Impact**: A hard kill (OOM, CI timeout kill, Ctrl-C during the lint) leaves deliberately-violating files in the tree — the next `bun run check` fails on `rulecheck/*.ts` until someone knows to delete them.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: HIGH
- **Fix sketch**: Delete the three dirs at script start before writing (self-healing on rerun).

---

## Architecture & Dependencies

### ARCH-01 The declaration bundle carries undeclared generics and `any` outputs on the /v1 surface
- **Evidence**: `apps/server/types/app.d.mts:147-287` — the `/v1/projects` branches reference `R["request"]`, `R_1["request"]` and `Part` with no declaration anywhere in the file (verified by grep: usages only), and every `/v1` endpoint's `output: any`; the file declares only `createProjectSchema`, `AppEnv`, `app`, `routes`. `packages/config/tsconfig.base.json` sets `skipLibCheck: true`, which suppresses the unresolved names. `packages/api-client/src/index.ts:1` imports `AppType` from `server/app-type` — a packages→apps dependency on an unscoped app name.
- **Impact**: The public half of `AppType` silently degrades to `any` — the typed-client promise holds only for the internal `/api` surface (whose bundle types are concrete and correct). Any consumer compiling without `skipLibCheck` breaks on the free identifiers.
- **Effort**: M
- **Risk**: LOW-MED — tightening the exported type surface can only remove noise; `/v1` halves are not used by the client today.
- **Confidence**: MED (file contents read directly; whether it currently typechecks depends on tsdown/zod-openapi behavior the repo gates with `skipLibCheck`)
- **Fix sketch**: Restrict the bundle entry to the internal routes (or emit a dedicated `internalRoutes` type), and add a CI step that typechecks `types/app.d.mts` with `skipLibCheck: false`.

### ARCH-02 `createApiClient`'s option spread can drop `credentials: "include"`
- **Evidence**: `packages/api-client/src/index.ts:29-31` — `hc<AppType>(baseUrl, { init: { credentials: "include" }, ...options })`; spreading after `init` means any caller-supplied `init` replaces the object that carries the session cookie.
- **Impact**: Latent today (the options type exposes only `headers`), but the first extension to `init` silently loses the session cookie on every request — 401s that read as a server bug, invisible to typechecking.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: MED (spread semantics certain; exploitability requires the type to grow)
- **Fix sketch**: `init: { credentials: "include", ...options?.init }`, or document `init` as reserved.

### ARCH-03 Thirteen dependencies bypass the workspace catalog
- **Evidence**: `apps/web/package.json` (6 deps: resolvers, react-form, vite-plugin-pwa, assets-generator, plugin-react, postcss) and `packages/ui/package.json` (7 deps, including the shadcn CLI in runtime dependencies) use literal ranges; `tools/check-catalog.ts:47` skips any dep not owned by the catalog; `renovate.json`'s customManager extracts only `workspaces.catalog`, so these deps get no bump PRs.
- **Impact**: Version governance has a blind spot the repo's own tooling documents; catalog drift and EOL lag in these 13 deps go unnoticed, and the shadcn CLI-as-runtime-dependency bloats `@keel/ui` consumers.
- **Effort**: M
- **Risk**: LOW
- **Confidence**: HIGH (package.jsons read)
- **Fix sketch**: Add the 13 deps to the catalog (or explicitly document why they are exempt), and decide whether the shadcn CLI belongs in `devDependencies`.

### ARCH-04 Unused runtime deps and an undocumented exact pin
- **Evidence**: `packages/db/package.json` and `packages/auth/package.json` declare `zod` and `dotenv` as runtime dependencies; neither package imports either (env reaches them via `@keel/env/server`). Root catalog pins `better-auth` exact (`1.6.25`) while every other entry is a `^` range, with no comment recording whether that is deliberate.
- **Impact**: Stale entries assert a runtime contract the packages don't have; the exact pin is undocumented policy.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: HIGH
- **Fix sketch**: Remove `zod`/`dotenv` from both manifests; add a catalog comment for the `better-auth` pin or move it to caret.

### ARCH-05 The migration drift gate cannot see hand-edited SQL
- **Evidence**: `packages/db/src/migrations/0001_organizations_jobs.sql:48-55` — a prose comment plus a hand-added `ALTER COLUMN "created_by" DROP NOT NULL`; the comment admits drizzle-kit "reports the schema as matching" across the rename and that `tools/check-migrations.ts` "cannot catch this class of drift either".
- **Impact**: The single unguarded seam in the migration pipeline: any future hand-edit that drizzle-kit would not re-emit is silently invisible to CI.
- **Effort**: M
- **Risk**: LOW-MED — a strict "no hand edits" rule would have blocked the legitimate fix in 0001; the check must compare against the *intended* schema.
- **Confidence**: MED (the gap is stated by the repo's own comment; real-world impact unverifiable without a live DB)
- **Fix sketch**: After the drift probe, assert table/column nullability from a snapshot, or diff the committed SQL against fresh `drizzle-kit generate`; document the hand-edit policy.

### ARCH-06 Duplicate transitive dependencies
- **Evidence**: `bun.lock` — `@tanstack/react-store` 0.11.1 and 0.9.3 (plus `@tanstack/store` duplicates), and zod 3.25.76 via the shadcn CLI next to catalog zod 4.4.3.
- **Impact**: Two React store copies and two zod majors in one bundle graph — the exact duplication the catalog exists to prevent; zod 3/4 dual presence invites runtime `instanceof` mismatches.
- **Effort**: S (investigate which tree pulls the old store)
- **Risk**: LOW
- **Confidence**: MED (lockfile evidence; impact depends on consumers)
- **Fix sketch**: Identify the dependents pulling the older versions and align them to the catalog entries.

### ARCH-07 Production server bundle ships without source maps
- **Evidence**: `apps/server/tsdown.config.ts` — no `minify`/`sourcemap`; wide-event stack traces point at line 1 of a bundle column.
- **Impact**: Every production error trace loses file/line context — the observability story (`LOG_DRAIN=otlp`) gets stacks it cannot map.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: LOW (config read; severity depends on the evlog enrichment setup)
- **Fix sketch**: Emit `sourcemap: true` (and consider `minify`) in tsdown; confirm the drain receives sources.

### ARCH-08 Dev compose healthcheck runs `node -e` against a bun-only runtime image
- **Evidence**: `docker-compose.yml:81` — healthcheck `CMD node -e "fetch(...)"`; `apps/server/Dockerfile:40-62` — runner is `oven/bun:1-slim` with `USER bun` and its own `HEALTHCHECK … CMD bun -e` (the Dockerfile comment says the runtime "does not [need] node"). Dev compose builds the same Dockerfile but overrides the healthcheck with `node`.
- **Impact**: If `oven/bun:1-slim` does not ship a node binary, the dev compose server never reports healthy and `web` never starts behind it (`depends_on: service_healthy`).
- **Effort**: S
- **Risk**: LOW
- **Confidence**: LOW (investigate — whether the bun image ships a `node` symlink determines the impact; the drift between the two healthchecks is real either way)
- **Fix sketch**: Use `bun -e` in dev compose to match the Dockerfile, or verify the image ships node and delete the comment.

---

## Docs

### DOCS-01 README's architecture-rule count is stale
- **Evidence**: `README.md:49` — "violates all thirteen on purpose"; `tools/check-rules.fixtures.ts:28-140` holds 16 expectations (15 violating + 1 must-not-fire).
- **Impact**: The flagship "the enforcement is itself tested" claim under-counts coverage by two rules.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: HIGH
- **Fix sketch**: Say "fifteen" or drop the number ("every architecture rule").

### DOCS-02 README's "AGENTS.md stays under 40 lines" promise is stale
- **Evidence**: `README.md:368-369`; `AGENTS.md` is 82 lines.
- **Impact**: Minor stale promise; a signal that the "repeats nothing the linter enforces" discipline is under pressure as the doc grows (the Configuration section is the longest block).
- **Effort**: S
- **Risk**: LOW
- **Confidence**: HIGH
- **Fix sketch**: Update the claim or split the Configuration section out.

### DOCS-03 docker-compose.prod.yml omits the optional feature keys its own rule requires
- **Evidence**: `AGENTS.md:44-46` — "add the key to `.env.example`, `apps/server/.env`, `.env.test` and `docker-compose.prod.yml`'s `x-app-env`"; `docker-compose.prod.yml:14-45` forwards only `TRUSTED_*`/`OTLP_*`/`RESEND_API_KEY` among optional keys — `AI_API_KEY`, `AI_MODEL`, `SECRETS_ENCRYPTION_KEY` and all `STORAGE_*` are absent.
- **Impact**: Enabling AI, sealed secrets, or storage through the shipped deploy topology requires editing the compose file; a deploy that sets the keys in its environment has them silently dropped, then a worker job fails later naming the key — exactly the silent-failure mode the repo's env philosophy exists to prevent.
- **Effort**: S
- **Risk**: LOW
- **Confidence**: MED (possibly deliberate, but contradicts the repo's own stated rule)
- **Fix sketch**: Add the optional keys to `x-app-env` in the `${VAR:-}` pass-through form, matching the existing optional-key pattern.

---

## Direction (options for the maintainer — not problems ranked against bugs)

### DIR-01 The AI layer ships fully plumbed but nothing can trigger it
- **Evidence**: `packages/ai/src/queue.ts:31-46` (`enqueueGeneration`) has zero callers anywhere in apps/web or apps/server; `apps/server/src/worker.ts:65` registers the `ai.generate` handler with a usage ledger; `.env.example` documents `AI_API_KEY`/`AI_MODEL` as if enqueuing happens somewhere.
- **Impact**: A shipped starter feature users cannot reach — no endpoint, no UI, no enqueue site; only hand-inserted DB rows would ever run it. The env-key docs imply a path that does not exist.
- **Trade-offs**: One `/api` endpoint that enqueues and returns the job id would make it reachable; keep it internal first (a `/v1` AI surface is a frozen-contract decision). Dedupe-key policy per the comment at `queue.ts:13-22`.
- **Confidence**: HIGH (exhaustive grep)

### DIR-02 S3 storage is complete with zero consumers, and prod compose cannot forward its keys
- **Evidence**: `packages/storage/src/client.ts:102` `createStorage`, the tenant-key prefix guard, and provider presets are all unit-tested; `apps/server/src/lib/storage.ts:67` `resolveStorage` is imported only by `storage.test.ts`; `docker-compose.prod.yml` lists no `STORAGE_*` key; `.env.example` documents the full presigned-URL flow.
- **Trade-offs**: One upload/download route pair returning presigned URLs makes the docs true; expiry/content-type choices become contract once an endpoint exists — keep it internal. See DOCS-03 for the key-forwarding gap.
- **Confidence**: HIGH for no-consumer evidence; MED for intent

### DIR-03 The webhook receiver pattern is documented as the reference case but no receiver exists
- **Evidence**: `README.md:257-261` and AGENTS.md describe receive→persist→enqueue→200 as "the clearest case"; `apps/server/src/lib/webhook.ts:75` `verifySignature` is imported only by `webhook.test.ts`; no route or module implements a receiver.
- **Trade-offs**: One reference receiver (a third job kind) would give module authors the worked example the docs promise and make SEC-05/TEST-02/03's replay story testable end-to-end.
- **Confidence**: HIGH

### DIR-04 Sealed-secrets cipher ships with no consumer
- **Evidence**: `packages/crypto/src/seal.ts:62-108` is imported only by `seal.test.ts`; `SECRETS_ENCRYPTION_KEY` is documented in `packages/env/src/server.ts:123-131` and README ("Secrets at rest"); no app code stores a third-party token.
- **Trade-offs**: Either note in README that no integration uses seal yet, or land the first consumer (e.g. an OAuth provider token column) that makes the rotation semantics load-bearing.
- **Confidence**: HIGH

### DIR-05 Projects is CRUD minus update on both surfaces
- **Evidence**: `apps/server/src/modules/projects/internal/projects.routes.ts:24-29` — create/get/list/delete, no PATCH/PUT; `public/projects.v1.routes.ts:122-135` explains the absent DELETE but nothing explains the absent update; the web app has no project-edit UI.
- **Trade-offs**: The internal absence is unexplained (unlike the deliberately-commented v1 DELETE) — either add PATCH internally or add the comment stating why, mirroring the DELETE comment. A v1 update is a contract decision.
- **Confidence**: MED

---

## Verified clean — and considered-and-rejected

Scouts and the lead both confirmed these hold; they were reported by one scout or another and rejected after verification:

- **Tenancy/IDOR**: repository-scoped `and(...)` filters, 404-not-403, `requireOrg` membership re-check — verified on every route of both surfaces.
- **Mass assignment**: explicit Zod objects on both surfaces, no passthrough.
- **Error leakage**: 5xx internals never forwarded (`@keel/http/response` `failure()`), SQLSTATE-only readiness reasons, regression test throws a password-carrying DSN and asserts it never reaches the response.
- **CORS/headers**: single-origin CORS with credentials, CSP `default-src 'none'`, HSTS, frame denial; the web nginx absence of CSP is documented.
- **crypto**: AES-256-GCM with random 12-byte IV + 16-byte tag, versioned envelope, construction-time key-length check; timing-safe `equals`.
- **Rate limiter**: actor-keyed, single conditional-counter upsert, correct bucket math; no Redis is by design.
- **Env discipline**: `.env.example` ↔ `packages/env` schema match exactly (all 15 required keys uncommented, 16 optional commented); `.env.test` covers every required key; only `.env.example`/`.env.test` are committed, both credential-free.
- **Contracts**: Drizzle schema ↔ `@keel/contracts` drift-free by construction (drizzle-zod `.pick()` + CI typecheck).
- **Migrations**: 0000–0004 match the schema field-by-field (except the known hand-edit in ARCH-05).
- **Queue core**: SKIP LOCKED claim, ownership fences, backoff ladder, poison-job termination, dedupe index semantics — all verified correct under graceful operation.
- **README runtime claims**: `/health` vs `/ready`, rate limiter placement, invitation 7-day + re-invite cancellation, 3-day sweep, SIGTERM drain, compose healthcheck → `/ready` — all confirmed in code.
- **PWA**: shell-caching regression not present (nginx no-cache on `index.html`/`sw.js`, autoUpdate flow verified).
- **No TODO/FIXME/HACK/XXX markers, no commented-out code, no feature flags, no abandoned mid-feature work in git history.** AGENTS.md is accurate and current.

---

## What was not audited

- No live database or runtime exercise: findings are from code reading; PERF-02 and ARCH-05 severities are unverified against real data volumes.
- No `bun audit` re-run (the CI audit job's design is deliberate and documented in the workflow).
- No Docker images pulled: ARCH-08's impact depends on `oven/bun:1-slim` contents.
- `bun.lock` duplication findings (ARCH-06) were not traced to their dependents.
- Rate-limit and job-queue behavior under actual concurrent load was not measured.
