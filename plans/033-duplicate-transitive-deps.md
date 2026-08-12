# Duplicate Transitive Dependencies Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** ARCH-06 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Resolve (or explicitly document) the duplicate `@tanstack/react-store` in the bundle graph. The zod duplication is CLI-internal and benign; the react-store split is a real double-ship.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `bun.lock:893` `@tanstack/react-store@0.11.1` (hoisted) pulled by `@tanstack/react-form@1.33.4`'s dep `"@tanstack/react-store": "^0.11.0"` (bun.lock:887); apps/web declares `@tanstack/react-form: ^1.33.2` (catalog after plan 031 — check current state).
2. `bun.lock:2115` `@tanstack/react-router/@tanstack/react-store@0.9.3` (nested) pulled by `@tanstack/react-router@1.170.23`'s dep `"@tanstack/react-store": "^0.9.3"` (bun.lock:889); web/router via catalog `^1.170.18`.
3. **No workspace package.json declares `@tanstack/react-store` directly** — the 0.11.1 vs 0.9.3 split is pure transitive incompatibility (react-form wants ^0.11.0, react-router wants ^0.9.3) and persists at HEAD.
4. `bun.lock:2083` `zod@4.4.3` (root/catalog) + `bun.lock:2165` `shadcn/zod@3.25.76` (nested under the shadcn CLI, pulled by packages/ui's `shadcn: ^4.16.0`). drizzle-zod's peer accepts `^3.25.0 || ^4.0.0` (bun.lock:1205), so the CLI-internal zod 3 never enters the app bundle graph.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- `bun install --frozen-lockfile` must succeed after any lockfile change.
- The web app must typecheck AND build after any dependency resolution change — a react-store major mismatch would surface here.

## Do not

- Do not "fix" the zod 3/4 split — it is the shadcn CLI's own internal dependency, never bundled into the app; forcing it out via overrides is churn for zero runtime benefit. Document it instead.
- Do not upgrade react-router or react-form in this plan — the goal is one react-store copy, not a framework upgrade. Only if aligning via `overrides` is impossible without an upgrade should you fall back to documentation, and then the fallback must be stated explicitly in the commit.
- Do not add `@tanstack/react-store` as a direct dependency of apps/web just to pin it — that changes what the app declares, not what the transitive graph resolves.

## File structure

| File | Responsibility |
|---|---|
| `package.json` (root) | **Modify.** Add an `overrides` entry pinning `@tanstack/react-store` (if alignment is possible). |
| `bun.lock` | **Regenerate** via `bun install`. |
| README or a deps comment | **Modify** only if documenting the remaining split. |

### Task 1: One react-store

**Files:** root `package.json`, `bun.lock`

- [x] **Step 1:** Confirm the current state: `bun pm ls --all 2>/dev/null | grep react-store` (or grep bun.lock) — both versions present.
- [x] **Step 2:** Add to root `package.json` (the `overrides` key — check whether bun honors it; Bun supports `"overrides"` in package.json, and also `"resolutions"`-style via `overrides` — verify against the installed Bun's docs in the repo's bun version, e.g. `bun --version`, and the repo's existing conventions; if the repo has no precedent, prefer Bun's documented `overrides`):
  ```json
  "overrides": {
    "@tanstack/react-store": "0.11.1"
  }
  ```
  (Version: the hoisted one already in the graph, so the override is a downgrade for react-form and an upgrade for react-router — the risky direction. Alternative: try `0.11.1` first; if react-router's types break under 0.11.x, try pinning both transitives via `"@tanstack/react-router": { "@tanstack/react-store": "0.11.1" }`-style scoped override if Bun supports it.)
- [x] **Step 3:** `bun install`, then verify `bun.lock` has exactly one `@tanstack/react-store` version (grep). Run `cd apps/web && bun run check-types` and `cd apps/web && bun run build` — both green. Run the web tests if any (`bun test` in apps/web — explicit paths).
- [ ] **Step 4:** Not needed — the single override succeeded: `bun.lock` resolves exactly one `@tanstack/react-store@0.11.1` and the web app typechecks (`check-types` exit 0) and builds (`build` exit 0) under it. If a single override breaks typecheck or build (react-router's `^0.9.3` types are not compatible with 0.11.x), revert the override, and instead **document** the split: add a comment in root package.json near the catalog (or the README's dependency section — check where plan 031 records catalog rationale) stating that the react-store 0.11.1/0.9.3 split is a transitive incompatibility between react-form and react-router, is tracked, and must be revisited when either library releases a compatible range. State in your report exactly what failed and why you chose documentation.
- [x] **Step 5:** Commit either outcome: `chore(deps): one react-store in the graph` OR `docs(deps): the react-store split is a tracked transitive conflict`.

## Done when

- Either `bun.lock` contains one `@tanstack/react-store` version and the web app typechecks + builds, or the split is explicitly documented with the reason and the failure evidence.
- The zod 3/4 split is acknowledged in the same commit/comment as benign (CLI-internal, never bundled).
- `bun run check` passes.

## Out of scope

- **ARCH-03/04** (catalog literals, unused runtime deps) — plan 031, an earlier wave.
- Upgrading react-router or react-form.
