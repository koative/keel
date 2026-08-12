# AI Enqueue Endpoint Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** DIR-01 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Make the fully-plumbed AI layer reachable: one internal `/api` endpoint that enqueues a generation and returns the job id. Today `enqueueGeneration` has zero callers — the feature is documented in `.env.example` and registered in the worker, but nothing can trigger it.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `packages/ai/src/queue.ts:46-48` — `export async function enqueueGeneration(request: GenerationRequest): Promise<void>`; `GenerationRequest` at `:10-35` = `{ dedupeKey?: string; organizationId: string; prompt: string }`. Doc comment `:40-43`: "Nothing generates inside a request. A completion takes seconds…"
2. `apps/server/src/worker.ts:65` — `registry.set("ai.generate", ...)` handler with the usage ledger (`hasUsageForJob`/`recordUsage`, `:86-107`) — the job kind exists and is executable.
3. **Zero callers**: repo-wide grep for `enqueueGeneration`/`@keel/ai/queue` matches only the definition and the audit report.
4. The queue's dedupe-key policy comment at `packages/ai/src/queue.ts:11-27` — read it: keys are the caller's choice (e.g. `ai:<orgId>:<prompt-hash>` style), and the debounce semantics depend on it.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- No file over 200 code lines.
- Internal surface only (`/api/...`), envelope responses via `@keel/http`, `requireUser` + `rateLimit` + `requireOrg` chain (mirror `projects/internal/projects.routes.ts`).
- No new environment variables.

## Do not

- Do not add a `/v1` AI surface (a frozen-contract decision; explicitly out of scope per the audit).
- Do not generate inside the request — enqueue only (the whole point of the queue).
- Do not invent a dedupe-key default if the queue's contract leaves the key to the caller; either require the caller to pass one, or derive a stable default **documented** in the schema (e.g. `ai:${orgId}:${sha256(prompt).slice(...)}` — read the queue comment first; if it says the caller must choose, make `dedupeKey` optional but document what an omitted key costs: duplicate work on retry).
- Do not change the worker handler or the usage ledger.
- Do not log the prompt anywhere (SEC-06/plan 009's spirit).

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/modules/ai/internal/ai.routes.ts` | **Create.** The internal route. |
| `apps/server/src/modules/ai/internal/ai.schema.ts` | **Create.** Zod request schema. |
| `apps/server/src/modules/ai/internal/ai.handlers.ts` | **Create.** Envelope-shaped handler calling `enqueueGeneration`. |
| `apps/server/src/modules/ai/index.ts` | **Create.** Module index exporting the internal routes. |
| `apps/server/src/modules/ai/internal/ai.routes.test.ts` | **Create.** 401/403/422 envelope cases + success shape. |
| `apps/server/src/app.ts` | **Modify.** Mount under `/api/ai` (follow the projects internal mount). |

### Task 1: The endpoint

**Files:** the module files above, `apps/server/src/app.ts`

- [x] **Step 1:** Read `packages/ai/src/queue.ts` fully (it is small) — the `enqueueGeneration` signature, `GenerationRequest`, the dedupe-key comment, and whether it returns the job id (it returns `Promise<void>` today — check whether the job id is reachable; if the endpoint must return it, extend `enqueueGeneration` to return `{ created: boolean; id: string | null }` like `@/lib/jobs`'s `enqueue`, and update its only consumers — there are none, so the signature change is safe). Prefer returning the id: the endpoint's whole value is "here is your job".
- [x] **Step 2:** Schema: `POST /api/ai/generate` with `{ prompt: string (min 1, max N — pick a sane bound and say why in the schema comment), dedupeKey?: string }`. Validate prompt length to bound the persisted payload (the job row stores it).
- [x] **Step 3:** Handler: build `GenerationRequest` from the validated body + `c.get("organizationId")`, call `enqueueGeneration`, return `{ jobId }` (or `{ created, jobId }`) in the envelope.
- [x] **Step 4:** Mount in `app.ts` under `/api/ai`, mirroring the projects internal mount exactly.
- [x] **Step 5:** Tests (mirror `projects.routes.test.ts`): unauthenticated → 401; no org → 403/404 per tenancy rules; empty prompt → 422; valid → 200 with `data.jobId` (and `created: true`); same dedupeKey twice → second returns `created: false` with the same id (if the queue returns it) — this is the dedupe contract proven through the real app. DB-gated like the reference suite (test DB needed for the enqueue).
- [x] **Step 6:** Run: `cd apps/server && bun test src/modules/ai/...` — green.
- [x] **Step 7:** Commit: `feat(server): enqueue an AI generation on the internal surface`.

## Done when

- `POST /api/ai/generate` enqueues through the real `enqueueGeneration`, returns the job id, and the worker can pick it up (smoke: after the route test, claim/run once if cheap, or rely on the route test asserting the row exists).
- 401/403/422 and the dedupe-collapse contract are tested.
- `enqueueGeneration`'s return type change (if made) is documented in its doc comment.

## Out of scope

- A `/v1` AI contract.
- A frontend UI for generation.
- **DIR-02** (storage routes) — plan 036; same module-family shape, different module.
