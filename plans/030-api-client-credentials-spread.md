# API Client Credentials Spread Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** ARCH-02 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Stop a caller-supplied `init` from silently dropping `credentials: "include"`. Today the spread order means the first extension of the options type (or any caller passing `init`) replaces the object that carries the session cookie — a latent 401 generator.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `packages/api-client/src/index.ts:23-28` — `return hc<AppType>(baseUrl, { init: { credentials: "include" }, ...options });` — `...options` spreads **after** `init`, so `options.init` (or `options.headers`, since `hc` folds headers into init) replaces the credentials object.
2. The options type exposes only `headers` today (per the audit), so the bug is latent — but the first extension of `init` silently loses the cookie on every request.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- The client's public behavior for existing callers (headers, baseUrl) must not change.

## Do not

- Do not document `init` as reserved instead of fixing the merge — the merge is the fix.
- Do not change `credentials` to anything other than `"include"` (session cookie auth is the design).

## File structure

| File | Responsibility |
|---|---|
| `packages/api-client/src/index.ts:23-28` | **Modify.** Merge `init` so `credentials: "include"` cannot be clobbered. |

### Task 1: The merge

**Files:** `packages/api-client/src/index.ts`

- [x] **Step 1:** Read the whole file (it is small) to see the `CreateApiClientOptions` type and how `hc` is called.
- [x] **Step 2:** Replace the spread so the caller's own `init` is preserved but the cookie setting is non-negotiable:
  ```ts
  return hc<AppType>(baseUrl, {
    ...options,
    init: { credentials: "include", ...options.init },
  });
  ```
  (If the options type currently exposes `headers` rather than `init`, check how `hc` accepts them — hono's `hc` init accepts `headers` inside `init`; extend the options type with `init?: RequestInit` or merge `options.headers` into the same object as appropriate, keeping the existing `headers` path working for current callers.)
- [x] **Step 3:** If the options type gains an `init` field, add a doc comment on it: caller-supplied init is merged under `credentials: "include"`, which is load-bearing for session auth and cannot be overridden.
- [x] **Step 4:** Typecheck the package and its consumer: `cd packages/api-client && bun run check-types` (or the package's typecheck script) and `cd apps/web && bun run check-types`.
- [x] **Step 5:** Commit: `fix(api-client): a caller init cannot drop the session cookie`.

## Done when

- `hc` is called with `credentials: "include"` surviving any caller-supplied `init`/`headers`.
- The options type documents the merge.
- Typecheck passes for the package and the web app.

## Out of scope

- **ARCH-01** (the declaration bundle /v1 surface) — plan 029, same file family; if concurrent, 029 owns the `AppType` import/source, this plan owns the `hc` call and options type.
- Any runtime change to how the web app calls the client.
