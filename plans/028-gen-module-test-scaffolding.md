# gen-module Test Scaffolding Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** TEST-09 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** A generated module must not pass `bun run check` with its load-bearing wiring (zValidator 422s, middleware ordering, envelope, tenancy SQL) entirely untested. The generator currently emits only `*.service.test.ts`; it must also emit `*.routes.test.ts` (envelope/422/tenancy cases) and `*.repository.test.ts` (tenancy filter + keyset probe) skeletons, and say so in its next-steps message.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `tools/gen-module.ts` emits 11 files via its `files` map: service.ts (:47), repository.ts (:153), fixtures.ts (:188), **service.test.ts (:256 — the only test)**, internal/schema.ts (:312), internal/handlers.ts (:356), internal/routes.ts (:406), public/v1.schema.ts (:438), public/v1.handlers.ts (:504), public/v1.routes.ts (:549), index.ts (:654). The next-steps prompt at `:749-750` mentions only `*.v1.routes.contract.test.ts` as a manual step.
2. The reference module `apps/server/src/modules/projects/` has: `internal/projects.routes.test.ts`, `internal/projects.routes.tenancy.test.ts`, `public/projects.v1.routes.test.ts`, `public/projects.v1.routes.contract.test.ts`, `projects.repository.test.ts`, `projects.repository.paging.test.ts`, `projects.service.test.ts`, `projects.service.tenancy.test.ts`, `projects.fixtures.ts` — the exact route/tenancy/repository/paging tests the generator never writes.
3. The scaffolded module's routes are already mounted into `apps/server/src/app.test.ts` (the generator's next-steps says "add it to the expected operations in apps/server/src/app.test.ts").

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- Generated files must match the repo's naming convention (`tools/check-naming.ts` enforces `<subject>[.<aspect>].test.ts` beside `<subject>.ts`).
- Generated tests must be deterministic and DB-gated the same way the reference module's tests are (check how `projects.repository.test.ts` and `projects.routes.test.ts` handle the test DB / skip).

## Do not

- Do not change the module's runtime files (service/repository/routes/schema) — only the generator's file map and prompt.
- Do not hand-edit an already-generated module in this plan; the proof is generating a throwaway module and running its tests (then deleting it, or leaving it only if the plan explicitly says to commit it — prefer deleting and proving via the generator's own output).
- Do not add `*.v1.routes.contract.test.ts` to the generator output unless it can be made correct for an unmounted public surface — check whether the generated public routes are mounted at generation time; if not, keep it as the manual next-step and say so.

## File structure

| File | Responsibility |
|---|---|
| `tools/gen-module.ts` | **Modify.** Emit `internal/<name>.routes.test.ts`, `<name>.repository.test.ts` (and service.tenancy if the generator's service differs from projects'). Update the next-steps prompt. |

### Task 1: Emit route and repository test skeletons

**Files:** `tools/gen-module.ts`

- [ ] **Step 1:** Read the generator's file map and the `files: Record<string, string>` emission points (:47, :153, :188, :256, :406). Read the reference module's `projects.routes.test.ts`, `projects.routes.tenancy.test.ts` and `projects.repository.test.ts` to extract the skeleton shapes (which imports, which app/DB wiring, which assertions are generic vs project-specific).
- [ ] **Step 2:** Add two (or three) entries to the file map, with the module name substituted, mirroring the reference skeletons but generic:
  - `internal/<name>.routes.test.ts` — mounts the module's internal routes the way `projects.routes.test.ts` does, asserts: unauthenticated request → 401 envelope; authenticated-but-not-in-org → 403 or 404 per tenancy rules (read the reference); invalid body → 422 with the zValidator error shape; a 404 on an unknown id. All assertions against `@keel/http`'s envelope shape.
  - `<name>.repository.test.ts` — asserts the repository's `and(...)` tenancy filter returns nothing for another organization's rows, and a keyset/paging probe if the module has a list endpoint (the reference has `projects.repository.paging.test.ts`; check whether the generator's repository emits a cursor — if it does, include the probe; if not, skip it with a comment).
  - If the generator's service has an async boundary worth covering beyond what `service.test.ts` already does, skip — `service.test.ts` already exists.
- [ ] **Step 3:** Update the next-steps prompt (`:749-750`) to list the newly generated test files and the manual contract-test step (if the public surface is not mounted).
- [ ] **Step 4:** Prove it: run the generator to a throwaway module name (`bun tools/gen-module.ts <scratch-name>` — check its CLI flags first), then run the generated tests with explicit paths (`cd apps/server && bun test src/modules/<scratch-name>/...`), then delete the throwaway module tree. Iterate until the generated tests pass green against the test DB.
- [ ] **Step 5:** Run `bun tools/check-naming.ts` to confirm the new file names pass the convention.
- [ ] **Step 6:** Commit: `feat(tools): gen-module scaffolds route and repository tests`.

## Done when

- `gen-module` emits a routes test and a repository test skeleton covering: 401/403/404/422 envelope cases and the tenancy filter, per the reference module's patterns.
- The next-steps message lists the new test files.
- A throwaway generated module's tests pass, then the module is removed (working tree clean of it).

## Out of scope

- **TEST-10/014** (check-rules fixture coverage) — already landed.
- The v1 contract test generation (kept as a manual step if the public surface is unmounted at generation time).
- The SKILL.md docs — unless the generator's next-steps references them and the wording must change with the new files.
