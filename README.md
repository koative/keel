# keel

A SaaS starter where the architecture is enforced by the linter, not described in a document.

Layer violations, hand-rolled response shapes and bloated modules fail CI. The
point is to make it structurally difficult — for a person or an agent, three
months in — to drift from the design.

## Stack

Bun · Hono · Drizzle · Postgres · Better Auth · Zod · React + TanStack Router ·
Turborepo · Biome/Ultracite · evlog · bun:test

## Why another starter?

Most starters give you wiring. Wiring is the easy part; it stays correct for about
a month. What rots is everything a README asked you to remember.

**The layers are lint rules.** A `*.service.ts` cannot import `hono` or reach the
database — Biome rejects it with a message naming the fix. A module's internals
are private: `@/modules/billing/billing.repository` is an error, `@/modules/billing`
is not. Nothing here relies on you recalling a diagram.

**One response envelope, no exceptions.** Every success is `{ data }` and every
failure is `{ error: { code, message, requestId, why, fix } }`. Handlers cannot
call `c.json` — a GritQL plugin blocks it and points at `@keel/http/response`. The
same envelope comes out of a handler, a thrown service error and a 404, so a client
never branches on which layer failed.

**Errors explain themselves.** They are built on evlog's `createError` rather than
a bespoke `AppError`, so the wide event and the HTTP body cannot disagree. `why`
and `fix` reach the caller. A 5xx message never does — an unexpected throw carries
connection strings, and a regression test throws a Postgres URL with a password in
it and asserts the string appears nowhere in the response.

**Two API surfaces, on purpose.** `/api/*` is internal: unversioned, consumed by a
typed `hc` client, and free to change in the same commit as the component reading
it. `/v1/*` is the customer contract: versioned, frozen, and the only thing in the
OpenAPI document. They share one service and one repository. Refactoring the
frontend cannot break an integration, because the internal surface is not in the
spec — a plain Hono cannot register itself in the OpenAPI registry, so that is
true by construction rather than by a filter someone has to remember.

**End-to-end types, and it is checked.** Rename a field on the server and the web
app stops compiling, through a prebuilt declaration bundle so the client package
never re-infers the route tree.

**The enforcement is itself tested.** A rule that quietly stops matching looks
exactly like clean code. `tools/check-rules.ts` violates all thirteen on purpose
and fails if any stops firing. It caught two real regressions while this was being
written.

## Getting started

```bash
bun install
cp .env.example apps/server/.env    # fill in BETTER_AUTH_SECRET
cp .env.example apps/web/.env
bun run db:start && bun run db:push
bun run dev
```

- Web: <http://localhost:3001>
- API: <http://localhost:3000>
- API reference: <http://localhost:3000/reference> · spec at `/doc`

## Checks

```bash
bun run check
```

Typecheck, tests, lint, dependency drift and the architecture rules. One command,
and the same one CI runs.

Integration tests need a disposable database. They skip with a notice when it is
absent, so `bun run check` stays green without Docker — and CI asserts nothing was
skipped, because a run that proved nothing looks identical to one that proved
everything.

```bash
bun run db:test:start && bun run db:test:push
```

## Adding a module

```bash
bun run gen:module invoices
```

Writes the domain layer, both HTTP surfaces and the tests, and mounts `/api/invoices`.
`public/` is written but not mounted: publishing `/v1` is a promise with no expiry
date, so it takes a deliberate edit. Procedure in
`.claude/skills/server-module/SKILL.md`; `apps/server/src/modules/projects/` is the
worked example.

## Layout

```
apps/
  server/           Hono API — src/modules/<domain>/, src/lib/
  web/              React SPA — reaches /api through @keel/api-client
packages/
  http/             status codes, error factories, the one response envelope
  contracts/        Zod schemas derived from the Drizzle tables
  api-client/       hc<AppType> over a prebuilt declaration bundle
  db/ auth/ env/    Drizzle, Better Auth, validated environment
  ui/ config/       shadcn components, shared tsconfig
tools/              catalog drift, architecture rules, module generator
```

## Deployment

`docker compose up -d --build` builds and runs web, server and Postgres. The
server image is a tsdown bundle; the web image is a static build behind nginx.
`docker-compose.yml` is the reference for what each service needs.

## Notes

- Dependency versions live in the root `workspaces.catalog`. `bun add` cannot write
  there, so `tools/check-catalog.ts` fails the build when a workspace pins a version
  the catalog already owns.
- `AGENTS.md` is the agent entry point; `CLAUDE.md` is a symlink to it. It stays
  under 40 lines and deliberately repeats nothing the linter already enforces.
- Logging is evlog's wide-event model: one event per request. 4xx is recorded at
  warn and 5xx at error, so a mistyped identifier does not page anyone.
