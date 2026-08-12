# Declaration Bundle /v1 Surface Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** ARCH-01 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Stop the typed-client declaration bundle from degrading the `/v1` surface to `any` and carrying undeclared generic identifiers. The internal `/api` half of `AppType` is concrete and correct; the `/v1` half is noise — either emit it correctly or exclude it, and make the exclusion the default.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/types/app.d.mts:147-302` — `/v1/projects` branches carry phantom generic types with no declaration in the file: `:147` `[x: string]: z.input<Part extends keyof R["request"] ? R["request"][Part] : {}>;`, `:195` `json: z.input<R_1["request"]["body"]["content"][keyof R_1["request"]["body"]["content"]]["schema"]>;`, and `output: any;` on every status variant (200/401/403/422/429/404/201/409/413). `:303` `type AppType = typeof routes;`, `:305` `export { AppType, app };`.
2. `apps/server/tsdown.types.config.ts:15-20` — `dts: { emitDtsOnly: true }, entry: "./src/app.ts", format: "esm", outDir: "types", tsconfig: "./tsconfig.json"` — the bundle entry is the **whole app** including the public routes.
3. `apps/server/package.json` exports `"./app-type": { "types": "./types/app.d.mts" }`; `packages/api-client/src/index.ts:1` imports `AppType` from `server/app-type`.
4. `packages/config/tsconfig.base.json:15` — `"skipLibCheck": true`, which suppresses the free identifiers. Any consumer compiling without `skipLibCheck` breaks.
5. The `/v1` surface is not used by the client today (the web app reaches `/api` only).

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- `packages/api-client`'s consumers (apps/web) must still typecheck — the internal surface must keep its concrete types.

## Do not

- Do not hand-edit `types/app.d.mts` — it is generated; the fix is in what feeds the generator.
- Do not delete the `/v1` runtime routes — only their presence in the *type* bundle changes.
- Do not weaken `skipLibCheck` handling without a CI gate that typechecks the bundle with it off (see Task 2).

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/app.ts` | **Modify.** Split the internal router out so the type bundle can target it alone. |
| `apps/server/tsdown.types.config.ts` | **Modify.** Point `entry` at the internal-only router. |
| `apps/server/types/app.d.mts` | **Regenerate.** Must no longer contain `/v1` branches or `R["request"]`/`R_1`/`Part`. |

### Task 1: Type the internal surface, not the whole app

**Files:** `apps/server/src/app.ts`, `apps/server/tsdown.types.config.ts`, regenerated `types/app.d.mts`

- [ ] **Step 1:** Read `apps/server/src/app.ts` end to end — how the internal routes are mounted (the audit notes `app.ts:148-150` — "internalProjectRoutes is a plain Hono, absent from the OpenAPI document by construction"). Find the smallest router object that carries the `/api/*` surface and nothing else.
- [ ] **Step 2:** Export that internal router under a stable name (e.g. `export const internalRoutes`) alongside the existing `app` export, with a comment saying why it exists: the type bundle targets it so the client's `AppType` never sees the frozen `/v1` half. Keep `app` as the runtime entry unchanged.
- [ ] **Step 3:** Change `tsdown.types.config.ts`'s `entry` to the module exporting `internalRoutes` (or add a second entry), so the emitted `app.d.mts` derives `AppType` from the internal router only.
- [ ] **Step 4:** Regenerate the bundle (the repo's `build:types` task or the exact command the config implies — check `apps/server/package.json` for `build:types`/`types` scripts) and confirm `types/app.d.mts` no longer contains `/v1`, `R["request"]`, `R_1`, `Part`, or `output: any`.
- [ ] **Step 5:** Typecheck with `skipLibCheck` off to prove the file is now self-contained: run `tsc --noEmit` (or a scoped invocation) against the bundle with `--skipLibCheck false` — expected: no unresolved-name errors. Record the exact command used.
- [ ] **Step 6:** Confirm the client still works: `cd apps/web && bun run check-types` (or the package's typecheck) — green.
- [ ] **Step 7:** Commit: `fix(types): the typed client covers the surface it is allowed to use`.

### Task 2: A gate so it cannot silently rot again

**Files:** `.github/workflows/ci.yml` (or the root check script — pick whichever is the smaller, more honest home)

- [ ] **Step 1:** Add a CI step (or a `tools/` script wired into `bun run check` if the repo prefers that — match the existing pattern of `check-*` tools) that typechecks `types/app.d.mts` with `skipLibCheck: false`. If it belongs in CI, add it after the `bun run check` step with a comment: the bundle must stay self-contained even though the base tsconfig suppresses it.
- [ ] **Step 2:** Prove the gate fires: temporarily reintroduce a `/v1` branch into the type source (revert the entry change in memory), run the gate, confirm it fails naming the free identifiers, then restore.
- [ ] **Step 3:** Commit: `ci: the declaration bundle must typecheck without skipLibCheck`.

## Done when

- `types/app.d.mts` contains no `/v1` branches, no `R["request"]`/`R_1`/`Part`, and no `output: any`.
- It typechecks with `skipLibCheck: false`.
- The web app's client still typechecks and the runtime `/v1` routes are untouched.

## Out of scope

- **ARCH-02** (the client's `init` option spread) — plan 030, same file family but a different edit; coordinate if concurrent (030 owns `packages/api-client/src/index.ts`'s `hc` call, this plan owns the type source feeding it).
- Generating `/v1` types from OpenAPI — a bigger project, deliberately not attempted.
