---
name: server-module
description: Add or extend a server module in keel — domain layer, internal /api surface, public /v1 contract, and the tests each layer needs. Use when adding an endpoint, a domain, or a database table to apps/server.
---

# Adding to the server

`apps/server/src/modules/projects/` is the worked example. Read it rather than
this file for anything about shape; what follows is the order of operations and
the decisions that are not obvious from the code.

## Tenancy, before anything else

Every tenant-scoped resource belongs to an **organization**, never directly to a
user. A single-user account is an organization with one member — one data row,
not a second code path. Read this section before writing a table; almost every
decision below follows from it.

- Better Auth's `organization()` plugin owns `organization`, `member` and
  `invitation`, and puts `activeOrganizationId` on the session.
- `requireUser` resolves the session once and sets `actorId` and
  `activeOrganizationId`. `requireOrg` only asserts, so it must be mounted
  **after** `requireUser` and must never resolve the session again.
- `actorId` is recorded, never consulted to decide what may be seen. The tenant
  is `organizationId`.

## New module

```
bun run gen:module invoices
```

That writes the file set, mounts the internal surface in
`apps/server/src/app.ts`, and leaves every file compiling. `public/` is written
but deliberately left unmounted: publishing a `/v1` endpoint is a promise with no
expiry date, so it takes a deliberate edit. Then fill it in, in this order:

1. **Table** — `packages/db/src/schema/<domain>.ts`, exported from
   `schema/index.ts`. Org-scoped like every tenant table: `organizationId` text
   notNull referencing `organization.id` with `onDelete: "cascade"`, and
   `createdBy` text nullable referencing `user.id` with `onDelete: "set null"` —
   removing a member must not delete the organization's work. Unique constraints
   matter and are keyed on `(organizationId, ...)`: `withUniqueConflict` in
   `@keel/db/errors` turns SQLSTATE 23505 into a 409, and without a constraint
   that path is untested and unreachable. Per organization, not global: two
   tenants may both want the slug `billing`.
2. **Contracts** — `packages/contracts/src/<domain>.ts`. Derive with
   `createSelectSchema` / `createInsertSchema` and `.pick()` the fields the API
   may see. Picking is deliberate: taking every column means a new column is
   published the moment it is added. Leave `organizationId` out — the caller is
   already scoped to one organization, so repeating it on every item says nothing.
3. **Domain type and store port** — in `<domain>.service.ts`. The service declares
   its own row type and the persistence interface it needs. It may not import
   `@keel/db`; that is what keeps the business rules from moving when the schema
   does. The row type omits `organizationId`: a field the service can read is a
   field it can compare, and tenancy is not a service-layer check. Every store
   member takes `organizationId`, so a query that forgot the tenant is a type
   error.
4. **Repository** — the only file allowed to touch Drizzle, and the only place
   tenancy is enforced. Every statement filters on `organizationId` inside the
   same `and(...)` as the id. Do not annotate return types with the service's
   domain type; that would invert the dependency. The structural check happens
   where the handler assembles the context.
5. **Service** — plain functions taking `(input, ctx)`. `ctx` carries `actorId`,
   `log`, `organizationId` and `repository`, so a unit test needs no database and
   no HTTP server. Most tests belong here.
6. **Internal surface** — `internal/`. Plain Hono, `.use(requireUser)` then
   `.use(requireOrg)`, `zValidator(..., rejectInvalid)`, rich schema, no version.
   Free to change alongside the component that reads it. Project the row field by
   field rather than spreading it: the stored row carries `organizationId` at
   runtime even though the domain type does not declare it, so a spread publishes
   the tenancy key.
7. **Public surface** — `public/`. `OpenAPIHono` + `createRoute`, narrow schema,
   frozen. Both guards apply here too, so every operation declares **403**
   alongside 401, and every operation carries `security: [{ sessionCookie: [] }]`
   — the scheme `app.ts` registers, stated per route so an operation that is ever
   made anonymous has to say so. `/v1` is rate limited as a whole, so every
   operation also declares **429**, reads included. Every non-2xx response is
   declared with `problemContent`, never `jsonContent`: errors are served as
   `application/problem+json`, and a generated SDK matches on the declared media
   type. Lists are keyset-paged like `projects`, returning `meta.nextCursor`
   beside the data. Only what a customer needs, and never a field you are
   unwilling to maintain forever.
8. **`index.ts`** — the module's only export. Nothing outside the directory may
   name a file inside it.

## New endpoint on an existing module

Service first, then the repository query it needs, then the surface. Adding to
`internal/` is cheap. Adding to `public/` publishes a promise: it needs a
`createRoute` definition listing **every** status it can return, and a matching
expectation in `<domain>.v1.contract.test.ts`.

## Errors

Throw from `@keel/http/errors`; never construct a response body. A service throws,
`app.onError` renders. Fill in `why` and `fix` — both reach the client, and an
error that explains itself costs one line here and saves a support thread.

Tenancy has exactly three failure modes, and they are not interchangeable:

| Situation | Status | Thrown by |
| --- | --- | --- |
| no session | 401 | `requireUser` |
| session, but no active organization | 403 | `requireOrg` |
| row exists, belongs to another organization | 404 | the service, on an empty read |

The 404 is the one people get wrong. A 403 confirms the id exists, which is
enough to enumerate another tenant's data one guess at a time. You do not write
that 404 as a policy: the repository filtered on `organizationId`, so the row is
simply not there and 404 is the only answer available. If you find yourself
comparing an id to `ctx.organizationId` in a service, the query is wrong.

## Tests

| Layer | Kind | Needs |
| --- | --- | --- |
| service | unit, fake store and logger from `<domain>.fixtures.ts` | nothing |
| repository | integration against real Postgres, `seedOrganization()` per tenant | test database |
| routes | end to end via `app.request()`, real session from `signUp()` | test database |
| public/v1 | asserts the OpenAPI document at `/doc` | nothing |

`signUp()` returns an onboarded session — a user with one organization, active.
Call it twice to get two tenants; `signUpWithoutOrganization()` returns the
in-between state that must produce a 403. Two tests are not optional for a
tenant-scoped module: another organization's row is a **404 and not a 403**, and
a unique index keyed on the organization admits the same value in two tenants.

Tests live beside the code, never in `__tests__`. Integration suites gate on
`testDbReady()` and announce the skip. Do not mock Drizzle — the thing under test
is whether the query is right. Do not test Zod, Hono or Drizzle themselves, and do
not chase a coverage number.

Never add a `__snapshots__` file for a public contract. `bun test -u` can re-bless
one without anyone reading the diff, which is the accident the contract test exists
to prevent.

## Before saying you are done

`bun run check`. If a layer rule fires, the diagnostic names the fix; moving the
import is the answer, editing `biome.jsonc` is not. If you genuinely need a new
exemption, add a fixture to `tools/check-rules.ts` in the same commit so the
exemption is itself tested.
