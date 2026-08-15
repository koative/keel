# 500-Through-onError Envelope Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** TEST-08 remainder (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Prove through the real app wiring that a throwing handler produces the masked 500 envelope — `error.code: "INTERNAL"` (or whatever `@keel/http` names it), a requestId, and no internals — via `app.onError`. Today the envelope is asserted at 404 (app.test.ts), 413 (security.test.ts, landed with plan 005) and 429 (rate-limit.test.ts), but the only 500-through-onError driver asserts the status and nothing about the body.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/app.ts:173` — `app.onError((error, c) => failure(c, error));` (it was `:171` when this plan was written; `da28fcc` moved the mounts above it).
2. `apps/server/src/app.test.ts:56-90` — terminal 404 envelope (code NOT_FOUND, requestId) and probe exclusions (`/health`, `/ready`).
3. `apps/server/src/lib/idempotency.test.ts:114-127` — a "boom" handler throws; the test asserts status 500 + "nothing stored", **no envelope body assertion**. What this evidence line missed, and what mis-delivered the plan: that test's app comes from `buildApp()` (`:31`), a hand-built `new Hono()` with its own `onError`, so a 500 asserted there never reaches `app.ts`'s — see the Follow-up.
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
| `apps/server/src/app.test.ts` | **Modify.** Assert the masked 500 envelope on the real `app`, beside the terminal-404 case. |

### Task 1: The envelope on the existing 500 path

**Files:** `apps/server/src/lib/idempotency.test.ts`

- [x] **Step 1:** Read the existing boom-handler test at `:114-127` — how it mounts the throwing route, what it asserts. Check how it imports `app` (or builds one) and whether the failure passes through the real `app.onError`.
- [x] **Step 2:** Assert the envelope on the 500 the real `app` renders. Landed at `apps/server/src/app.test.ts:86-117` — `renders an unexpected failure without echoing what was thrown`, inside `describe("terminal responses")` beside the terminal-404 case. The suite imports `app` from `./app` (`:3`), so the response is rendered by `app.onError` at `apps/server/src/app.ts:173` and by nothing else. The throw is a request-body `ReadableStream` whose `start` calls `controller.error(...)` — what a client vanishing mid-upload looks like — which surfaces inside `requestBodyLimit`, mounted above every route, so no test-only route was added to production code. The assertion is a whole-document `toEqual` (`:105-116`): `error.code` is `"INTERNAL_SERVER_ERROR"`, `error.message` is `"Something went wrong"`, `error.requestId` is the request's `x-request-id`, and whole-document equality is itself the leak check — there is nowhere for the thrown text to hide.
- [x] **Step 3:** Run the suite: `cd apps/server && bun test src/app.test.ts` — 9 pass / 0 fail. Load-bearing check reported by `FixEnvelopeTests`: commenting out `app.onError((error, c) => failure(c, error));` at `apps/server/src/app.ts:173` fails exactly that test (`Expected to contain: application/problem+json / Received: text/plain; charset=UTF-8`) and Hono's default handler prints the thrown text to stderr, which is the leak the envelope prevents. That is the check the first attempt could not make; see the Follow-up.
- [x] **Step 4:** Commit: `a724298` (first attempt), corrected in `29f2515` — `test(server): the masked 500 was asserted against a throwaway Hono`.

## Done when

- A 500 driven through the real `app.onError` is asserted to carry the masked envelope: the internal code, a requestId, and none of the thrown message. **True at HEAD** — `apps/server/src/app.test.ts:86-117`, against `app` imported from `./app`. It was false when first ticked; the Follow-up says why.
- No production code changed: the correction in `29f2515` touched test files only, and `apps/server/src/app.ts` is untouched by this plan.

## Out of scope

- **TEST-07** (429 race) — plan 020.
- Extending the 404/probe coverage in `app.test.ts`.

## Follow-up (executed, commit `29f2515`)

This plan's Done-when was ticked against an assertion that could not have proved
it. The envelope assertions went into `apps/server/src/lib/idempotency.test.ts`'s
boom test, whose app comes from `buildApp()` at `:31` — a hand-built `new Hono()`
carrying its own `onError`. That is precisely what the Global Constraint at line
21 forbids ("through the real `app` instance ... not a fixture or a hand-built
Hono"), and the consequence was not cosmetic: `FixEnvelopeTests` verified that
the suite still passed with `app.onError((error, c) => failure(c, error));`
deleted from `apps/server/src/app.ts`, so the one piece of wiring this plan
existed to pin was never pinned. Verified evidence 3 quoted that test without
noticing where its app came from.

Corrected in `29f2515`: the envelope assertions, the `INTERNAL_CODE` constant and
the imports that went with them were removed from `idempotency.test.ts`, leaving
that test asserting only its own subject — nothing stored for a failure, the
retry reaches the handler — and the assertion was rewritten against the real
`app` at `apps/server/src/app.test.ts:86-117`. Reported by `FixEnvelopeTests`,
re-verified here against both files and by `cd apps/server && bun test
src/app.test.ts` → 9 pass / 0 fail.
