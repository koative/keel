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
exactly like clean code. `tools/check-rules.ts` violates every architecture rule on purpose
and fails if any stops firing. It caught two real regressions while this was being
written.

## Getting started

```bash
bun install
cp .env.example .env                # docker compose reads this one
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

Typecheck, tests, lint, dependency drift, the architecture rules and schema/migration
drift. One command, and the same one CI runs.

Integration tests need a disposable database. They skip with a notice when it is
absent, so `bun run check` stays green without Docker — and CI asserts nothing was
skipped, because a run that proved nothing looks identical to one that proved
everything.

```bash
bun run db:test:start && bun run db:test:migrate
```

The test database gets the same migrations production does, so a broken migration
fails the suite rather than only the deploy.

## Going to production

Nothing in this repository defaults an environment variable — not the Zod schema in
`packages/env`, not the compose files, not the code. So `.env.example` is a
checklist rather than a suggestion: every key it lists uncommented has to be
stated, and a missing one fails at startup naming itself. Five of those choices are
worth spelling out, because the wrong answer is invisible on a laptop.

| Setting | Why the repository will not pick it for you |
| --- | --- |
| `LOG_DRAIN=otlp` + `OTLP_ENDPOINT` | `fs` writes into the container filesystem. Wide events are the whole observability story; shipping without a drain discards every one of them. |
| `TRUSTED_IP_HEADER=x-forwarded-for` + `TRUSTED_PROXIES` | Better Auth resolves the client IP from headers only, and reads `x-forwarded-for` by default whether or not you configure one. Unset on a directly reachable app, a caller sends its own address and gets a private bucket, so the 10-per-60s limit on `/sign-in/email` stops applying; set without a proxy list, the same forgery works through the header you named; behind a proxy that appends, the header holds two addresses, resolves to nothing, and your whole user base shares one bucket per path. None of the three is a rate limiter, so the server refuses to start on `NODE_ENV=production` without the header and refuses the header without the proxy list. |
| `bun run db:migrate` in the deploy | `db:push` diffs the live database against the schema and applies what it decides is needed, including dropping a column. That is a development tool. `tools/check-migrations.ts` fails the build when the two drift. |
| `BETTER_AUTH_SECRET` | The signing key of a deployment is not something a repository hands out. |
| `MAIL_DRIVER=resend` + `RESEND_API_KEY` + `MAIL_FROM` | `log` writes every message to stdout and sends nothing. That is right on a laptop and two failures on a server: verification and password reset stop working, and every one-time link they printed is now in the container logs. So the worker refuses `log` when `NODE_ENV=production`, with no opt-out key. `MAIL_FROM` has to be an address on a domain verified with Resend — the sandbox sender `.env.example` ships reaches nobody but the account owner, so `resend` refuses to start on it. |

`SIGTERM` drains in-flight requests, closes the connection pool, then exits — so a
rolling deploy does not drop work. `/health` is liveness and `/ready` checks
Postgres; the container healthcheck polls `/ready`, because a process that cannot
reach its database should leave the load balancer rather than be restarted.

## Rate limiting

Two layers, answering two different questions. Neither substitutes for the other.

The **edge** — nginx, Traefik, Cloudflare — answers *is this a flood?* It sees the
request before the app spends anything on it, and it can only key on an IP or a
header, because a session cookie is opaque to it. The **application** answers *is
this account over its share?* That needs an identity the edge does not have. An
edge limit cannot tell two accounts behind one office NAT apart; an application
limit cannot refuse traffic it is already parsing.

The application limiter is keyed on the **actor**, never the IP, and it runs after
`requireUser`, so the actor is always known. An actor key cannot be spoofed by
rotating addresses, and it does not punish a whole office sharing one. Two buckets
per actor, because a read and a write do not cost the same:

| Setting | Laptop value | Applies to |
| --- | --- | --- |
| `RATE_LIMIT_WRITE_PER_MINUTE` | 60 | `POST`, `PUT`, `PATCH`, `DELETE` |
| `RATE_LIMIT_READ_PER_MINUTE` | 600 | every other method |

Each number is both the per-minute budget and the largest burst: capacity is N and
the bucket refills at N/60 tokens per second, so the burst equals the minute budget
and recovers smoothly instead of at a window edge. `/api/*` and `/v1/*` are limited;
`/health`, `/ready`, `/doc` and `/reference` are not, and `/api/auth/*` is left to
Better Auth, which keys on IP because at sign-in there is no actor yet. A refusal is
a thrown `tooManyRequests`, rendered by `app.onError` as the same problem+json every
other failure uses — which is why every `/v1` operation declares **429**. Limited
responses carry `RateLimit-Limit`, `RateLimit-Remaining` and `RateLimit-Reset`; a 429
adds `Retry-After`.

State is one Postgres row per bucket and **one statement per request** — a
conditional counter upsert that refills from the row's own `updated_at`. Measured at
0.011 ms on top of a 0.214 ms round trip: the round trip is the cost, and you already
pay it. That is why there is no Redis here. The honest trigger for adding one is not
throughput in the abstract, it is the point where a Postgres round trip per request
starts to matter.

**A rate limit is not a quota.** A rate limit is protection, so approximate is fine —
which is exactly why N replicas sharing one Postgres row is right and N in-memory
copies is not, since in-memory silently multiplies every limit by the replica count.
A quota is billing: it must be exact and auditable, and it belongs in the domain
beside the thing being counted, not in a middleware.

**Edge configuration is documented, not shipped**, the same stance as TLS: whatever
already owns your domain owns this. Both snippets below are per-IP flood control in
front of the app, not a replacement for the limiter inside it.

nginx, with `ngx_http_limit_req_module`:

```nginx
http {
    # 10 MB holds roughly 160k IPv4 states; the least recently used is evicted.
    limit_req_zone $binary_remote_addr zone=api:10m rate=20r/s;
    # Rejections are 503 by default, which reads as "our fault".
    limit_req_status 429;

    server {
        location /v1/ {
            # nodelay serves excess up to burst immediately rather than queueing
            # it; past burst the request is rejected.
            limit_req zone=api burst=40 nodelay;
            proxy_pass http://server:3000;
        }
    }
}
```

Traefik, as Docker labels on the server service:

```yaml
labels:
  - "traefik.http.middlewares.api-flood.ratelimit.average=20"
  - "traefik.http.middlewares.api-flood.ratelimit.period=1s"
  - "traefik.http.middlewares.api-flood.ratelimit.burst=40"
  - "traefik.http.routers.server.middlewares=api-flood"
```

or the same middleware in dynamic configuration:

```yaml
http:
  middlewares:
    api-flood:
      rateLimit:
        average: 20
        period: 1s
        burst: 40
```

Traefik's rate is `average` divided by `period` and `burst` is the bucket size. With
no `sourceCriterion` it groups by the request's remote address, so behind another
proxy set `sourceCriterion.ipStrategy.depth` or Traefik will rate-limit that proxy
rather than the client. Verified against the nginx `ngx_http_limit_req_module`
reference (`nginx.org/en/docs/http/ngx_http_limit_req_module.html`) and the Traefik v3
RateLimit middleware reference
(`doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/ratelimit/`),
not from memory.

## Tenancy

Everything a tenant owns belongs to an **organization**, never directly to a user.
A solo account is an organization with one member — one data row, not a second code
path, which is why there is no per-user ownership branch to keep in sync.

`requireUser` resolves the session once and `requireOrg` narrows it. The failure
modes are distinct on purpose: no session is a `401`, a session with no active
organization is a `403` so the SPA can route to onboarding, and a resource that
exists but belongs to another organization is a **`404`** — confirming that another
tenant's row exists is itself a leak. Tenancy is filtered in the repository, in the
same `and(...)` as the id, never checked in a service.

Better Auth's organization plugin owns `organization`, `member` and `invitation`.
An invitation is emailed, and the members page still offers its link to copy —
delivery to a colleague who is not yet in the system is worth a fallback that does
not depend on a provider. Both are why invitations last 7 days instead of the
plugin's 48 hours, and why re-inviting an address cancels the earlier one: you
cannot un-paste a link, so cancelling the invitation is the only revocation there
is.

## Background work

```bash
bun dist/worker.mjs          # or: docker compose up worker
```

A `job` table in Postgres, claimed with `FOR UPDATE SKIP LOCKED`, so scaling is
`--scale worker=N` with no coordination service and no second datastore to back up.
Failures retry with exponential backoff until `maxAttempts`, then stop — a poison
message must not spin forever.

```bash
bun dist/tasks.mjs           # periodic maintenance, from whatever runs your cron
```

A settled job is terminal — no index and no query looks at `done` or `failed`
again — so `tasks.mjs` deletes them after three days, alongside the other sweeps.
Three days keeps `last_error` readable on Monday for something that broke on Friday
without leaving payloads on disk indefinitely. A command rather than a timer inside
the server: a `setInterval` sweeps once per replica, and never at all on a
deployment that scales to zero.

The load-bearing detail is one index: `dedupe_key` is unique only
`WHERE status IN ('pending', 'running')`. Enqueue collapses duplicate work for as
long as the earlier job is in flight — queued or executing — and the same key
becomes usable again once that job is `done` or `failed`. A debounce and a mutex
in one index, with no application-side locking.

Work belongs here rather than in a request whenever it can outlive one. Webhook
receivers are the clearest case: `apps/server/src/lib/webhook.ts` verifies the
signature over the **raw bytes** — a body that was parsed and re-stringified
produces a different digest and rejects every event — refuses a delivery whose own
timestamp is more than five minutes from now in either direction, then persists the
payload, enqueues under the provider's event id, and returns 200. The window bounds
a replay; the event id is what makes processing exactly-once, because
`dedupe_key` is unique only while a job is pending. Providers retry within
seconds, and an LLM or outbound API call does not fit inside that window.

## Transactional email

Not a feature added for completeness. Two compromises elsewhere in this repo
existed only because there was no mailer: invitations last seven days instead of
the plugin's 48 hours, and the members page hands out a link to copy, both because
a human had to carry the invitation to another channel by hand.

**One adapter, one active implementation, chosen by `MAIL_DRIVER`.** `log` writes
the whole message to stdout, so a contributor can sign up, verify an address and
accept an invitation without registering with a provider or holding a key — the
banner says `NOT SENT` in as many words, so a log reader never mistakes a dump for
delivery. `resend` is the other, over `fetch`, with no SDK dependency. Neither is a
default, because a deployment that never chose is one whose password resets go
nowhere while it looks healthy. `MAIL_DRIVER=resend` without `RESEND_API_KEY`
**stops the worker at startup** rather than degrading to `log`, the same stance as
`LOG_DRAIN=otlp` without `OTLP_ENDPOINT`. Refusing to boot is louder and cheaper
than a deployment that looks healthy until a user reports the mail never arrived.
`MAIL_FROM` is guarded the same way: `resend` refuses to start on Resend's sandbox
sender, which delivers only to the account owner, so a verified domain has to
replace it.

**`log` is refused when `NODE_ENV=production`, and that is the third startup
guard.** The banner is honest about not sending, but the dump under it is the
message, and a verification or reset message is a one-time link — a bearer
credential. Printing it is the entire point on a laptop, where it is how a
contributor opens the link; on a server it writes that credential into logs that
are retained, shipped and read far more widely than the database. There is no
opt-out key: a key whose only job is to disarm a guard is a key that gets copied
into production. A host that reports `production` and should not mail real people
uses `resend` with its own key and its own verified domain, which is also the only
way to learn whether delivery works before a user does.

**Every send goes through the queue.** A Better Auth hook enqueues a `mail.send`
job and returns; the worker calls the provider. Both halves of that matter: a
provider having a slow afternoon must not make sign-up slow, and a send that fails
must not be lost once the response has gone out — the queue retries it with the
same backoff everything else gets. The job id is passed to Resend as its
`Idempotency-Key`, so a retry after a timeout that had actually delivered replays
the first outcome instead of putting a second copy in the inbox.

Three Better Auth flows are wired: **address verification**, including on sign-up,
**password reset**, and **organization invitations**. Nothing sends inline, and
`@keel/mail` is the only way out — it reads no environment, so the app owns the one
place `MAIL_DRIVER` becomes a config.

A rendered message is what the job carries, because the token is minted inside the
Better Auth request and cannot be derived again later. A pending `mail.send`
payload is therefore **a live one-time link at rest**. It never goes into a wide
event — the only thing that ever prints it is the `log` driver, where printing it
is the entire point — and settled jobs are swept rather than kept, because a
delivered verification mail has no business leaving its URL in a table for a year.

**What is deliberately not here**, which matters as much as what is:

- **No SMS, Telegram or Slack sink.** Operational alerts about failures are
  observability, not notification. This repo already emits wide events to OTLP;
  routing the interesting ones to Slack is an alerting rule in that tool, where the
  thresholds and the on-call schedule already live, not a module here that would
  duplicate them badly.
- **No customer messaging.** Talking to customers over WhatsApp or Telegram is a
  different subsystem shape entirely — inbound events as well as outbound sends,
  session windows, per-provider template approval and capability limits. It is not
  a second sink behind the same interface, and pretending it is produces an
  abstraction that fits neither.
- **No marketing or bulk email.** Mixing bulk into a transactional sender is how a
  domain's reputation gets destroyed: one campaign's complaint rate starts landing
  password resets in spam. Bulk belongs on its own domain and its own provider
  account.

## Secrets at rest

`@keel/crypto/seal` is AES-256-GCM with a versioned envelope, `v1.<iv>.<tag>.<ct>`.
The version prefix is the point: a key rotation or an algorithm change is detectable
per row, so migrating off one does not need a flag day. Set `SECRETS_ENCRYPTION_KEY`
to `openssl rand -base64 32` before storing a third-party token. No in-repo
integration stores a third-party token through `seal` yet — the cipher ships tested
and documented, and the first consumer (an OAuth provider token column, a webhook
secret store) is where the rotation semantics become load-bearing.

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
  mail/ crypto/     transactional send (log | resend), AES-256-GCM sealing
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
- `better-auth` is the one catalog entry pinned exact (`1.6.25`, no `^`): its config
  surface and the behaviors the auth surface relies on (session defaults, IP trust,
  email-verification gating) shift between minors, and better-auth itself pins its
  core and adapters to the same exact version. Upgrading is a deliberate, manually
  verified change, never an automatic range move.
- `AGENTS.md` is the agent entry point; `CLAUDE.md` is a symlink to it. It stays
  short and deliberately repeats nothing the linter already enforces.
- Logging is evlog's wide-event model: one event per request. 4xx is recorded at
  warn and 5xx at error, so a mistyped identifier does not page anyone.

## Deploying

```bash
docker compose -f docker-compose.prod.yml up -d --build
```

`docker-compose.yml` is a development file. Copying it to a server publishes
Postgres on 5432 with the password `password`, which is why the deployable topology
is a separate file: secrets use the `${VAR:?}` form so a missing value fails the
deploy, Postgres publishes nothing, logs are size-capped, and `TZ`/`PGTZ` are pinned
to UTC because the Better Auth tables use `timestamp` without a zone while domain
tables use `timestamptz`.

Migrations run as a one-shot `migrate` service that `server` and `web` gate on with
`service_completed_successfully`. That makes "migrate once, then start N instances"
structural: a failed migration stops the deploy with the server never started, and
no replica can race another to migrate. It runs `bun dist/migrate.mjs`, which uses
`drizzle-orm`'s migrator over the committed SQL — so the runtime image needs neither
`drizzle-kit` nor the source tree.

**Never run `db:push` against staging or production.** It diffs the live database
and applies what it decides, including dropping a column, and it records nothing —
so a database bootstrapped with `push` will later disagree with the migrator about
what has been applied. `db:push` is for local iteration only.

TLS and routing are deliberately absent: terminate them in whatever already owns
your domain and point it at `server` on port 3000.
