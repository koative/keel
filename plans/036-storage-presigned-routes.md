# Storage Presigned-URL Routes Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** DIR-02 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Make the fully-implemented, fully-tested storage layer reachable: expose one internal `/api` route pair that returns presigned upload/download URLs through `resolveStorage`, so the documented flow (`.env.example`'s presigned-URL story) is true end to end. Keep it internal — a `/v1` storage surface is a frozen-contract decision.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `packages/storage/src/client.ts:75-86` — `Storage` surface: `createDownloadUrl(key, PresignOptions)`, `createUploadUrl(key, PresignOptions)`, `delete`, `exists`, `read`, `write`. `PresignOptions = { contentType?: string; expiresInSeconds: number }` (required, no default, `:50-56`), `MAX_EXPIRES` 7 days, `assertExpiry` at `:88-100`.
2. `apps/server/src/lib/storage.ts:67` — `resolveStorage(source: StorageEnv = env): Storage`; `:125` returns `createStorage({...})`. **Zero production consumers**: `resolveStorage` is imported only by `storage.test.ts`; no route calls it.
3. The tenant-key prefix guard is already unit-tested in the package.
4. `apps/server` already depends on `@keel/storage` in package.json — the wiring exists, only the route is missing.
5. The internal route pattern to follow: `apps/server/src/modules/projects/internal/` (plain Hono mounted under `/api`, absent from the OpenAPI doc by construction).

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- No file over 200 code lines.
- The route is **internal** (`/api/...`), requires `requireUser` + `requireOrg` (follow the projects internal chain: `new Hono<AppEnv>().use(requireUser).use(rateLimit).use(requireOrg)...`), and returns the envelope via `@keel/http` helpers only.
- When storage is unconfigured (`resolveStorage` throws naming `STORAGE_*`), the route must fail with a clear envelope error, not a raw 500 — check how `resolveAi`-style resolvers are guarded in other modules and mirror it.

## Do not

