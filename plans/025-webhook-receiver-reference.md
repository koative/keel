# Webhook Receiver Reference Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** DIR-03 (`plans/audit-report.md`) — consumes the contract landed in plan 022.
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Plan 022 landed `verifySignature` + `NO_TIMESTAMP` + the replay window; this plan builds the receiver the docs promise as "the clearest case" for background work.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/lib/webhook.ts:193` — `export function verifySignature({ header, rawBody, secret, signedAt, signedPrefix }: SignatureInput): boolean` — returns false (never throws) on missing/empty/malformed header. `TOLERANCE_MS` = 5 min (:60). `NO_TIMESTAMP` exported (:74).
2. The receiver contract is in `verifySignature`'s doc comment (:168-190): (1) a **unique index on (provider, event id)** over the persisted raw payload — the durable guard, the one that still works when `signedAt` is `NO_TIMESTAMP`; (2) `enqueue`'s `dedupeKey` set to that same event id, namespaced — `webhook:<provider>:<eventId>`.
3. The fixed receiver order (:4-14): verify signature over the raw bytes (`await c.req.arrayBuffer()`) → persist raw payload → enqueue → return 200. Nothing else happens first.
4. `signedAt` MUST be parsed from the same bytes passed as `signedPrefix` (:103-117) — the invariant that makes the timestamp authenticated.
5. No receiver module exists (grep of `apps/server/src/modules/` for webhook: zero matches).
6. Migration numbering: 0006 is owned by plan 012, and 023 (CORR-05) edited 0001 in place and added **no** migration — so the current highest is 0006 and this plan generated **0007** (the original text said 0008, written before 023's outcome). Confirmed against the tree before generating.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- No file over 200 code lines.
- Test DB is up; `bun run db:test:migrate` once before DB tests.
- Internal surface only (`/api/...`), envelope responses via `@keel/http`.
- This plan runs `drizzle-kit generate` (migration 0007) — no other plan in the same wave may.
- The module must follow the repo's module structure exactly: `apps/server/src/modules/<name>/` with `internal/`, a single `index.ts` export, and tests mirroring the projects reference module.

## Do not

- Do not invent a provider-specific header grammar inside `webhook.ts` — the module stays provider-agnostic; the **receiver** picks its provider's header name, timestamp location and prefix spelling (e.g. a generic provider whose header is `X-Webhook-Signature`, timestamp in the prefix `t=...` style — document the choice in the receiver, not in the primitive).
- Do not parse the payload before verifying (order violation).
- Do not return anything but 200 once the event is durable (a slow dependency must not turn a delivery into a retry storm).
- Do not log the raw payload (it may contain data; the table row is the record).
- Do not add a `/v1` surface.
- Do not use `dedupeKey` alone as the replay guard in tests without also proving the unique index — the plan 022 doc comment is explicit that the two halves are both required; the test must exercise both.

## File structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema/webhook-event.ts` | **Create.** The raw-payload table. |
| `packages/db/src/schema/index.ts` | **Modify.** Export it. |
| `packages/db/src/migrations/0007_webhook_event.sql` + meta | **Create** (drizzle-kit generate). |
| `apps/server/src/modules/webhooks/internal/webhooks.schema.ts` | **Create.** Zod schemas (provider, header, timestamp parsing). |
| `apps/server/src/modules/webhooks/internal/webhooks.handlers.ts` | **Create.** Verify → persist → enqueue → 200. |
| `apps/server/src/modules/webhooks/internal/webhooks.routes.ts` | **Create.** The POST route. |
| `apps/server/src/modules/webhooks/index.ts` | **Create.** Module index. |
| `apps/server/src/modules/webhooks/internal/webhooks.routes.test.ts` | **Create.** Signature/replay/dedupe/tenancy cases. |
| `apps/server/src/modules/webhooks/webhooks.repository.ts` | **Create** (deviation: the table lists no repository, but the linter forbids a handler from reaching `@keel/db` — "An HTTP layer may not reach the database" — so the module owns one at module root, mirroring `projects.repository.ts`; the handler and the worker handler both call it). |
| `apps/server/src/modules/webhooks/internal/webhooks.worker.ts` | **Create** (deviation: the worker-side `webhook.process` handler, exported through the module index so the registry can register it without reaching into the module — the entry-point block forbids deep `@/modules/...` imports). |
| `packages/env/src/server.ts`, `.env.example`, `docker-compose.prod.yml`, `.env.test` | **Modify** (deviation: the receiver needs a shared secret; `WEBHOOK_SECRET` is added optional with a per-delivery `resolveWebhookSecret` guard — the storage/AI pattern. check-env keeps the four env files in step, and the route tests need the key set to the fixture's `SECRET`). |
| `apps/server/src/registry.ts` | **Modify.** Register the `webhook.process` handler at module scope beside `mail.send` and `ai.generate` (a job kind that runs the persisted event — minimal: mark it processed). This plan wrote the registration into `apps/server/src/worker.ts`, and put it in the wrong place; `d89ae4a` split the map out into `registry.ts` so a test can reach it. See the Follow-up. |
| `apps/server/src/app.ts` | **Modify.** Mount under `/api/webhooks`. |
| `packages/db/src/jobs.ts` or `apps/server/src/lib/jobs.ts` | Only if a job kind constant is needed — check the registry pattern first. |

### Task 1: The durable payload table

**Files:** schema + migration 0007

- [x] **Step 1:** Read `packages/db/src/schema/` (job.ts, ai-usage.ts) for the table style (pgTable, timestamps with `$onUpdate`, text pk or uuid). Create `webhook-event` with: `id` (uuid/text pk), `provider` (text), `event_id` (text), `raw_body` (text or jsonb — the payload is persisted as received; check what the job payload will carry and pick text for byte-fidelity, per plan 022's "exact bytes" reasoning), `received_at` timestamp, and a **unique index on (provider, event_id)**. No FK to organization (webhooks may target resources; keep the receiver generic — if tenancy applies, the handler reads org from the payload after verification, but the table itself is not tenant-scoped; say so in a comment). Chose `text` for `raw_body` (the job payload carries `{ provider, eventId, receivedAt }`, never the body — a jsonb round trip would normalise the bytes) and added a nullable `processed_at` (the worker's durable marker, see Task 2 Step 5).
- [x] **Step 2:** Generate migration 0007 via `drizzle-kit generate` (confirmed the current highest was 0006 — plan 023 added no migration — and named it `webhook_event`), formatted the meta files like the committed ones (formatter-compact — drizzle-kit 0.31 emits expanded arrays; the committed snapshots are biome-formatted with inline arrays), and ran `bun run db:test:migrate` + `bun tools/check-migrations.ts` green (8 migrations, schema matches).
- [x] **Step 3:** Commit: `feat(db): raw webhook events, unique per provider and event id`.

### Task 2: Verify, persist, enqueue, 200

**Files:** the webhooks module, `app.ts`, `worker.ts`

- [x] **Step 1:** Read `apps/server/src/lib/webhook.ts`'s full doc comment and `verifySignature` signature; read `apps/server/src/lib/jobs.ts`'s `enqueue` (or `@/lib/jobs` — the app-side entry) for the `dedupeKey`/`kind` contract; read the projects internal module for the route/mount pattern.
- [x] **Step 2:** Schema: `POST /api/webhooks/:provider` with a header field (the provider's signature header — the route reads it via `c.req.header(...)`; the schema's job is the optional timestamp input if the provider carries one outside the header). Keep it provider-agnostic: the handler takes the raw header value, parses `signedAt` + `signedPrefix` per the provider's grammar **in the receiver** (a small parser function in the module, documented with the provider's wire format), and passes them to `verifySignature`. Two reference grammars: `generic` (timestamp in `x-webhook-timestamp`, prefix `<ts>.` — Slack/Svix transport, Stripe prefix spelling) and `bare` (`NO_TIMESTAMP`, signs the body alone — the GitHub shape, genericised). Grammar is documented in `webhooks.handlers.ts`, never in `webhook.ts`.
- [x] **Step 3:** Handler, exactly in order:
  1. `const rawBody = await c.req.arrayBuffer();`
  2. Parse `signedAt`/`signedPrefix` from the header; call `verifySignature(...)`. False → return the envelope 401 (or 400 — check `@keel/http`'s helpers; pick the status that tells the provider "don't retry this" vs "retry"; providers retry 5xx, so a bad signature must be 4xx). Chose 401 `unauthorized()` for a signature that fails, 400 `badRequest()` for a grammar violation (timestamped provider that omitted its timestamp), 503 `serviceUnavailable()` when `WEBHOOK_SECRET` is unset (the storage module's `storageOf` shape — a config gap is retryable once the key ships).
  3. Parse the body for the event id (after verification only — plan 022: "An id parsed from an unverified body is an attacker-chosen primary key").
  4. Persist the raw payload with (provider, eventId) — rely on the unique index; a duplicate insert → the row exists → treat as already-handled → 200 (idempotent replay, no new job).
  5. `enqueue({ dedupeKey: \`webhook:${provider}:${eventId}\`, kind: "webhook.process", payload: { provider, eventId } })` — the payload references the persisted row, not the raw bytes (keep the raw body out of the job row? read how the job payload is persisted — plan 022's receiver order says persist then enqueue referencing that payload; decide whether the job carries the raw body or an id and say why). Chose the natural key `{ provider, eventId }`: jsonb would normalise the body, and the worker re-reads the row by the same unique key the durable index holds. This plan also put `receivedAt` in the payload; nothing read it, and `e1df2fb` dropped it. Enqueue runs **only when the insert created the row** — the settled-dedupeKey trap from plan 022's doc comment.
  6. Return 200 with `{ data: { eventId } }`.
- [x] **Step 4:** Mount in `app.ts` under `/api/webhooks`, mirroring the projects internal mount (chained after `/api/ai`, keeping every landed mount). Still on `app` at HEAD (`apps/server/src/app.ts:167`) and deliberately so: `/api/ai` and `/api/projects` have since moved to `internal-routes.ts`, and `internal-routes.ts:21-24` says why the receiver did not follow them — a provider posts server-to-server with a signature and no cookie, so typing it into the client's surface would only widen what the SPA can reach.
- [x] **Step 5:** Worker: register a `webhook.process` handler that does the minimal honest thing (read the persisted event, mark it processed — check whether the ledger pattern (`hasUsageForJob`) fits or whether a simple `processed_at` column on webhook-event is cleaner; choose the smallest durable marker and comment it). The handler must be idempotent (it may run twice — that is the queue's contract). Chose the `processed_at` column (added in Task 1): one nullable timestamp, set by an `UPDATE … WHERE processed_at IS NULL` whose rowcount is the idempotency — a ledger table for a marker this small would be ceremony. `webhookProcess` lives in `internal/webhooks.worker.ts` and is exported through the module index (`apps/server/src/modules/webhooks/index.ts:13`). **The registration this step claims did not work.** `registry.set("webhook.process", webhookProcess)` went inside the `ai.generate` handler's body in `worker.ts`, so the kind existed only after an AI job had run; `d89ae4a` moved it to module scope in `apps/server/src/registry.ts:117`, where `worker.ts:5` imports it. See the Follow-up.
- [x] **Step 6:** Tests (mirror `projects.routes.test.ts` + the replay suite's fixture approach — reuse `apps/server/src/lib/webhook.fixtures.ts`'s `delivery()` if its provider shape matches, or build a small fixture in the module): bad signature → 4xx; valid fresh delivery → 200 and exactly one webhook-event row + one pending job with the right dedupeKey; replay of the same event → 200, no second row, no second job (dedupeKey collapse + unique index both proven); delivery outside the 5-minute window → 4xx; missing timestamp provider (`NO_TIMESTAMP`) → verifies and dedupes via the unique index. Tenancy is not the module's concern (documented) — no org tests needed beyond the route being internal. The `bare` test deletes the settled job row before replaying, which is what proves the unique index — not the dedupeKey — is the replay guard; plus a worker test proving `webhookProcess` marks processed exactly once across two runs.
- [x] **Step 7:** Run: `cd apps/server && bun test src/modules/webhooks/` — green when this task landed (7 pass / 0 fail). Assert the exit status and `0 fail`, not the total: the module now carries 9 cases across two files (`internal/webhooks.routes.test.ts` and `internal/webhooks.routes.failure.test.ts`, added by the fixes in the Follow-up), both `describe.skipIf(!ready)` so they need the test DB up. Biome clean on the module; `bun tools/check-env.ts` green (32 keys).
- [x] **Step 8:** Commit: `feat(server): the reference webhook receiver`.

## Done when

- `POST /api/webhooks/:provider` verifies over the raw bytes, persists under a unique (provider, event id), enqueues with the namespaced dedupeKey, returns 200; replays are idempotent with no double execution.
- The worker has a minimal `webhook.process` handler. **This was false when it was ticked** and is true now: the handler is registered at module scope in `apps/server/src/registry.ts:117`, the map `worker.ts:5` imports, and `apps/server/src/registry.test.ts:29-35` fails if the kind is missing. The Follow-up records what was wrong.
- Migration 0007 applies; check-migrations green; all module tests pass.

## Out of scope

- A `/v1` webhook surface (frozen-contract decision).
- Provider-specific webhook integrations (Stripe/GitHub/Slack) — the receiver is a generic reference implementation; a real provider integration is a follow-up.
- **SEC-05** (the replay window itself) — already landed in plan 022.

## Follow-up (executed, commits `d89ae4a`, `5db7081`, `411f30f`, `e1df2fb`)

**The `webhook.process` registration was unreachable.** Task 2 Step 5's
`registry.set("webhook.process", webhookProcess)` was written one level inside the
`ai.generate` handler's body in `apps/server/src/worker.ts`, so the kind was
registered as a side effect of an AI job running and a freshly started worker held
two kinds instead of three. Every delivery this plan's receiver enqueued was then
claimed by that worker and burned its attempts against the unregistered-kind guard
in `apps/server/src/lib/jobs.ts`, so the pipeline this plan exists to deliver did
not run at all — while the Done-when clause "the worker has a minimal
`webhook.process` handler" sat ticked. Nothing caught it because nothing could:
`worker.ts` starts a poll loop at module scope, so no test could import the map,
and Task 2 Step 6's coverage called `webhookProcess` directly, which passes
whether or not the worker can reach it. Biome had nothing to object to either.

Fixed in `d89ae4a`: the map moved to `apps/server/src/registry.ts`, importable
because it no longer starts anything, and `worker.ts:5` imports it. What proves it
now is `apps/server/src/registry.test.ts`: a case per kind (`:19-24`) and
`registers exactly the kinds this worker ships` (`:29-35`), a sorted `toEqual`
against `["ai.generate", "mail.send", "webhook.process"]`, so a registration that
moves somewhere unreachable makes the list short and the suite red, and a new kind
has to be declared here. Verified: `cd apps/server && bun test src/registry.test.ts`
→ 4 pass / 0 fail.

**Three receiver corrections, reported by `FixWebhookReceiver` and landed in the
same module.** `5db7081`: when `enqueue` threw after the insert committed, the row
stayed and the provider's retry got a 200 with no job — the event was persisted and
permanently unprocessed. The receiver now deletes the row and rethrows, so the
response is a 500 the provider will retry and nothing is persisted; the verify →
decode → persist → enqueue → 200 order and every other status are unchanged.
`411f30f`: a verified payload that is not valid UTF-8 is now a 400 with nothing
persisted, instead of a row holding U+FFFD-substituted bytes — which would have
broken the "exact bytes" property Task 1 chose `text` for. `e1df2fb`: `receivedAt`
left the `webhook.process` payload, unread. Both failure paths are covered in
`apps/server/src/modules/webhooks/internal/webhooks.routes.failure.test.ts:59`
and `:77`.