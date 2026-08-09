---
name: server-module
description: Add or extend a server module in keel — domain layer, internal /api surface, public /v1 contract, and the tests each layer needs. Use when adding an endpoint, a domain, or a database table to apps/server.
---

# Adding to the server

`apps/server/src/modules/projects/` is the worked example. Read it rather than
this file for anything about shape; what follows is the order of operations and
the decisions that are not obvious from the code.

## New module

```
bun run gen:module invoices
```

That writes the file set, registers both surfaces in `apps/server/src/app.ts`,
and leaves every file compiling. Then fill it in, in this order:

1. **Table** — `packages/db/src/schema/<domain>.ts`, exported from
   `schema/index.ts`. Unique constraints matter: `withUniqueConflict` in
   `@keel/db/errors` turns SQLSTATE 23505 into a 409, and without a constraint
   that path is untested and unreachable.
2. **Contracts** — `packages/contracts/src/<domain>.ts`. Derive with
   `createSelectSchema` / `createInsertSchema` and `.pick()` the fields the API
   may see. Picking is deliberate: taking every column means a new column is
   published the moment it is added.
3. **Domain type and store port** — in `<domain>.service.ts`. The service declares
   its own row type and the persistence interface it needs. It may not import
   `@keel/db`; that is what keeps the business rules from moving when the schema
   does.
4. **Repository** — the only file allowed to touch Drizzle. Do not annotate return
   types with the service's domain type; that would invert the dependency. The
   structural check happens where the handler assembles the context.
5. **Service** — plain functions taking `(input, ctx)`. `ctx` carries `actorId`,
   `log` and `repository`, so a unit test needs no database and no HTTP server.
   Most tests belong here.
6. **Internal surface** — `internal/`. Plain Hono, `zValidator(..., rejectInvalid)`,
   rich schema, no version. Free to change alongside the component that reads it.
7. **Public surface** — `public/`. `OpenAPIHono` + `createRoute`, narrow schema,
   frozen. Only what a customer needs, and never a field you are unwilling to
   maintain forever.
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

Ownership: a resource belonging to another actor is **404, not 403**. A 403
confirms the id exists, which is enough to enumerate another tenant's data.

## Tests

| Layer | Kind | Needs |
| --- | --- | --- |
| service | unit, fake store and logger from `<domain>.fixtures.ts` | nothing |
| repository | integration against real Postgres | test database |
| routes | end to end via `app.request()`, real session from `signUp()` | test database |
| public/v1 | asserts the OpenAPI document at `/doc` | nothing |

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
