# Dependency Catalog and Unused Runtime Deps Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** ARCH-03 + ARCH-04 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Close the version-governance blind spot: the remaining literal ranges in `apps/web` and `packages/ui` bypass the workspace catalog and Renovate; and `packages/db`/`packages/auth` declare runtime deps (`zod`, `dotenv`) they do not import, while the root pins `better-auth` exactly with no recorded reason.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/web/package.json` literal ranges (not catalog): deps `@hookform/resolvers ^5.5.7`, `@tanstack/react-form ^1.33.2`, `vite-plugin-pwa ^1.3.0`; devDeps `@vite-pwa/assets-generator ^1.0.2`, `@vitejs/plugin-react ^6.0.4`, `postcss ^8.5.24`. Everything else is `catalog:`.
2. `packages/ui/package.json` literal ranges: `@base-ui/react ^1.6.0`, `@shadcn/react ^0.2.1`, `class-variance-authority ^0.7.1`, `clsx ^2.1.1`, `shadcn ^4.16.0`, `tailwind-merge ^3.6.0`, `tw-animate-css ^1.4.0`.
3. `packages/db/package.json` runtime deps include `dotenv: catalog:` and `zod: catalog:`; `packages/auth/package.json` runtime deps include `dotenv: catalog:` and `zod: catalog:`. Per the audit, neither package imports them at runtime — env reaches them via `@keel/env/server`. **Exception:** `packages/db/src/drizzle.config.ts` does use `dotenv` (ARCH-04 reframed: move it to `devDependencies`, don't delete it from db).
4. Root `package.json:40` catalog pins `better-auth: 1.6.25` exact, with no comment; every other catalog entry is a `^` range.
5. `tools/check-catalog.ts:47` skips any dep not owned by the catalog — which is why these literals never fail the gate.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- The catalog pins the *same version string* the literal currently declares — moving a dep into the catalog is a governance change, not an upgrade.
- `bun install --frozen-lockfile` must still succeed, and `bun.lock` must not gain new packages.

## Do not

- Do not upgrade any dependency version in this plan.
- Do not remove `dotenv` from `packages/db` — it is used by `drizzle.config.ts`; move it to `devDependencies`.
- Do not delete `zod` from `packages/db` if anything in `packages/db/src` (other than config) imports it — verify first.
- Do not touch the `better-auth` exact pin without adding the reason as a comment (or converting it if the reason is "none" — but prefer documenting: 1.6.25 is pinned because… check whether the repo records why anywhere, e.g. commit history or a comment in `packages/auth`).

## File structure

| File | Responsibility |
|---|---|
| `package.json` (root) | **Modify.** Add the 13 literal deps to `workspaces.catalog` with their current literal versions; comment the `better-auth` pin. |
| `apps/web/package.json` | **Modify.** Literal → `catalog:` for the 6 deps. |
| `packages/ui/package.json` | **Modify.** Literal → `catalog:` for the 7 deps; move the `shadcn` CLI to `devDependencies` if it is currently in runtime deps (per ARCH-03's surviving point). |
| `packages/db/package.json` | **Modify.** `zod` out; `dotenv` to `devDependencies`. |
| `packages/auth/package.json` | **Modify.** `zod` and `dotenv` out (verify no import first). |

### Task 1: Bring the literals into the catalog

**Files:** root `package.json`, `apps/web/package.json`, `packages/ui/package.json`

- [x] **Step 1:** Read `tools/check-catalog.ts` to understand exactly what it validates (it skips non-catalog-owned deps — after this plan, none of the 13 may remain skipped; re-read the skip logic to see if it also expects the catalog to own *all* workspace deps).
- [x] **Step 2:** Add the 13 entries to `workspaces.catalog` with their exact current literal versions (read them from the package.json files; do not guess).
- [x] **Step 3:** Switch each literal range to `catalog:` in the two package.json files. Keep the dev/runtime split as it is, except: if `packages/ui` lists the `shadcn` CLI in runtime `dependencies`, move it to `devDependencies` (the CLI is build tooling; its consumers shouldn't ship it) — verify no runtime code imports `shadcn` first.
- [x] **Step 4:** Run `bun install` (not frozen) to regenerate `bun.lock`, then `bun install --frozen-lockfile` to prove the lock is consistent. Confirm `git diff bun.lock` shows **no package version changes** — only the lockfile's representation of the same versions (or nothing at all).
- [x] **Step 5:** Run `bun tools/check-catalog.ts` — green. Run `bun run check-types` (turbo) — green.
- [x] **Step 6:** Commit: `chore(deps): the last literal ranges move into the catalog`.

### Task 2: Dead runtime deps and the undocumented pin

**Files:** `packages/db/package.json`, `packages/auth/package.json`, root `package.json`

- [ ] **Step 1:** Verify by grep that `packages/db/src` (excluding `drizzle.config.ts`) and `packages/auth/src` never import `zod` or `dotenv` directly (`import ... from "zod"` / `"dotenv"`). Include `.test.ts` files in the check — a test import still justifies the dep.
- [ ] **Step 2:** In `packages/db/package.json`: remove `zod` from deps (if the grep is clean); move `dotenv` to `devDependencies` (it is used by `drizzle.config.ts`).
- [ ] **Step 3:** In `packages/auth/package.json`: remove `zod` and `dotenv` from deps if the grep is clean.
- [ ] **Step 4:** In root `package.json` catalog: replace the bare `"better-auth": "1.6.25"` with the same value plus a trailing comment (JSON comments are not valid in package.json — use the supported form: an adjacent `//` is invalid, so instead check whether the repo already uses a `"catalog": { ... }` with comments elsewhere; if JSON forbids it, document the pin reason in `packages/auth/src/index.ts`'s header comment or a `//` comment is impossible — use the catalog key order and a README/AGENTS note if needed). Prefer: add the reason to the nearest human-readable file (`packages/auth/package.json` can't comment either — so put it in `packages/auth/src/index.ts`'s module doc or the root README's dependency section). If the repo already has a convention for this, follow it.
- [ ] **Step 5:** `bun install --frozen-lockfile` succeeds; `bun tools/check-catalog.ts` green; typecheck green.
- [ ] **Step 6:** Commit: `chore(deps): packages declare what they import`.

## Done when

- No literal range remains in `apps/web` or `packages/ui` package.json (all catalog:).
- `packages/db` and `packages/auth` declare no runtime dep they do not import; `dotenv` lives in db's devDependencies.
- The `better-auth` exact pin has a recorded reason.
- `bun.lock` shows no version changes; `check-catalog` and the full typecheck pass.

## Out of scope

- **ARCH-06** (duplicate transitive deps, `@tanstack/react-store` 0.11.1 vs 0.9.3, shadcn's internal zod 3) — plan 033.
- Upgrading any dependency.
