# Bounded Retention Sweeps Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** PERF-02 (`plans/audit-report.md:187-193`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Goal:** Make the four retention sweeps `apps/server/src/tasks.ts` runs delete in bounded batches against a supporting index, and count rows without dragging every deleted id back into the process, so a sweep that falls behind still finishes instead of aborting on the statement timeout and never pruning again.

**Architecture:** Four sweeps each issue one unbounded `DELETE`, and each asks for `.returning({ id })` only so it can read `.length`. Every pooled connection carries `statement_timeout` (`packages/db/src/index.ts:37`), so the danger is not an unbounded lock hold — it is that one oversized `DELETE` is cancelled at the budget, `tasks.ts` has no error handling, the process dies, and the table is never pruned again. Two of the four filter columns are already indexed; `job.updated_at` and better-auth's `rate_limit.last_request` are not. The fix is a shared `deleteInBatches` helper that pages by primary key with a hard ceiling and counts with the driver's `rowCount`, plus one generated migration adding the two missing indexes.

**Tech Stack:** Bun, Drizzle ORM 0.45.2 (`node-postgres` driver), drizzle-kit 0.31.10, pg 8.22 / `@types/pg` 8.21, PostgreSQL 18, better-auth 1.6.25, bun:test.

> **Implementation note (executed on main at `9fdb492`):** this plan's migration was written when `0004_ai_usage.sql` was head. Since then plans 013 and 025 landed `0006_idempotency_organization.sql` and `0007_webhook_event.sql`, so the generated migration is **`0008_sweep_indexes.sql`** — same two `CREATE INDEX` statements, next ordinal. The plan text below still says `0005`; read every `0005_sweep_indexes` mention as `0008_sweep_indexes`. All other drift vs. the audited commit: plan **024** renamed the partial dedupe index to `job_dedupeKey_unsettled_idx` and widened its predicate to `status in ('pending','running')`, in `d84471a` with migration `0005_dedupe_unsettled_window.sql` — consult plan 024, not 017, about that index (the plan's evidence below quotes the old `job_dedupeKey_pending_idx`), and plan 011/016 moved `sweepSettledJobs` to `apps/server/src/lib/jobs.repository.ts:248-256` with `markUnsettled`/`reclaimStrandedJobs` added above and below it; plan 025 added the `reclaimStrandedJobs` call and its `STRANDED_JOB_TIMEOUT_MS` block to `tasks.ts`. One more drift: the plan's Task-2 snippet keeps `async` on `sweepSettledJobs`, but Ultracite's `useAwait` rule rejects an `async` function that only returns another promise, so the landed version is `export function sweepSettledJobs(olderThan: Date): Promise<number>` — same signature, no modifier. One design deviation, forced by a proven planner hazard: the Task-2/3 helper snippet deletes with `where id in (select id … limit n for update skip locked)` in one statement, but that shape is **not a bound** — Postgres may re-execute the FOR UPDATE subquery once per candidate row (`loops=3005` observed under a large table), and `skip locked` then skips the statement's own earlier locks, so the LIMIT is per-rescan and a batch can delete the whole eligible set (empirically `rowCount=4` and `3` with `batchSize 2` in concurrent suite runs). The landed helper instead runs each batch as two statements: a standalone `select … limit n for update skip locked` (its limit is enforced — no join to re-execute it), then `delete … where id in (<the n ids>)`. Same bound, same `rowCount` counting, same ceiling semantics; one extra round trip per batch. The plan's `noAwaitInLoops` suppression moved from the delete to the select (the select's await is the one the rule flags).

---

## Verified evidence (do not re-litigate)

**Rating: a latent scaling papercut, not a live defect.** At starter scale with cron running as `tasks.ts` documents, every sweep deletes a handful of rows and returns in milliseconds. Nothing here is on fire. What is worth fixing is that the failure mode, when it does arrive, is silent and self-reinforcing.

**1. The pattern is real, in four places, not three.** Each deletes without a bound and each asks the database to return every deleted key just to count it:

- `apps/server/src/lib/jobs.repository.ts:187-195` — `sweepSettledJobs`:

  ```ts
  const removed = await db
  	.delete(job)
  	.where(
  		and(inArray(job.status, ["done", "failed"]), lt(job.updatedAt, olderThan))
  	)
  	.returning({ id: job.id });
  return removed.length;
  ```

- `apps/server/src/tasks.ts:59-62` — the better-auth counter sweep, written inline in the script:

  ```ts
  const staleCounters = await db
  	.delete(rateLimit)
  	.where(lt(rateLimit.lastRequest, Date.now() - RATE_LIMIT_RETENTION_MS))
  	.returning({ id: rateLimit.id });
  ```

- `apps/server/src/lib/idempotency.repository.ts:57-65` — `sweepExpiredKeys`, `.returning({ id: idempotencyKey.id })`.
- `apps/server/src/lib/rate-limit.repository.ts:88-95` — `sweepIdleBuckets`, `.returning({ key: apiRateLimit.key })`. The audit lists three; this is the fourth, identical in shape. It is included here because the fix is one shared helper and leaving one call site on the old pattern would make the helper look optional.

**2. Correction — the audit's impact statement is wrong.** It claims "row locks held for the whole statement, potentially millions of rows in one transaction". That cannot happen the way it is described. Every connection in the pool is opened with a server-side budget:

```ts
// packages/db/src/index.ts:37
statement_timeout: env.STATEMENT_TIMEOUT_MS,
```

`STATEMENT_TIMEOUT_MS` is a required key with no default (`packages/env/src/server.ts:145`), and it is set everywhere the code runs: `.env.example:107`, `.env.test:44` and `docker-compose.prod.yml:57` all carry `15000`. An oversized sweep is therefore cancelled by Postgres at 15 s with `57014 canceling statement due to statement timeout`, and the transaction rolls back releasing its locks. Do not go looking for a lock storm; there isn't one.

The real failure mode is quieter and worse:

- `tasks.ts` is a top-level-await script with no `try`/`catch` anywhere (read lines 51-81). A cancelled sweep rejects, the process dies on the unhandled rejection, and `closePool()` at line 81 never runs.
- The sweeps run in sequence: `sweepExpiredKeys` (line 51), auth counters (59), `sweepIdleBuckets` (64), `sweepSettledJobs` (68). The settled-job sweep is **last**, so any earlier failure takes it with it — and that is the sweep whose comment at `tasks.ts:44-47` explains why it matters: "a `mail.send` payload holds the rendered message, so a verification or reset row is a live one-time link at rest."
- Nothing retries and nothing shrinks the work. The next cron run faces a larger table, times out sooner, and the table is never pruned again. That ratchet — abort, grow, abort sooner — is the bug.

There is a second, smaller cost that is exactly as the audit describes it: `.returning({ id })` makes node-postgres materialise one JavaScript object per deleted row so that `.length` can be read. A million-row sweep allocates a million objects to produce the number `1000000`.

**3. Correction — the missing-index complaint is narrower than claimed.** Two of the four filter columns are already indexed, verified in both the schema and the migration that created them:

- `packages/db/src/schema/idempotency.ts:47` — `index("idempotency_key_expiresAt_idx").on(table.expiresAt)`, created in `packages/db/src/migrations/0000_initial.sql:88`.
- `packages/db/src/schema/rate-limit.ts:41` — `index("api_rate_limit_updatedAt_idx").on(table.updatedAt)`, created in `packages/db/src/migrations/0003_api_rate_limit.sql`. Its comment already names this sweep as the reason it exists.

Genuinely unindexed for the column their sweep filters on:

- **`job.updated_at`.** `packages/db/src/schema/job.ts:54-82` defines exactly three extras: `index("job_status_runAt_idx").on(table.status, table.runAt)` (line 58), the partial `uniqueIndex("job_dedupeKey_pending_idx")` (lines 71-73), and the `job_status_check` constraint (lines 78-81). Nothing covers `updated_at`.
- **`rate_limit.last_request`.** `packages/db/src/schema/auth.ts:116-121` declares the table with no third argument at all, so it has only its primary key and the `rate_limit_key_unique` constraint (`packages/db/src/migrations/0000_initial.sql:17-23`).

**4. The better-auth table can safely take an index, and `packages/db/src/schema/auth.ts` is hand-written.** It is not generated: the header comment at lines 108-115 says the shape "mirrors `getAuthTables` in @better-auth/core", and three better-auth-owned tables in that same file already carry indexes this repository added — `session_userId_idx` (line 57), `account_userId_idx` (line 87), `verification_identifier_idx` (line 105). What better-auth's adapter maps is *fields*; it never inspects indexes. Adding an index is in-pattern and safe. Adding, renaming or retyping a **column** would not be.

**5. A comment in `tasks.ts` is false, and the truth strengthens the case for the index.** `tasks.ts:53-57` says "Better Auth owns these rows and never deletes them". At the pinned version it does delete them. In `better-auth@1.6.25`, `dist/api/rate-limiter/index.mjs` defines:

```js
const deleteExpiredRows = (now) => {
	const cutoff = now - Math.max(ctx.rateLimit.window, ...getDefaultSpecialRules().map((r) => r.window)) * 1e3;
	ctx.runInBackground(db.deleteMany({
		model,
		where: [{ field: "lastRequest", operator: "lt", value: cutoff }]
	}).then(() => void 0).catch((e) => ctx.logger.error("Error pruning rate limit rows", e)));
};
```

and calls it from `consume` whenever a counter's window has rolled over. `packages/auth/src/index.ts:263-278` configures `storage: "database"` with `window: 10`, so that cutoff is tens of seconds: better-auth prunes far more aggressively than the 24 h retention in `tasks.ts:22`. Two consequences. The `tasks.ts` sweep is a backstop, not the primary pruner — it stays, because better-auth only prunes as a side effect of live auth traffic, in a fire-and-forget background promise whose failures are only logged. And the missing index on `last_request` is the **highest-leverage** item in this plan: it is not only our nightly sweep that does a sequential scan over every counter ever created, it is a delete that better-auth issues from inside the auth request path.

**6. `rowCount` is what the driver actually exposes.** Read from the installed packages, not from memory. In `drizzle-orm/pg-core/query-builders/delete.d.ts`, a delete with no `.returning()` resolves to `PgQueryResultKind<TQueryResult, never>`; for this driver `NodePgQueryResultHKT` is `pg.QueryResult` (`drizzle-orm/node-postgres/session.d.ts`), and `drizzle-orm/node-postgres/session.js` returns `await client.query(rawQuery, params)` verbatim when no fields are selected. `@types/pg@8.21.0/index.d.ts:92` types `rowCount: number | null` — null for commands that report no count, never for `DELETE`.

**7. A query builder passed to `inArray` is inlined as a parenthesised subquery.** `inArray` calls `bindIfParam` (`drizzle-orm/sql/expressions/conditions.js:14-19`), which returns any `SQLWrapper` untouched, and the SQL builder wraps a nested wrapper in `(` … `)` (`drizzle-orm/sql/sql.js:177-186`). So `inArray(job.id, db.select({ id: job.id }).from(job).where(...).limit(1000))` renders `"job"."id" in (select ... limit $n)`. `.for("update", { skipLocked: true })` is a real method on the select builder (`drizzle-orm/pg-core/query-builders/select.types.d.ts:61-74`), matching the `for update skip locked` already used by `claim` at `apps/server/src/lib/jobs.repository.ts:76-98`.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, 16 architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`; comment lines do not count).
- **No environment variable gets a default.** This plan adds no environment key at all. The batch size and the batch ceiling are module constants, not configuration.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts`; `tools/check-naming.ts` enforces it. `apps/server/src/lib/sweep.test.ts` beside `apps/server/src/lib/sweep.ts` satisfies it.
- Tests live beside the code, never in `__tests__`. Integration suites gate on `testDbReady()` from `apps/server/test-db.ts` and announce the skip. Never mock Drizzle.
- Layer direction is one-way: `routes → handlers → service → repository → @keel/db`. `apps/server/src/lib/sweep.ts` sits at repository depth — it may import `@keel/db` and `drizzle-orm`, exactly as `apps/server/src/lib/health.ts:1-3` already does. The Biome bans on those imports are scoped to `apps/server/src/modules/*/*.service.ts` (`biome.jsonc:219-238`) and to `*.routes.ts` / `*.handlers.ts` (`biome.jsonc:267-287`); neither glob matches this file.
- The `biome-ignore lint/performance/noAwaitInLoops` this plan adds is an **inline** suppression with a stated reason, the same shape as `apps/server/src/worker.ts:143` and `apps/server/src/lib/jobs.ts:51`. It is not a new config exemption, so it needs no fixture in `tools/check-rules.ts`.

## Do not

- **Do not hand-write the migration SQL.** `tools/check-migrations.ts` re-runs `drizzle-kit generate` and fails if anything new appears, so a hand-written file that does not match what the schema generates fails the gate. Change the schema, then generate.
- **Do not "improve" the generated SQL with `CREATE INDEX CONCURRENTLY`.** drizzle-kit does not emit it, `check-migrations` would flag the edit as drift, and `CONCURRENTLY` cannot run inside the transaction the migrator uses. On starter-sized tables the plain `CREATE INDEX` takes milliseconds.
- **Do not make the job index partial** — `index("job_settled_updatedAt_idx").on(table.updatedAt).where(sql\`status in ('done','failed')\`)` is the tempting version and it would sit unused. The sweep binds the status list as parameters (`status in ($1, $2)`), and Postgres cannot prove a parameterised list implies a literal partial predicate, so the planner would not match the index. The composite `(status, updated_at)` works with the parameterised `ScalarArrayOp` and with the range on `updated_at` behind it.
- **Do not wrap the batch loop in a transaction.** One transaction around every batch reconstructs the single long-running statement this plan exists to break up, and re-arms the statement timeout against the whole run.
- **Do not keep `.returning()` "to be safe" and count the array.** That allocation is half the finding. `rowCount` is the count Postgres already sends in the command tag.
- **Do not delete the auth-counter sweep in `tasks.ts` on the grounds that better-auth prunes.** Evidence item 5: better-auth prunes only as a side effect of live traffic, in a background promise whose rejection is merely logged. The sweep is the backstop for the deployment that stops taking auth traffic with rows already behind.
- **Do not touch any column of `rate_limit`.** better-auth owns that shape. An index is invisible to its adapter; a column is not.
- **Do not add a `sweepSettledJobs` test here.** Plan 016 (TEST-04/TEST-05) owns the first behavioural test of that function. This plan tests the batching helper, which 016 does not.

## Relationship to other plans

- **016 (TEST-04/05)** adds the first `sweepSettledJobs` test and extracts the worker loop. This plan does not test `sweepSettledJobs`; it tests `deleteInBatches`. No ordering dependency in either direction, but if 016 has already landed, re-read `apps/server/src/lib/jobs.test.ts` before assuming a line number.
- **011 (CORR-01)** adds a reaper to `apps/server/src/lib/jobs.repository.ts`. Different function, same file — if 011 landed first, re-read the file and re-derive the `sweepSettledJobs` line numbers.
- **025 (DIR-03)** appends one retention constant, one sweep call and one count to `apps/server/src/tasks.ts`. This plan does not restructure that file: it keeps the same constants, the same one-`await`-per-sweep shape and the same single stdout line. The only change inside that line is `${staleCounters.length}` becoming `${staleCounters}`.
- **019** owns `docker-compose.prod.yml`'s `x-app-env` key list. This plan adds no key, so it does not touch that file.

## File structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema/job.ts` | **Modify.** Add the composite index the settled-job sweep filters on. |
| `packages/db/src/schema/auth.ts` | **Modify.** Add an index on better-auth's `rate_limit.last_request`. No column changes. |
| `packages/db/src/migrations/0005_sweep_indexes.sql` | **Create — by generator, never by hand.** The two `CREATE INDEX` statements. |
| `packages/db/src/migrations/meta/` | **Modify — by generator.** Journal entry and snapshot for `0005`. |
| `apps/server/src/lib/sweep.ts` | **Create.** `deleteInBatches`: bounded, primary-key-paged delete that counts with `rowCount` and stops at a ceiling. |
| `apps/server/src/lib/sweep.test.ts` | **Create.** Multi-batch removal, predicate respected, ceiling behaviour, missing-predicate guard. |
| `apps/server/src/lib/jobs.repository.ts:187-195` | **Modify.** `sweepSettledJobs` delegates to the helper. |
| `apps/server/src/lib/idempotency.repository.ts:57-65` | **Modify.** `sweepExpiredKeys` delegates to the helper. |
| `apps/server/src/lib/rate-limit.repository.ts:88-95` | **Modify.** `sweepIdleBuckets` delegates to the helper. |
| `apps/server/src/tasks.ts:1,53-62,72-74` | **Modify.** Inline delete becomes a helper call; the false better-auth comment is corrected; the stdout line reads a number. |

---

### Task 1: The two missing indexes

Highest leverage in this plan, and the smallest diff. Batching without an index still rescans the table from the front on every batch; the index is what makes each batch cheap.

**Files:**
- Modify: `packages/db/src/schema/job.ts:54-58`
- Modify: `packages/db/src/schema/auth.ts:116-121`
- Create (generated): `packages/db/src/migrations/0005_sweep_indexes.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: the indexes `job_status_updatedAt_idx` on `job (status, updated_at)` and `rate_limit_lastRequest_idx` on `rate_limit (last_request)`. Tasks 2 and 3 depend on them only for performance, not for correctness.

- [x] **Step 1: Start the test database and record what indexes exist today**

```bash
bun run db:test:start && bun run db:test:migrate
docker exec keel-postgres-test psql -U postgres -d keel_test -c "select tablename, indexname from pg_indexes where tablename in ('job', 'rate_limit') order by tablename, indexname;"
```

Expected, before any change — five rows: `job_dedupeKey_pending_idx`, `job_pkey`, `job_status_runAt_idx`, `rate_limit_key_unique`, `rate_limit_pkey`. Nothing covering `job.updated_at` or `rate_limit.last_request`.

- [x] **Step 2: Watch the planner fail to narrow on the filter column**

```bash
docker exec keel-postgres-test psql -U postgres -d keel_test -c "set enable_seqscan = off; explain (costs off) delete from job where status in ('done','failed') and updated_at < now() - interval '3 days';"
docker exec keel-postgres-test psql -U postgres -d keel_test -c "set enable_seqscan = off; explain (costs off) delete from rate_limit where last_request < 1000;"
```

`enable_seqscan = off` is what makes this meaningful on an empty table: it asks the planner to use an index if any index *can* serve the predicate, instead of picking a sequential scan because the table is tiny.

Expected for `job`: either `Seq Scan on job` or `Index Scan using job_status_runAt_idx` — and in the second case `updated_at` appears under `Filter:`, never under `Index Cond:`. Either way the date is checked row by row after the fact.
Expected for `rate_limit`: `Seq Scan on rate_limit` with `Filter: (last_request < 1000)`. Neither the primary key nor the unique key on `key` can serve this predicate.

- [x] **Step 3: Add the job index to the schema**

In `packages/db/src/schema/job.ts`, insert this into the extras array immediately after `index("job_status_runAt_idx")…` at line 58, before the `uniqueIndex` comment block:

```ts
		// The retention sweep's exact shape: `status in ('done','failed') AND
		// updated_at < cutoff`. Without it the sweep scans every job the system
		// has ever run — which is precisely the population it exists to stop
		// growing, so the scan gets more expensive exactly as the sweep gets
		// more necessary.
		//
		// Composite rather than a partial index on `updated_at`, because the
		// sweep binds its status list as parameters (`status in ($1, $2)`) and
		// Postgres cannot prove a parameterised list implies a literal partial
		// predicate. A partial index would be created, look correct, and never
		// be chosen.
		index("job_status_updatedAt_idx").on(table.status, table.updatedAt),
```

`index` is already imported at line 4. No other change to this file.

- [x] **Step 4: Add the rate-limit index to the schema**

In `packages/db/src/schema/auth.ts`, replace the table declaration at lines 116-121 — the one-argument `pgTable` becomes the three-argument form:

```ts
export const rateLimit = pgTable(
	"rate_limit",
	{
		count: integer("count").notNull(),
		id: text("id").primaryKey(),
		key: text("key").notNull().unique(),
		lastRequest: bigint("last_request", { mode: "number" }).notNull(),
	},
	(table) => [
		// Two pruners filter on this column and nothing else: the retention sweep
		// in apps/server/src/tasks.ts, and Better Auth's own `deleteExpiredRows`,
		// which it fires in the background of any request whose window has just
		// rolled over. Unindexed, that second one is a sequential scan over every
		// counter ever created, charged to the auth request path.
		//
		// Indexing a table this application does not own is safe and already the
		// practice here — see session_userId_idx and account_userId_idx above.
		// The adapter maps fields; it never looks at indexes. Columns are the
		// part that must keep mirroring `getAuthTables`.
		index("rate_limit_lastRequest_idx").on(table.lastRequest),
	]
);
```

Leave the doc comment at lines 108-115 as it is: "Better Auth prunes expired rows itself" is true at 1.6.25. `index`, `integer`, `text` and `bigint` are all already imported at lines 2-10.

- [x] **Step 5: Generate the migration**

```bash
cd packages/db && bun run db:generate --name sweep_indexes
```

Run it from `packages/db`, which is where `drizzle.config.ts` lives and how `tools/check-migrations.ts` invokes drizzle-kit. `--name` is what stops drizzle-kit inventing a random two-word tag.

Expected: `packages/db/src/migrations/0005_sweep_indexes.sql` is created, `meta/_journal.json` gains an entry with `"tag": "0005_sweep_indexes"`, and `meta/0005_snapshot.json` appears.

- [x] **Step 6: Read the emitted SQL before trusting it**

```bash
cat packages/db/src/migrations/0005_sweep_indexes.sql
```

Expected — exactly two statements, one per index, joined by drizzle-kit's separator (the order of the two lines is not significant):

```sql
CREATE INDEX "job_status_updatedAt_idx" ON "job" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX "rate_limit_lastRequest_idx" ON "rate_limit" USING btree ("last_request");
```

If the file contains anything else — an `ALTER TABLE`, a dropped index, a column change — stop. Something other than these two indexes has drifted, and it does not belong in this commit.

- [x] **Step 7: Apply it and prove the planner now narrows on the filter column**

```bash
bun run db:test:migrate
docker exec keel-postgres-test psql -U postgres -d keel_test -c "set enable_seqscan = off; explain (costs off) delete from job where status in ('done','failed') and updated_at < now() - interval '3 days';"
docker exec keel-postgres-test psql -U postgres -d keel_test -c "set enable_seqscan = off; explain (costs off) delete from rate_limit where last_request < 1000;"
```

Expected for `job`: the plan names `job_status_updatedAt_idx` (as an `Index Scan` or a `Bitmap Index Scan`) and `updated_at` now appears in the `Index Cond`, not in a `Filter`.
Expected for `rate_limit`: the plan names `rate_limit_lastRequest_idx` with `Index Cond: (last_request < 1000)`.

That transition — `updated_at` and `last_request` moving out of `Filter` and into `Index Cond` — is this task's acceptance criterion.

- [x] **Step 8: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful; `check-migrations: 6 migration(s), schema matches.`

- [x] **Step 9: Commit**

```bash
git add packages/db/src/schema/job.ts packages/db/src/schema/auth.ts packages/db/src/migrations
git commit -m "perf(db): index the two columns the retention sweeps filter on

Four sweeps run from tasks.ts and two of them had no index behind their
filter. \`job.updated_at\` was uncovered — the table's only indexes are
(status, run_at) for the claim query and the partial dedupe unique — so
the settled-job sweep scanned every job the system had ever run, a scan
that grows exactly as fast as the sweep becomes necessary. Better Auth's
\`rate_limit.last_request\` was uncovered too, and that one is not only
ours: better-auth 1.6.25 fires its own \`delete from rate_limit where
last_request < cutoff\` in the background of any request whose window
rolled over, so the sequential scan was being charged to the auth request
path.

Composite (status, updated_at) rather than a partial index on updated_at:
the sweep binds its status list as parameters, and Postgres cannot prove
\`status in (\$1, \$2)\` implies a literal partial predicate, so a partial
index would have been created and never chosen.

Indexing a better-auth table is safe and already the practice here — the
adapter maps fields, never indexes, and session_userId_idx and
account_userId_idx predate this. No column of rate_limit was touched.

Verified against the test database with enable_seqscan off: before, the
date predicate sat under Filter for both tables; after, both plans name
the new index with the predicate in Index Cond."
```

---

### Task 2: `deleteInBatches`, and the first sweep to use it

**Files:**
- Create: `apps/server/src/lib/sweep.ts`
- Create: `apps/server/src/lib/sweep.test.ts`
- Modify: `apps/server/src/lib/jobs.repository.ts:1-3,187-195`

**Interfaces:**
- Consumes: Task 1's indexes (performance only).
- Produces: `export interface BatchedDelete { batchSize?: number; maxBatches?: number; primaryKey: PgColumn; table: PgTable; where: SQL | undefined }` and `export async function deleteInBatches(options: BatchedDelete): Promise<number>` from `apps/server/src/lib/sweep.ts`. Task 3 calls exactly this. `sweepSettledJobs(olderThan: Date): Promise<number>` keeps its signature unchanged.

- [x] **Step 1: Write the failing test**

Create `apps/server/src/lib/sweep.test.ts`:

```ts
import { beforeEach, describe, expect, it, spyOn } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { and, eq, lt } from "drizzle-orm";
import { deleteInBatches } from "@/lib/sweep";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("sweep"));
}

/**
 * `job` is the subject table because it is the one sweep target with no foreign
 * key: a row needs nothing seeded before it. The helper is table-agnostic, so
 * what is under test is the loop, not the queue.
 */
const KIND = "sweep.test";

/** Every seeded row sits either well before this or well after it. */
const CUTOFF = new Date(Date.now() - 60_000);
const OLD = new Date(Date.now() - 3_600_000);

/** The shape a real sweep passes, narrowed to this suite's rows. */
const eligible = and(eq(job.kind, KIND), lt(job.updatedAt, CUTOFF));

async function seed(count: number, updatedAt: Date): Promise<void> {
	await db.insert(job).values(
		Array.from({ length: count }, () => ({
			kind: KIND,
			payload: {},
			status: "done" as const,
			updatedAt,
		}))
	);
}

async function remaining(): Promise<number> {
	const rows = await db
		.select({ id: job.id })
		.from(job)
		.where(eq(job.kind, KIND));
	return rows.length;
}

/** Collects the ceiling notice instead of letting it bleed into test output. */
function captureStderr(): { restore: () => void; written: string[] } {
	const written: string[] = [];
	const spy = spyOn(process.stderr, "write").mockImplementation(((
		chunk: string
	) => {
		written.push(String(chunk));

		return true;
	}) as typeof process.stderr.write);

	return { restore: () => spy.mockRestore(), written };
}

describe.skipIf(!ready)("deleteInBatches", () => {
	// Same reason jobs.test.ts starts empty: the table is shared, and a row left
	// by another suite would be counted by this one.
	beforeEach(async () => {
		await db.delete(job);
	});

	// Five rows at a batch size of two is three statements: 2, 2, then 1. The
	// count has to survive being assembled from them.
	it("removes every eligible row across several batches and counts them all", async () => {
		await seed(5, OLD);

		const removed = await deleteInBatches({
			batchSize: 2,
			primaryKey: job.id,
			table: job,
			where: eligible,
		});

		expect(removed).toBe(5);
		expect(await remaining()).toBe(0);
	});

	// The predicate has to be re-applied by every batch, not just the first.
	it("leaves the rows the predicate excludes", async () => {
		await seed(3, OLD);
		await seed(2, new Date());

		const removed = await deleteInBatches({
			batchSize: 2,
			primaryKey: job.id,
			table: job,
			where: eligible,
		});

		expect(removed).toBe(3);
		expect(await remaining()).toBe(2);
	});

	it("stops at the batch ceiling, says so, and leaves the rest for the next run", async () => {
		await seed(5, OLD);
		const stderr = captureStderr();

		const first = await deleteInBatches({
			batchSize: 2,
			maxBatches: 1,
			primaryKey: job.id,
			table: job,
			where: eligible,
		});
		stderr.restore();

		const second = await deleteInBatches({
			batchSize: 2,
			primaryKey: job.id,
			table: job,
			where: eligible,
		});

		expect(first).toBe(2);
		expect(stderr.written.join("")).toContain("[sweep] job");
		expect(second).toBe(3);
		expect(await remaining()).toBe(0);
	});

	// `and()` is typed to return undefined, so an all-undefined predicate is one
	// typo away from an unfiltered delete of the whole table.
	it("refuses to run without a predicate", async () => {
		await seed(1, OLD);

		await expect(
			deleteInBatches({ primaryKey: job.id, table: job, where: undefined })
		).rejects.toThrow("no predicate");
		expect(await remaining()).toBe(1);
	});
});
```

- [x] **Step 2: Run it and watch it fail for the right reason**

```bash
cd apps/server && bun test src/lib/sweep.test.ts
```

Expected: the run aborts before any test executes, resolving the import — `error: Cannot find module '@/lib/sweep'`. If instead you see the skip notice `[skip] sweep needs the test database.`, the database from Task 1 is not up: `bun run db:test:start && bun run db:test:migrate` at the repository root, then re-run.

- [x] **Step 3: Write the helper**

Create `apps/server/src/lib/sweep.ts`:

```ts
import { db } from "@keel/db";
import { getTableName, inArray, type SQL } from "drizzle-orm";
import type { PgColumn, PgTable } from "drizzle-orm/pg-core";

/**
 * Bounded deletes for the retention sweeps `tasks.ts` runs.
 *
 * One unbounded `DELETE` is fine until it is not. Every pooled connection
 * carries `statement_timeout` (packages/db/src/index.ts), so a sweep that has
 * fallen far enough behind is cancelled by Postgres rather than finishing —
 * and `tasks.ts` has no error handling, so the process dies, the sweeps queued
 * behind it never run, and the table is never pruned again. The next run faces
 * a bigger table and fails sooner. Batching removes the failure mode at the
 * root: every statement is small, so no statement approaches the budget.
 */

/**
 * Rows per statement. Large enough that a routine sweep is one or two round
 * trips, small enough that a batch is milliseconds of work rather than
 * something the timeout has an opinion about.
 */
const BATCH_SIZE = 1000;

/**
 * Batches per call. The ceiling is what stops a cron run spinning: without it a
 * table being written faster than it is swept keeps the loop alive forever, and
 * the ten-minute cron tick would find the previous run still going. Hitting it
 * is not an error — the run deletes what it deleted, says so on stderr, and the
 * next tick continues where this one stopped.
 */
const MAX_BATCHES = 100;

export interface BatchedDelete {
	batchSize?: number;
	maxBatches?: number;
	/** The column to page on. Any unique column works; the primary key is cheapest. */
	primaryKey: PgColumn;
	table: PgTable;
	/**
	 * `SQL | undefined` because that is what `and()` and Drizzle's own `.where()`
	 * are typed to produce. Undefined is rejected at runtime rather than accepted
	 * as "match everything".
	 */
	where: SQL | undefined;
}

/**
 * Deletes every row matching `where`, `batchSize` rows at a time, and returns
 * how many went.
 *
 * `delete … where id in (select id … limit n for update skip locked)` rather
 * than `delete … limit n`, which Postgres does not have. `skip locked` matches
 * `claim` in jobs.repository: two overlapping cron runs then take disjoint
 * batches instead of one queueing behind the other's locks.
 *
 * The count comes from the driver's `rowCount`, which is the number Postgres
 * already puts in the command tag. The `.returning({ id })` this replaced made
 * node-postgres allocate one object per deleted row so that `.length` could be
 * read — a million objects to produce the number one million.
 */
export async function deleteInBatches({
	batchSize = BATCH_SIZE,
	maxBatches = MAX_BATCHES,
	primaryKey,
	table,
	where,
}: BatchedDelete): Promise<number> {
	if (!where) {
		throw new Error(
			`deleteInBatches was called for ${getTableName(table)} with no predicate. Pass the retention filter — an unfiltered sweep would delete the whole table.`
		);
	}

	let removed = 0;

	for (let batch = 0; batch < maxBatches; batch += 1) {
		const doomed = db
			.select({ id: primaryKey })
			.from(table)
			.where(where)
			.limit(batchSize)
			.for("update", { skipLocked: true });

		// biome-ignore lint/performance/noAwaitInLoops: the serialisation is the point — each statement has to commit before the next one picks its rows, and parallel batches would hold connections the request path draws from.
		const result = await db.delete(table).where(inArray(primaryKey, doomed));

		// `number | null` in @types/pg because some commands report no count.
		// DELETE always reports one; read it defensively rather than assert.
		const deleted = result.rowCount ?? 0;
		removed += deleted;

		// A short batch means the eligible set is exhausted, so this saves the
		// round trip that would return zero. A batch shortened by `skip locked`
		// instead means a concurrent run holds those rows and will delete them.
		if (deleted < batchSize) {
			return removed;
		}
	}

	process.stderr.write(
		`[sweep] ${getTableName(table)}: stopped after ${maxBatches} batches with rows still eligible. The next run continues where this one left off.\n`
	);

	return removed;
}
```

- [x] **Step 4: Run the test and watch it pass**

```bash
cd apps/server && bun test src/lib/sweep.test.ts
```

Expected: `4 pass, 0 fail`.

- [x] **Step 5: Point `sweepSettledJobs` at it**

In `apps/server/src/lib/jobs.repository.ts`, add the import after the `drizzle-orm` line at line 3:

```ts
import { deleteInBatches } from "@/lib/sweep";
```

Then replace the body at lines 187-195, keeping the doc comment at lines 172-186 exactly as it is:

```ts
export async function sweepSettledJobs(olderThan: Date): Promise<number> {
	return deleteInBatches({
		primaryKey: job.id,
		table: job,
		where: and(
			inArray(job.status, ["done", "failed"]),
			lt(job.updatedAt, olderThan)
		),
	});
}
```

`and`, `inArray` and `lt` stay imported — all three are still used here, and `eq` and `sql` are still used by `complete`, `fail` and `claim`.

- [x] **Step 6: Prove the queue still behaves**

```bash
cd apps/server && bun test src/lib/jobs.test.ts src/lib/jobs.ownership.test.ts src/lib/sweep.test.ts
```

Expected: every test passes, no skip notice.
> **Corrected.** This line originally read: "These suites share the `job` table and both truncate it in `beforeEach`, so a green run here is also the proof that the new suite does not tread on the existing ones." The premise was the defect. A `beforeEach` truncate is what plan 017 (TEST-01) exists to remove, and `sweep.test.ts` shipped with one, which is how this plan re-introduced the wipe 017 had just closed — so far from proving the suites do not tread on each other, the truncate was them treading on each other and on `packages/mail`'s queue suite. No suite truncates now: each deletes only rows it created (`sweep.test.ts` by its own per-run `kind`). That is what makes a green run here mean anything, and it means it whether or not the suites are run together.

- [x] **Step 7: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful, and `check-naming` reports one more suite than it did before this task.

- [x] **Step 8: Commit**

```bash
git add apps/server/src/lib/sweep.ts apps/server/src/lib/sweep.test.ts apps/server/src/lib/jobs.repository.ts
git commit -m "perf(server): sweep settled jobs in bounded batches

The sweep was one unbounded DELETE. Every pooled connection carries
statement_timeout, so the hazard was never a long lock hold — it was that
a sweep which had fallen far enough behind got cancelled at the budget,
and tasks.ts has no error handling, so the process died and the table was
never pruned again. Each subsequent run met a larger table and failed
sooner. Settled jobs are the worst table to lose that way: a mail.send
payload holds the rendered message, so an unpruned row is a live one-time
link at rest.

deleteInBatches pages by primary key with \`for update skip locked\`, the
same idiom \`claim\` uses, so overlapping cron runs take disjoint batches.
The loop has a ceiling — 100 batches — because a table written faster than
it is swept would otherwise keep one cron run alive indefinitely; hitting
it reports on stderr and leaves the remainder for the next run.

Counting now reads the driver's rowCount instead of \`.returning({ id })\`,
which was making node-postgres materialise one object per deleted row for
no purpose beyond \`.length\`.

The suite covers the loop rather than the queue: five rows at a batch size
of two are removed across three statements with the count intact, the
predicate is re-applied by every batch, the ceiling stops and the next
call finishes the work, and a missing predicate throws instead of
deleting the table."
```

---

### Task 3: The other three sweeps

**Files:**
- Modify: `apps/server/src/lib/idempotency.repository.ts:1-4,57-65`
- Modify: `apps/server/src/lib/rate-limit.repository.ts:1-3,88-95`
- Modify: `apps/server/src/tasks.ts:1,53-62,72-74`

**Interfaces:**
- Consumes: `deleteInBatches` from Task 2.
- Produces: no signature change. `sweepExpiredKeys(now?: Date): Promise<number>` and `sweepIdleBuckets(olderThan: Date): Promise<number>` keep returning a count; the inline delete in `tasks.ts` becomes a count instead of an array.

- [x] **Step 1: Run the suite that already guards one of these**

```bash
cd apps/server && bun test src/lib/idempotency.test.ts
```

Expected: green. `src/lib/idempotency.test.ts:177-204` ("sweeps only the rows past their expiry") asserts both the returned count and that a live row survives — that is the contract this task must not break, and it exists before the change. Note the returned count is what it checks, so it fails if `rowCount` and `.returning().length` ever disagree.

- [x] **Step 2: Convert `sweepExpiredKeys`**

In `apps/server/src/lib/idempotency.repository.ts`, add the import after the `drizzle-orm` line at line 4:

```ts
import { deleteInBatches } from "@/lib/sweep";
```

Replace lines 57-65, keeping the doc comment at lines 49-56:

```ts
export async function sweepExpiredKeys(
	now: Date = new Date()
): Promise<number> {
	return deleteInBatches({
		primaryKey: idempotencyKey.id,
		table: idempotencyKey,
		where: lt(idempotencyKey.expiresAt, now),
	});
}
```

`and` and `eq` remain in use by `findByActorAndKey` and `deleteById`; `lt` is still used here.

- [x] **Step 3: Convert `sweepIdleBuckets`**

In `apps/server/src/lib/rate-limit.repository.ts`, change the `drizzle-orm` import at line 3 and add the helper:

```ts
import { lt, sql } from "drizzle-orm";
import { deleteInBatches } from "@/lib/sweep";
```

`sql` stays — `consume` builds its upsert with it. Replace lines 88-95:

```ts
/** Drops buckets nobody has touched since `olderThan`. Called from `tasks.ts`. */
export async function sweepIdleBuckets(olderThan: Date): Promise<number> {
	return deleteInBatches({
		primaryKey: apiRateLimit.key,
		table: apiRateLimit,
		where: lt(apiRateLimit.updatedAt, olderThan),
	});
}
```

`apiRateLimit` has no `id` column — `key` is its primary key, which is exactly what `primaryKey` asks for.

- [x] **Step 4: Convert the inline sweep in `tasks.ts` and correct the comment above it**

Two edits in `apps/server/src/tasks.ts`. First, line 1 and the import block: `db` is about to become unused, so it must go or Biome's `noUnusedImports` fails the lint. Lines 1-6 become:

```ts
import { closePool } from "@keel/db";
import { rateLimit } from "@keel/db/schema/auth";
import { lt } from "drizzle-orm";
import { sweepExpiredKeys } from "@/lib/idempotency.repository";
import { sweepSettledJobs } from "@/lib/jobs.repository";
import { sweepIdleBuckets } from "@/lib/rate-limit";
import { deleteInBatches } from "@/lib/sweep";
```

Second, replace lines 53-62 — the comment as well as the statement, because the comment is false at the pinned version of better-auth:

```ts
/**
 * A backstop, not the only pruner. Better Auth does delete these rows: its
 * database rate-limit storage fires `deleteExpiredRows` in the background of any
 * request whose window has just rolled over, with a cutoff of its largest
 * configured window — tens of seconds, far tighter than the day kept here.
 *
 * It is still worth sweeping, because that prune only happens as a side effect
 * of live auth traffic and its failures are only logged. A deployment that goes
 * quiet, or one whose background delete lost a race with a restart, keeps
 * whatever was already behind. Dropping a stale counter is safe either way: a
 * missing row starts a fresh window, which is what an expired counter means.
 */
const staleCounters = await deleteInBatches({
	primaryKey: rateLimit.id,
	table: rateLimit,
	where: lt(rateLimit.lastRequest, Date.now() - RATE_LIMIT_RETENTION_MS),
});
```

- [x] **Step 5: Read the count instead of an array length**

In the summary at `apps/server/src/tasks.ts:72-74`, `staleCounters` is now a number. One token changes:

```ts
process.stdout.write(
	`[tasks] swept ${expiredKeys} idempotency key(s), ${staleCounters} auth rate-limit counter(s), ${idleBuckets} idle token bucket(s), ${settledJobs} settled job(s)\n`
);
```

- [x] **Step 6: Run the sweeps for real against the test database**

`tasks.ts` is a script with no suite, so exercise it directly. From the repository root:

```bash
cd apps/server && DATABASE_URL=$(bun ../../tools/test-database-url.ts) bun src/tasks.ts
```

Expected: one line, four counts, and a clean exit — for example `[tasks] swept 0 idempotency key(s), 0 auth rate-limit counter(s), 0 idle token bucket(s), 0 settled job(s)`. Zeroes are the correct answer against a freshly migrated database; what is being proven is that all four sweeps run, that the summary interpolates numbers rather than `[object Object]` or `undefined`, and that the process exits instead of hanging (`closePool()` at the end still runs).

The inline `DATABASE_URL` is what keeps this off the development database. Bun loads `apps/server/.env` automatically, but a variable already present in the shell environment wins over a `.env` entry — verified with a probe `.env` before this plan was written — so the assignment on the command line is the one the script sees. Confirm it anyway before running: the URL printed by `bun tools/test-database-url.ts` must end in `/keel_test`.

- [x] **Step 7: Prove the suites that cover these paths still pass**

```bash
cd apps/server && bun test src/lib/idempotency.test.ts src/lib/rate-limit.test.ts src/lib/sweep.test.ts
```

Expected: green. The idempotency suite is the direct regression guard from Step 1 — it asserts the same count contract, now produced by `rowCount` across batches.

- [x] **Step 8: Prove the whole gate is green**

```bash
bun run check
```

- [x] **Step 9: Commit**

```bash
git add apps/server/src/lib/idempotency.repository.ts apps/server/src/lib/rate-limit.repository.ts apps/server/src/tasks.ts
git commit -m "perf(server): the remaining three sweeps batch and count the same way

sweepExpiredKeys, sweepIdleBuckets and the inline auth-counter delete in
tasks.ts all had the shape sweepSettledJobs had: one unbounded DELETE,
with .returning() asked for only so that .length could be read. Two of
the three already had an index behind their filter, so their exposure was
smaller, but the abort-and-never-prune failure and the per-row allocation
were identical. They now go through deleteInBatches.

The comment above the auth-counter sweep said Better Auth never deletes
these rows. It does: better-auth 1.6.25 fires deleteExpiredRows in the
background of any request whose window has rolled over, with a cutoff of
its largest configured window. The sweep stays because that prune needs
live traffic and swallows its own failures, but the comment now says why
it is a backstop rather than claiming a fact that stopped being true.

tasks.ts no longer imports db — the last direct query in it moved behind
the helper — and the summary line reads a count instead of an array
length.

Verified by running src/tasks.ts against the test database: all four
sweeps execute, the summary prints four numbers, and the process exits.
The idempotency suite, which asserts both the returned count and that
unexpired rows survive, passes unchanged."
```

---

## Done when

- `packages/db/src/migrations/0005_sweep_indexes.sql` exists, was produced by `drizzle-kit generate`, and contains exactly two `CREATE INDEX` statements.
- Against the test database with `enable_seqscan = off`, the plan for the settled-job delete names `job_status_updatedAt_idx` with `updated_at` in the `Index Cond`, and the plan for a `rate_limit` delete names `rate_limit_lastRequest_idx` with `last_request` in the `Index Cond`.
- No sweep in the repository calls `.returning()`: `grep -rn "returning" apps/server/src/lib/*.repository.ts apps/server/src/tasks.ts` shows no match in a sweep function.
- `deleteInBatches` deletes a five-row eligible set at a batch size of two, returns 5, and leaves rows the predicate excludes untouched.
- With `maxBatches: 1`, `deleteInBatches` returns only what that one batch removed, writes a `[sweep] <table>:` line to stderr, and a second call finishes the remainder.
- `deleteInBatches` throws, deleting nothing, when `where` is `undefined`.
- `cd apps/server && DATABASE_URL=$(bun ../../tools/test-database-url.ts) bun src/tasks.ts` prints one `[tasks] swept …` line with four numeric counts and exits.
- `bun run check` is green.

## Out of scope

- **A behavioural test for `sweepSettledJobs` itself.** Plan 016 (TEST-04/TEST-05) owns it. This plan's suite covers the batching loop, which 016 does not.
- **A behavioural test for `sweepIdleBuckets`.** It has none today and gains none here: the function is now a four-line delegation to a tested helper, and `apps/server/src/lib/rate-limit.test.ts` is being edited by another plan in this batch. Adding coverage for the bucket sweep belongs with the rate-limit test work, not here.
- **Error isolation in `tasks.ts` — declared out of scope here, then shipped here anyway.** This item read: "One failing sweep still aborts the run before the sweeps queued behind it … making the script survive an arbitrary sweep failure — a `try`/`catch` per sweep and a non-zero exit that still reports what did run — is a separate change with its own acceptance test." It did not stay separate. Commit `7b7b100`, one of this plan's own execution commits, shipped precisely that: `guardedSweep` wraps each sweep, reports a failure on stderr, substitutes a zero count, lets the rest of the run continue, still prints the one summary line, and sets `process.exitCode = 1` through `failedSweeps`. Keeping it out was not really available — batching is what makes the omission load-bearing. A bounded sweep leaves work behind by design, so a run that dies on the first failure stops pruning the three tables queued behind it and the next run faces more rows, which is the same self-reinforcing ratchet this plan exists to break, moved one level up. What `7b7b100` genuinely did not ship is the acceptance test this item promised, so the isolation stood unproven. That is closed in follow-up work rather than still owed: `guardedSweep` is generalised so every maintenance statement in the script — the four sweeps and `reclaimStrandedJobs` — runs inside it, none bare, and `apps/server/src/tasks.test.ts` spawns the script against an unreachable database so every step rejects, then asserts one failure line per step (which is what proves the later steps still ran), the summary line, and a non-zero exit.
- **`docker-compose.prod.yml` and `.env.example`.** No environment key is added; `BATCH_SIZE` and `MAX_BATCHES` are module constants. Plan 019 owns the `x-app-env` list if a later plan does need a key.
- **`CREATE INDEX CONCURRENTLY` and a zero-downtime index build.** drizzle-kit does not emit it and it cannot run inside the migrator's transaction. For a starter's table sizes the plain build is milliseconds; a deployment that has grown past that is choosing its own migration tooling by then.
- **Retention windows.** `RATE_LIMIT_RETENTION_MS`, `IDLE_BUCKET_RETENTION_MS` and `SETTLED_JOB_RETENTION_MS` (`apps/server/src/tasks.ts:22-49`) are unchanged. This plan changes how rows are deleted, never which rows are eligible.
