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
- `packages/mail` — `@keel/mail/send` (`log` | `resend`), `@keel/mail/queue`, templates.

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
replica. `enqueue` from `@/lib/jobs` is the only way in — `jobs.repository` is private
to that module — and takes a `dedupeKey` to collapse duplicate in-flight work. Webhook
receivers verify over `await c.req.arrayBuffer()`, refuse a delivery stamped more than
five minutes from now, persist, enqueue under the provider's event id, return 200; a
re-stringified body produces a different digest and rejects every event.

Mail is queued work, never inline: a hook calls `enqueueMail` and the worker sends,
so a slow provider cannot slow sign-up and a failed send is retried instead of lost.
`@keel/mail` is the only way out — nothing else talks to a provider. A `mail.send`
payload is a rendered message holding a one-time link, so it is never logged and
`dist/tasks.mjs` sweeps settled jobs. Packages import `enqueue` from `@keel/db/jobs`
because they cannot reach app code; server-side callers keep using `@/lib/jobs`.

## Configuration

No environment variable has a default — not in `packages/env`, not in a compose
file, not behind a `??` in code. A key is either required, and named in
`.env.example`, or `.optional()` and guarded at the point of use by a `resolve*`
that throws naming it (`resolveMailConfig`, `resolveDrain`, `resolveAi`,
`resolveStorage`). Adding `.default(…)` to that schema is how a deployment ends up
mailing to stdout or dropping every wide event while looking healthy; add the key to
`.env.example`, `apps/server/.env`, `.env.test` and `docker-compose.prod.yml`'s
`x-app-env` instead. Zod defaults on a *request* schema are unrelated and fine.

Four env files, and `.env.test` is the only committed one: root `.env` for compose
interpolation, `apps/server/.env`, `apps/web/.env`, `.env.test` for both bun:test
preloads.

## Migrations

A migration is append-only history: change the schema, run `bun run db:generate`, and
let the new file say what changed. `tools/check-migrations.ts` replays the committed
SQL against the Drizzle tables and fails on a column the migrations declare that the
schema does not, on a nullability disagreement, and on a `.sql` file the journal does
not list — but it cannot see a hand-edited DEFAULT, type, index or constraint, so it
is a floor and not a proof.

Editing a committed migration is the exception, and `0001` is the one that took it:
a database created before `project.organization_id` existed had no upgrade path, and
a new migration cannot retroactively fix the file that stranded it. It was safe for a
reason worth knowing before reaching for it again — drizzle gates re-application on
the stored `created_at` against the journal's `when`, and never compares the sha256 it
also stores, so a database that already applied the old file skips it and the stale
hash is read by nothing. That makes the edit invisible to deployed databases, which is
exactly why nothing but a broken upgrade path justifies it.

## Rules

Everything mechanical is enforced by `bun run check`, not by this file — layer
boundaries, the 200-code-line limit, the response envelope and the import direction are
Biome rules, and `tools/check-rules.ts` proves each still fires. Read a diagnostic
before working around it; the message says what to do instead.

New module or endpoint: `.claude/skills/server-module/SKILL.md`.
