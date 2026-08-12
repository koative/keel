# Projects Update-Endpoint Documentation Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** DIR-05 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Explain, in the code, why the internal projects surface has no update endpoint. The v1 surface documents its absent DELETE deliberately (module doc comment); the internal surface's absent PATCH/PUT has no comment at all, and a reader cannot tell deliberate scope from an oversight.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/modules/projects/internal/projects.routes.ts:33-40` — chain is `get("/")`, `post("/")`, `get("/:id")`, `delete("/:id")` — no PATCH/PUT.
2. `apps/server/src/modules/projects/public/projects.v1.routes.ts:27-29` — the module doc comment says: "Deliberately fewer endpoints than `internal/`: there is no DELETE here yet, because publishing one commits us to its semantics forever…" — the pattern for how this repo explains an absent endpoint.
3. There is no web UI that edits projects today.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- This is a comment-only change; no route, handler or test changes.

## Do not

- Do not add a PATCH/PUT endpoint in this plan — adding one is a real feature decision (schema, validation, tenancy, tests) and the finding is about the unexplained absence, not the absence itself.
- Do not edit the v1 module doc comment.
- Do not touch AGENTS.md or README (plans 021/036 own those).

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/modules/projects/internal/projects.routes.ts:33-40` | **Modify.** Add a comment above the chain (or above the handlers) explaining the absent update. |

### Task 1: Say why there is no update

**Files:** `apps/server/src/modules/projects/internal/projects.routes.ts`

- [x] **Step 1:** Read the internal routes file and the v1 module doc comment (`public/projects.v1.routes.ts:27-29`) to match the voice.
- [x] **Step 2:** Add a short comment (2-4 lines) at the top of the internal route chain or above the handler list, in the repo's voice, e.g.:

  ```ts
  // No PATCH/PUT here on purpose: nothing in the web app edits a project yet,
  // and an update endpoint is where validation and tenancy decisions start
  // accumulating — a create/get/list/delete surface is enough until there is a
  // screen that needs more. (The v1 surface explains its own absent DELETE in
  // the module doc comment; this is the same kind of deliberate scope.)
  ```

  Match the actual wording style of the file — read the surrounding comments first and do not introduce a second comment voice.
- [x] **Step 3:** Run the module's tests to prove nothing broke (comments only, but the gate is cheap): `cd apps/server && bun test src/modules/projects/...` with explicit paths.
- [x] **Step 4:** Commit: `docs(projects): the internal surface explains its absent update`.

## Done when

- The internal projects route file states why there is no update endpoint, in the file's own voice.
- No runtime code changed.

## Out of scope

- Adding a PATCH/PUT endpoint (feature decision).
- Editing the v1 surface or any docs outside the route file.
