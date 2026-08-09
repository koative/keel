# keel

Bun + Hono + Drizzle monorepo. Two API surfaces over one domain layer.

## Commands

- `bun run check` — typecheck, tests, lint, dependency drift, architecture rules. Run after every change.
- `bun run dev` — everything; `dev:server` / `dev:web` for one.
- `bun run db:start && bun run db:push` — dev database.
- `bun run db:test:start && bun run db:test:migrate` — disposable test database. Integration suites skip without it.
- `bun run gen:module <name>` — scaffold a server module.

## Map

- `apps/server` — Hono API. `src/modules/<domain>/` per domain, `src/lib/` shared.
- `apps/web` — React SPA. Reaches `/api` through `@keel/api-client`.
- `packages/http` — status codes, error factories, the one response envelope.
- `packages/contracts` — Zod schemas derived from the Drizzle tables.
- `packages/api-client` — `hc<AppType>` over a prebuilt declaration bundle.
- `packages/{db,auth,env,ui,config}` — Drizzle, Better Auth, validated env, shadcn, tsconfig.
- `packages/crypto` — `@keel/crypto/seal` (AES-256-GCM, versioned envelope), `@keel/crypto/equals`.

## Layers

`routes → handlers → service → repository → @keel/db`, one direction only. A
service receives what it needs as a parameter; it cannot import `hono` or reach
the database. A module's internals are private — cross-module traffic goes through
`@/modules/<name>`.

`/api/*` moves with the frontend: unversioned, typed client, absent from the spec.
`/v1/*` is the customer contract: versioned, frozen, and the only thing at `/doc`.
They share one service and one repository, and each has its own Zod schema.

## Tenancy

Organization-only. Nothing belongs to a user: `requireUser` resolves the session
once, `requireOrg` narrows it, and repositories filter `organizationId` in the same
`and(...)` as the id. No session is 401, no active organization is 403, another
organization's row is **404** — never 403, because confirming it exists is the leak.
A service never checks tenancy; it has no field to compare.

## Background work

Anything that can outlive a request goes in the `job` table and runs in
`dist/worker.mjs`, never in a `setInterval` inside the API — a timer runs once per
replica. Enqueue with a `dedupeKey` to collapse duplicate pending work. Webhook
receivers verify over `await c.req.arrayBuffer()`, persist, enqueue, return 200; a
re-stringified body produces a different digest and rejects every event.

## Rules

Everything mechanical is enforced by `bun run check`, not by this file — layer
boundaries, the 200-code-line limit, the response envelope and the import direction are
Biome rules, and `tools/check-rules.ts` proves each still fires. Read a diagnostic
before working around it; the message says what to do instead.

New module or endpoint: `.claude/skills/server-module/SKILL.md`.
