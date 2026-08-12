# 500-Through-onError Envelope Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** TEST-08 remainder (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Prove through the real app wiring that a throwing handler produces the masked 500 envelope — `error.code: "INTERNAL"` (or whatever `@keel/http` names it), a requestId, and no internals — via `app.onError`. Today the envelope is asserted at 404 (app.test.ts), 413 (security.test.ts, landed with plan 005) and 429 (rate-limit.test.ts), but the only 500-through-onError driver asserts the status and nothing about the body.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/app.ts:171` — `app.onError((error, c) => failure(c, error));`
2. `apps/server/src/app.test.ts:56-90` — terminal 404 envelope (code NOT_FOUND, requestId) and probe exclusions (`/health`, `/ready`).
3. `apps/server/src/lib/idempotency.test.ts:114-127` — a "boom" handler throws; the test asserts status 500 + "nothing stored", **no envelope body assertion**.
4. `packages/http` (landed) — `failure()` renders `{ error: { code, message, requestId } }`; the masked-500 behavior is pinned in `packages/http/src/response.failure.test.ts` (a fixture, not the real app).
5. The `INTERNAL` error-code name: verify in `packages/http/src/errors.ts` / `status.ts` what a generic server failure maps to (the fixture test asserts it — check its exact constant).

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- The test must go through the real `app` instance (imported from `./app` or wherever `app.test.ts` gets it), not a fixture or a hand-built Hono.

## Do not

- Do not add a test-only throwing route to `app.ts` — production code is not the place for a deliberately crashing endpoint.
- Do not duplicate `packages/http`'s fixture coverage; this is about the wiring, not the renderer.
- Do not touch `app.ts`.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/idempotency.test.ts:114-127` | **Modify.** Strengthen the boom-handler test to assert the envelope body. |

### Task 1: The envelope on the existing 500 path

**Files:** `apps/server/src/lib/idempotency.test.ts`

- [x] **Step 1:** Read the existing boom-handler test at `:114-127` — how it mounts the throwing route, what it asserts. Check how it imports `app` (or builds one) and whether the failure passes through the real `app.onError`.
- [x] **Step 2:** Add envelope assertions to that test (or a sibling test with the same mounting): on the 500 response, parse the body and assert:
  - `body.error.code` equals the constant `packages/http` uses for server failures (read it from `packages/http/src/errors.ts`/`response.ts` — likely `INTERNAL`; do not hardcode a guessed string, import or reference the real name),
  - `body.error.requestId` is a non-empty string (and, if the app sets a request-id header, that it matches),
  - `body.error.message` does **not** contain the thrown error's text (that is the mask — the boom error's message must not leak).
- [x] **Step 3:** Run the suite: `cd apps/server && bun test src/lib/idempotency.test.ts` — green (explicit path; the suite needs the test DB for other cases, but verify this test runs).
- [x] **Step 4:** Commit: `test(server): a thrown handler stays masked through the real onError`.

## Done when

- A 500 driven through the real `app.onError` is asserted to carry the masked envelope: the internal code, a requestId, and none of the thrown message.
- No production code changed.

## Out of scope

- **TEST-07** (429 race) — plan 020.
- Extending the 404/probe coverage in `app.test.ts`.
