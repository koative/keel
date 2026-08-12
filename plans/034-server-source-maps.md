# Production Server Source Maps Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** ARCH-07 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Give production error traces their source file/line context. The dist bundle is unminified and carries no sourcemaps, so every wide-event stack trace points at line 1 of a bundle column.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/tsdown.config.ts:1-20` — `dts: false`, entries `["./src/index.ts", "./src/migrate.ts", "./src/tasks.ts", "./src/worker.ts"]`, `format: "esm"`, `noExternal: [/@keel\/.*/]`, `outDir: "./dist"` — **no `minify` and no `sourcemap` option at all**.
2. The `compile` script (`apps/server/package.json`) uses `--minify --sourcemap --bytecode` for the single-binary build, but the tsdown dist bundle (what docker runs) is neither minified nor sourcemapped.
3. The repo's observability story (`LOG_DRAIN=otlp` via evlog) gets stacks it cannot map today.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- The bundle must still build and the docker image must not bloat gratuitously.

## Do not

- Do not enable `minify` in this plan. Unminified output is a deliberate readability choice for a starter (the audit itself notes "line and column survive; the loss is source-file attribution only"). The fix is sourcemaps, not minification.
- Do not touch the `compile` script (it already has sourcemaps).

## File structure

| File | Responsibility |
|---|---|
| `apps/server/tsdown.config.ts` | **Modify.** Add `sourcemap: true`. |

### Task 1: Emit sourcemaps

**Files:** `apps/server/tsdown.config.ts`

- [ ] **Step 1:** Add `sourcemap: true` to the tsdown config (check tsdown's option shape — it may be a top-level `sourcemap` boolean or a build option; verify against the installed tsdown version's types).
- [ ] **Step 2:** Decide map file placement: `true` emits `.map` files beside the bundles in `dist/`. Check whether `apps/server/Dockerfile` copies `dist/` wholesale (maps ship in the image — acceptable for a starter, but look at the Dockerfile's `.dockerignore`/`COPY` to see if `*.map` would be excluded; if there is a `.dockerignore`, decide whether maps should ship or be excluded and say so in the commit message). Do not add an exclusion unless there is already a pattern for it.
- [ ] **Step 3:** Rebuild: `cd apps/server && bun run build` (the script that runs tsdown). Confirm `dist/*.map` files appear.
- [ ] **Step 4:** Prove a stack resolves: run one of the built entrypoints (e.g. `bun dist/worker.mjs` briefly with a `LOG_DRAIN=fs` or a forced error path if one is cheap; otherwise state in the commit what was verified — files exist, build green). If the repo has an evlog drain test that inspects stacks, run it.
- [ ] **Step 5:** Commit: `feat(server): production stacks keep their file and line`.

## Done when

- `dist/` emits `.map` files for the server bundles.
- The build passes and the docker build (if trivially runnable) still succeeds.
- The map-file shipping decision is recorded in the commit message.

## Out of scope

- `minify` — deliberately not enabled.
- The single-binary `compile` script — already sourcemapped.