- Do not add any `/v1` storage surface.
- Do not invent expiry/content-type policy the package doesn't already enforce: `expiresInSeconds` is a required input (1..604800), `contentType` optional. Validate the input with zod on the request schema; do not default either.
- Do not allow arbitrary key shapes — the client's tenant-key prefix guard exists; the route must pass through keys the guard already handles, and the schema should reject keys that cannot be tenant-prefixed (mirror the guard's rules; read `packages/storage/src/client.ts`'s prefix logic first).

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/modules/storage/internal/storage.routes.ts` | **Create.** The internal route pair. |
| `apps/server/src/modules/storage/internal/storage.schema.ts` | **Create.** Zod request schemas. |
| `apps/server/src/modules/storage/internal/storage.handlers.ts` | **Create.** Envelope-shaped handlers calling `resolveStorage`. |
| `apps/server/src/modules/storage/index.ts` | **Create.** Module index exporting the internal routes (single export, per the module convention). |
| `apps/server/src/modules/storage/internal/storage.routes.test.ts` | **Create.** 401/403/422 envelope cases + presigned URL shape. |
| `apps/server/src/internal-routes.ts` | **Modify.** Mount under `/api/storage` on `internalRoutes` — the router `AppType` is derived from — exactly as `/api/projects` is mounted. This plan mounted on `apps/server/src/app.ts` instead; `da28fcc` moved it. See the Follow-up. |

### Task 1: The route pair

**Files:** the module files above

- [x] **Step 1:** Read `apps/server/src/modules/projects/internal/projects.routes.ts` and `index.ts` for the exact mounting chain, and `apps/server/src/lib/storage.ts` for `resolveStorage`'s signature and its unconfigured-throw behavior. Read `packages/storage/src/client.ts` for the key-prefix guard and the presign signatures.
- [x] **Step 2:** Schema: `GET /api/storage/upload-url?key=...&contentType=...&expiresInSeconds=...` and `GET /api/storage/download-url?key=...&expiresInSeconds=...` (or a single `POST /api/storage/presign` with a body — pick the shape that matches how the web app would call it; prefer GET-with-query for URLs and POST for a body if both are needed; keep it minimal — one route pair). Validate `key` (string, tenant-prefixed shape), `expiresInSeconds` (int, 1..604800), `contentType` (optional, non-empty).
- [x] **Step 3:** Handlers: call `resolveStorage()` (its default env source), produce `{ uploadUrl }` / `{ downloadUrl }` (or `{ uploadUrl, downloadUrl }` for upload if the client's `createUploadUrl` covers both — read what it returns). On unconfigured storage, catch and return the envelope error naming the missing `STORAGE_*` key (mirror how other `resolve*` failures are surfaced — check `apps/server/src/lib/ai.ts` or `mail.ts` guard style).
- [x] **Step 4:** Mount under `/api/storage`, following the projects internal mount exactly. **Where this landed was wrong:** the router went onto `app` in `app.ts`, which serves the paths but leaves them out of the declaration bundle, so the typed client could not reach them. Corrected in `da28fcc` — `apps/server/src/internal-routes.ts:26-29` chains `.route("/api/storage", internalStorageRoutes)` on the same declaration as `/api/projects`, and `app.ts` mounts `internalRoutes` at `/`, so the served paths are unchanged. Verified here by reading `internal-routes.ts:26-29`.
- [x] **Step 5:** Tests: route-level, mirroring `projects.routes.test.ts` — unauthenticated → 401; in-org → 200 with `data.uploadUrl`/`data.downloadUrl` containing the presigned query params (host/path/`X-Amz-Expires`/signature shape — reuse the package's existing shape assertions at `packages/storage/src/client.test.ts` style); invalid `expiresInSeconds` → 422; storage-unconfigured → the named-key error. Use the test fixture for storage env if `apps/server/src/lib/storage.test.ts` has one (read it first).
- [x] **Step 6:** Run the new suite with explicit paths: `cd apps/server && bun test src/modules/storage/...`. Green.
- [x] **Step 7:** Commit: `feat(server): presigned upload and download URLs on the internal surface`.

## Done when

- `GET/POST /api/storage/...` returns envelope-shaped presigned URLs through the real `resolveStorage` when configured, and a clear named-key error when not.
- The route pair is internal-only, mounted exactly like the projects internal routes. **True at HEAD** — `apps/server/src/internal-routes.ts:27-28` mount `/api/projects` and `/api/storage` in the same chain — and false when first ticked; the Follow-up says why it mattered.
- The route tests cover 401/403/422 and the presigned URL shape.

## Out of scope

- A `/v1` storage contract.
- A frontend UI that uses the routes.
- **DIR-01** (the AI endpoint) — plan 035; same module-family shape but a different module.

## Follow-up (executed, commit `da28fcc`)

"Mounted exactly like the projects internal routes" was ticked against a mount on
`app` rather than on `internalRoutes`. Both serve `/api/storage/*` identically, so
every route test in this plan passed — the suites go through `test-http.ts`, which
calls `app.request`. What they cannot see is the type surface: plan 029 made
`AppType` derive from `internalRoutes` alone, so a router mounted on `app` is
served and simultaneously invisible to `packages/api-client`. The presigned URLs
this plan exists to expose were unreachable from the SPA through the typed client,
which is most of the point of putting them on the internal surface.

`internalStorageRoutes` is one router carrying both endpoints — `GET /upload-url`
and `GET /download-url` (`apps/server/src/modules/storage/internal/storage.routes.ts:27-40`)
— so there is one mount, not two. `FixHttpMounts` moved it and `/api/ai` into
`apps/server/src/internal-routes.ts:26-29` and proved the client now sees them: a
throwaway probe in `packages/api-client` naming `client.api.storage["upload-url"].$get`
typechecks (`bun run --filter server build:types` then
`bunx tsc --noEmit -p packages/api-client`, exit 0), and fails with
`TS2339: Property 'storage' does not exist` when the mount is reverted. The
declaration bundle now lists `"/api/ai"`, `"/api/projects"` and `"/api/storage"`
where it listed `"/api/projects"` alone. Runtime unchanged:
`bun test src/modules/storage/internal/storage.routes.test.ts src/modules/ai/internal/ai.routes.test.ts`
→ 22 pass / 0 fail. (`apps/server/types/` is a gitignored turbo output, so the
bundle itself is not committed; `bun run check` rebuilds it before reading it.)

The same defect was in the module generator, which is why one plan's mistake was
about to become every future module's: `tools/gen-module.ts` spliced its mount
into `app.ts`. A plan that says "mirror the projects mount" is only safe while the
thing being mirrored is the typed router. Fixed in the generator by
`FixGenModuleRules` — at HEAD it splices into `INTERNAL_ROUTES =
"apps/server/src/internal-routes.ts"` (`tools/gen-module.ts:17`, `:998`) and its
template comment says why (`:995-997`).
