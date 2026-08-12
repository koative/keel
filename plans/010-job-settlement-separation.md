# Job Settlement Separation Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** CORR-02 (`plans/audit-report.md:119-124`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Ordering:** this is the first of three queue plans, and they are strictly ordered.

| Plan | Finding | Owns | Depends on |
|---|---|---|---|
| **010 — this one** | CORR-02 | settlement in `apps/server/src/lib/jobs.ts` and the two settling statements in `apps/server/src/lib/jobs.repository.ts` | nothing |
| 011 | CORR-01 | the stuck-job reaper in `apps/server/src/lib/jobs.repository.ts` and `apps/server/src/tasks.ts` | **010** — it consumes the contract in [Contract for plan 011](#contract-for-plan-011) below |
| 016 | TEST-04, TEST-05 | extracting the worker poll loop for testability | 010 and 011 |

Do not re-specify a neighbour's change. If you are reading this while implementing 011 or 016, the only part of this document you may rely on is [Contract for plan 011](#contract-for-plan-011).

**Goal:** Stop the queue from recording "we could not write down that the work finished" as "the work failed", so a settlement hiccup can no longer spend an attempt, overwrite a handler's diagnosis, or re-arm a job whose side effect already happened.

**Architecture:** `apps/server/src/lib/jobs.ts:78-87` runs the handler and settles the row inside one `try`, and the shared `catch` calls `fail`. `fail` (`apps/server/src/lib/jobs.repository.ts:143-170`) increments `attempts`, writes `last_error`, re-arms the row `pending` and reschedules it on the backoff ladder — which is the right answer to a handler that threw and the wrong answer to a `complete` that could not reach the database. The fix moves settlement out of that `try` and gives it its own error path: `complete` (`jobs.repository.ts:122-129`) starts reporting whether it was the call that settled the row, `runJob` retries it a bounded number of times, and a settlement that still will not land leaves the row `running` under a new `markUnsettled` note that touches none of the columns that decide whether the job runs again. Releasing that row is plan 011's reaper, and the contract it must honour is stated below.

**Tech Stack:** Bun, bun:test, Drizzle ORM (`drizzle-orm/pg-core`), PostgreSQL 17, Hono is not involved.

---

## Verified evidence (do not re-litigate)

The finding is **CONFIRMED, but narrower than the audit states**, and the narrowing changes what the fix has to achieve. Reproduce this framing; do not reproduce the audit's impact sentence.

### 1. The structure the audit describes is real

`apps/server/src/lib/jobs.ts:78-87`, quoted verbatim:

```ts
	try {
		await handler(entry.payload, entry.id);
		await complete(entry.id, workerId);
	} catch (error) {
		// A handler is arbitrary application code and is expected to throw
		// sometimes. Unhandled, the rejection would kill the worker process and
		// leave every job it had claimed stuck in `running` with nothing left
		// alive to release them.
		await fail(entry.id, workerId, error);
	}
```

`fail` at `jobs.repository.ts:143-170` does exactly what the audit says: `attempts = attempts + 1`, `last_error = <message>`, `run_at = now() + <backoff>`, `status = case when attempts + 1 >= max_attempts then 'failed' else 'pending' end`.

### 2. Narrowing — the dropped-ack case is already harmless

`fail` is fenced (`jobs.repository.ts:166-168`):

```sql
		where ${job.id} = ${id}
			and ${job.lockedBy} = ${workerId}
			and ${job.status} = 'running'
```

So if the settling UPDATE **did** commit and the throw arrived afterwards — a lost acknowledgement, a socket dropped between commit and reply — the row is already `done`, `locked_by` is already null, and `fail` matches zero rows. That path is a no-op today. `apps/server/src/lib/jobs.ownership.test.ts:78-88` already pins it ("refuses to resurrect a job that has already finished"). Re-execution only happens in the other case: `complete` genuinely did not commit.

### 3. Narrowing — today's blast radius for double execution is zero

Both shipped handlers are already idempotent:

- `apps/server/src/worker.ts:58-63` passes the job id as Resend's idempotency key, which lands at `packages/mail/src/send.ts:79` as `"Idempotency-Key": idempotencyKey`. The audit credits this one.
- `apps/server/src/worker.ts:86-88` early-returns on a ledger row the previous attempt wrote:

  ```ts
	if (await hasUsageForJob(jobId)) {
		return;
	}
  ```

  The audit **missed** this and claims "every future handler inherits the hazard" as though `ai.generate` were exposed. It is not. Do not go looking for a live double-billing hazard in this repo; there is not one.

### 4. What actually remains, and what the plan leads with

Two things, neither of which is "mail gets sent twice":

- **A settlement failure is recorded as a work failure.** It spends one of five attempts on something the handler did not do, and it overwrites `last_error` with a pool error. Repeated transient hiccups can walk an already-completed job all the way to `failed` while its side effect stands. `last_error` then says the job failed for a reason that has nothing to do with the job.
- **Every future handler inherits the hazard the two shipped ones happen to be immune to.** `mail.send` and `ai.generate` are immune by their own effort, not by anything the queue guarantees. The third handler someone adds gets no such protection from the runner.

### 5. What no test can do, and why that shapes the test plan

`complete` is a single fenced UPDATE against a `text` primary key (`packages/db/src/schema/job.ts:38-40`), setting a value the `job_status_check` constraint (`job.ts:78-81`) already permits. There is no input a test can hand it that makes PostgreSQL raise: a non-existent id, a wrong worker, a settled row — all match zero rows and return cleanly. The only way `complete` throws is infrastructural, and the repo forbids mocking Drizzle.

So the throw path is covered by construction and by review, and the tests drive the outcome that **is** reachable with real input: the fenced UPDATE matching zero rows, produced by a handler that takes its own row's lock away mid-flight. That is an ordinary `update job set locked_by = …` against the test database — no mock, no fake, no Drizzle double.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, 16 architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`, `biome.jsonc:68-73`; comment lines and the interior of a multi-line template literal do not count, blank lines do). Current budgets: `jobs.repository.ts` 115 code lines, `jobs.ts` 52, `jobs.test.ts` 171. **`jobs.test.ts` has almost no room left — this plan adds no test to it.**
- **No environment variable gets a default.** The retry count and the retry delay in this plan are module constants, not env keys: they are a property of how a fenced UPDATE behaves, not a deployment decision, and a new key would mean touching `.env.example`, `apps/server/.env`, `.env.test` and `docker-compose.prod.yml` for a number nobody will ever tune.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts`; `tools/check-naming.ts` enforces it. `jobs.settlement.test.ts` beside `jobs.ts` follows the `jobs.ownership.test.ts` precedent exactly.
- Tests live beside the code, never in `__tests__`. This suite is an integration suite: it gates on `testDbReady()` from `apps/server/test-db.ts` and announces the skip. **Never mock Drizzle.**
- `apps/server/src/lib/**` may import its own siblings and `@keel/db` freely (`biome.jsonc:307-337` only forbids reaching into `@/modules/*/*`). No new exemption is needed, so `tools/check-rules.ts` is not touched.
- The queue's public face is `@/lib/jobs`; `@/lib/jobs.repository` is private to that pair and modules are blocked from importing it (`biome.jsonc:241-242`). Nothing this plan adds is exported beyond that boundary.

## Do not

- **Do not call `fail` from the settlement path, in any form.** That is the bug. `fail` means "an attempt was spent and produced nothing", and a settlement failure spent no attempt — the handler succeeded. Calling it also re-arms `run_at`, which is a request to run the side effect again.
- **Do not add a `settling` (or `completing`) state to `JOB_STATUSES`.** It is the obvious design and it does not work: the only process that could write the marker is the worker whose writes are the thing that just failed. A state you cannot reach precisely when you need it is worse than no state, and it costs a migration plus a new case in the `job_status_check` constraint, the claim index and every reader of `status`.
- **Do not make the retry unbounded, and do not make it an env key.** A worker that cannot reach Postgres after three tries will not be talked round by a thirtieth, and each extra try holds the single worker slot open while the queue drains nowhere. `WORKER_POLL_MS` and `WORKER_BATCH_SIZE` are deployment decisions; this is not.
- **Do not weaken `complete`'s or `markUnsettled`'s fence to make the throw path testable.** The `locked_by = workerId` clause is what stops a slow worker from settling a job something else has reclaimed (`jobs.repository.ts:116-120` says so, and `jobs.ownership.test.ts:60-75` pins it). A test is not worth that.
- **Do not mock Drizzle, `db`, or the pool to force `complete` to throw.** See Verified evidence §5 for what real input can and cannot produce, and Task 2 for what to test instead.
- **Do not add the reaper here.** A row left `running` is deliberately left for plan 011. Adding a reaper in this commit would make both plans un-reviewable, and 011 has its own lease design to justify.
- **Do not touch `README.md` or `AGENTS.md` counts.** Plan 021 owns those; this plan adds one suite and six tests, and 021 will pick the numbers up.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/jobs.repository.ts:122-129` | **Modify.** `complete` reports whether it was the call that settled the row. |
| `apps/server/src/lib/jobs.repository.ts` (new export) | **Modify.** `markUnsettled` records a settlement failure on a row this worker still holds, touching none of the columns that decide whether the job runs again. |
| `apps/server/src/lib/jobs.ts:78-87` | **Modify.** Settlement leaves the handler's `try` and gets a bounded retry and its own report. |
| `apps/server/src/lib/jobs.settlement.test.ts` | **Create.** The whole suite for both halves. Integration, gated on `testDbReady()`. |

---

## Contract for plan 011

Plan 011 adds the reaper. These six points are what 010 guarantees and what 011 must not renegotiate. They are stated here rather than in 011 because 010 is what makes them true.

1. **`complete(id, workerId): Promise<boolean>` returns `true` if and only if this call moved the row to `done`.** `false` means the fence excluded it — the row is no longer both `running` and this worker's. `false` is a normal outcome, not an error, and the reaper must not treat it as one.

2. **A row left `running` past its lease is ambiguous by construction, and 011 must requeue it as a full re-execution.** Its handler may or may not have run to completion, and no durable marker can tell the reaper which, because the only writer able to record the difference is the worker whose writes are what failed. The reaper therefore re-runs the handler, and **must increment `attempts` exactly as `fail` does**, so a row that can never settle is still bounded by `max_attempts` instead of being reaped forever. Handler idempotency is what makes this safe, and it is a requirement on handlers — `JobHandler` already passes `jobId` for exactly this reason (`apps/server/src/lib/jobs.ts:19-29`).

3. **The lease is `locked_at`, never `updated_at`.** `markUnsettled` deliberately leaves `locked_at` and `locked_by` untouched, so annotating a row cannot extend its lease or hide it from the reaper. `updated_at` *is* bumped, because the column carries `$onUpdate` (`packages/db/src/schema/job.ts:49-52`) and every Drizzle `.update()` refreshes it — a lease keyed off `updated_at` would be silently extended by a purely diagnostic write. Task 1's test asserts `locked_at` is unmoved so this cannot regress under 011.

4. **`SETTLEMENT_ERROR_PREFIX` is a diagnostic for humans, not a control signal.** 011 must not branch on `last_error`. A handler is free to throw a message beginning with anything at all. The authoritative discriminator between the two failure kinds is the row's own state:

   | | `status` | `locked_by` | `attempts` |
   |---|---|---|---|
   | handler failed | `pending` or `failed` | `null` | incremented |
   | settlement failed | `running` | still the worker's id | unchanged |

5. **The reaper's UPDATE fences on `status = 'running'` and `locked_at < <cutoff>`, and must not fence on `locked_by`** — taking a row away from a worker that is gone is the entire point.

6. **Between 010 and 011 there is a known gap, and 010 accepts it deliberately.** A job whose settlement exhausts its three attempts sits `running` until a human intervenes. Before 010 the same job was silently re-executed after burning an attempt and having its diagnosis overwritten. Stuck and loud beats redone and silent, and 011 closes it. Until then the recovery is one statement — after confirming from the handler's own records whether the side effect landed:

   ```sql
   -- the side effect happened; just record it
   update job set status = 'done', locked_at = null, locked_by = null
   where id = '<id>' and status = 'running';

   -- the side effect did not happen; run it again
   update job set status = 'pending', locked_at = null, locked_by = null, run_at = now()
   where id = '<id>' and status = 'running';
   ```

---

### Task 1: Teach the repository to settle and to annotate

**Files:**
- Modify: `apps/server/src/lib/jobs.repository.ts:113-129`
- Create: `apps/server/src/lib/jobs.settlement.test.ts`

**Interfaces:**
- Consumes: `claim(workerId: string, limit: number): Promise<ClaimedJob[]>` and `enqueue(input: EnqueueInput): Promise<EnqueueResult>`, both already exported from `@/lib/jobs.repository`.
- Produces, all from `@/lib/jobs.repository`:
  - `complete(id: string, workerId: string): Promise<boolean>` — was `Promise<void>`.
  - `markUnsettled(id: string, workerId: string, error: unknown): Promise<void>`.
  - `SETTLEMENT_ERROR_PREFIX: string`.

- [x] **Step 0: Make sure the integration database is up**

```bash
bun run db:test:start && bun run db:test:migrate
```

Everything in this task is gated on `testDbReady()`. Without the database the suite prints `[skip] jobs.settlement needs the test database.` and reports green, which is not the same as passing.

- [x] **Step 1: Write the failing test**

Create `apps/server/src/lib/jobs.settlement.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { eq } from "drizzle-orm";
import {
	claim,
	complete,
	enqueue,
	markUnsettled,
	SETTLEMENT_ERROR_PREFIX,
} from "@/lib/jobs.repository";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("jobs.settlement"));
}

const WORKER = "test-worker";

/** A second worker id, used wherever a test needs the fence to exclude someone. */
const THIEF = "other-worker";
const BATCH = 10;

/** Matches `MAX_ERROR_LENGTH` in `jobs.repository.ts`, the way `jobs.test.ts` mirrors the attempts default. */
const MAX_ERROR_LENGTH = 1000;

async function enqueueId(kind = "test.echo"): Promise<string> {
	const { id } = await enqueue({ kind, payload: {} });
	if (id === null) {
		throw new Error(`expected ${kind} to be enqueued, but it collapsed`);
	}
	return id;
}

/**
 * Enqueues a job and takes it as WORKER.
 *
 * Every settling call starts from here, because both statements are fenced on
 * `status = 'running'` and on the claiming worker's id — a job that was never
 * claimed cannot be settled by anyone, which is the point of the fence.
 */
async function claimed(): Promise<string> {
	const id = await enqueueId();
	await claim(WORKER, BATCH);
	return id;
}

async function rowFor(id: string) {
	const [found] = await db.select().from(job).where(eq(job.id, id)).limit(1);
	return found;
}

afterEach(() => {
	mock.restore();
});

/**
 * Settlement: writing down an outcome that already happened.
 *
 * Split from the lifecycle suite because it is a different question. `jobs.test.ts`
 * asks what the queue does with work that failed; this asks what it does when the
 * work succeeded and the queue could not say so — and the answer must not be the
 * same answer, because an attempt is what a handler spends, not what a pool does.
 */
describe.skipIf(!ready)("job settlement", () => {
	// `claim` is global by design — a worker takes whatever is due — so the table
	// has to start empty or one test claims another's rows.
	beforeEach(async () => {
		await db.delete(job);
	});

	it("reports whether it was the call that settled the job", async () => {
		const id = await claimed();

		expect(await complete(id, WORKER)).toBe(true);
		// Now `done`, so the fence excludes the second call. This is what a retry
		// of a settlement whose acknowledgement was lost looks like, and it is the
		// reason retrying is safe: it reports "not me" rather than settling twice.
		expect(await complete(id, WORKER)).toBe(false);
		expect((await rowFor(id))?.status).toBe("done");
	});

	it("reports false rather than settling a job another worker holds", async () => {
		const id = await claimed();

		expect(await complete(id, THIEF)).toBe(false);
		expect((await rowFor(id))?.status).toBe("running");
	});

	it("records a settlement failure without spending an attempt on it", async () => {
		const id = await claimed();
		const before = await rowFor(id);

		await markUnsettled(id, WORKER, new Error("pool exhausted"));

		const row = await rowFor(id);
		expect(row?.lastError).toBe(`${SETTLEMENT_ERROR_PREFIX}pool exhausted`);
		// The three columns that decide whether this job runs again, all unmoved.
		// The handler already succeeded, so this is not an attempt and not a retry.
		expect(row?.attempts).toBe(0);
		expect(row?.status).toBe("running");
		expect(row?.runAt.getTime()).toBe(before?.runAt.getTime());
		// The lease plan 011's reaper keys off. A diagnostic write must not extend
		// it, or a row nobody will ever settle becomes invisible to the reaper.
		expect(row?.lockedAt?.getTime()).toBe(before?.lockedAt?.getTime());
		expect(row?.lockedBy).toBe(WORKER);
	});

	it("refuses to annotate a row this worker no longer holds", async () => {
		const id = await claimed();

		await markUnsettled(id, THIEF, new Error("pool exhausted"));

		expect((await rowFor(id))?.lastError).toBeNull();
	});

	it("keeps the prefixed error inside the bound a handler error gets", async () => {
		const id = await claimed();

		await markUnsettled(id, WORKER, new Error("x".repeat(50_000)));

		const stored = (await rowFor(id))?.lastError ?? "";
		expect(stored.startsWith(SETTLEMENT_ERROR_PREFIX)).toBe(true);
		expect(stored).toHaveLength(MAX_ERROR_LENGTH);
	});
});
```

- [x] **Step 2: Run it and watch it fail for the right reason**

```bash
cd apps/server && bun test src/lib/jobs.settlement.test.ts
```

Expected: the file never runs a test. Bun aborts at link time with

```
SyntaxError: Export named 'markUnsettled' not found in module '.../apps/server/src/lib/jobs.repository.ts'.
```

If instead you see `[skip] jobs.settlement needs the test database.` and a green run, go back to Step 0 — the suite skipped and proved nothing.

- [x] **Step 3: Make `complete` report whether it settled**

Replace `apps/server/src/lib/jobs.repository.ts:113-129` — the whole doc comment and function — with:

```ts
/**
 * Marks a job done, and reports whether it was this call that did it. Terminal:
 * no index and no query looks at a `done` row again.
 *
 * Fenced on `status = 'running'` and on the claiming worker's own id, so it can
 * only settle a job this worker still owns. Keyed on `id` alone it would be a
 * double-execution bug waiting for a reaper: the moment anything reclaims a
 * stalled row, a merely slow original worker finishing its handler would mark
 * done work a second worker is still running.
 *
 * The boolean is what makes the fence usable rather than merely safe. Zero rows
 * is not an error — it is "the row is no longer both running and mine", which
 * happens when a previous attempt at this same statement committed but its
 * acknowledgement was lost, and again when a reaper has already taken the row
 * away. The caller has to be able to tell that apart from a settled job, because
 * one of them means the queue now has a record of the outcome and the other
 * means it does not.
 */
export async function complete(id: string, workerId: string): Promise<boolean> {
	const settled = await db
		.update(job)
		.set({ lockedAt: null, lockedBy: null, status: "done" })
		.where(
			and(eq(job.id, id), eq(job.lockedBy, workerId), eq(job.status, "running"))
		)
		.returning({ id: job.id });

	return settled.length === 1;
}
```

- [x] **Step 4: Add `markUnsettled` and its prefix**

Insert immediately after `complete`, before the `fail` doc comment:

```ts
/**
 * What `last_error` says when the failure was the queue's, not the handler's.
 *
 * A prefix rather than a column, because this is for whoever reads a job row and
 * has to know that the work in it happened — inventing a column would mean a
 * migration for a string only a human ever reads. It is deliberately not a
 * control signal: nothing branches on it, because a handler is free to throw a
 * message starting with anything. What tells the two kinds apart mechanically is
 * the row itself — a handler failure leaves `status` pending or failed with
 * `locked_by` null, a settlement failure leaves it running and still locked.
 */
export const SETTLEMENT_ERROR_PREFIX =
	"settlement failed after handler succeeded: ";

/**
 * Notes on a job that ran but could not be marked done.
 *
 * The point of this statement is everything it does NOT set. `attempts`,
 * `run_at` and `status` are untouched: the handler succeeded, so no attempt was
 * spent, there is nothing to back off from, and re-arming the row would be a
 * request to run the side effect a second time. `locked_at` and `locked_by` are
 * untouched too, so the lease a reaper reads is neither extended nor released by
 * a purely diagnostic write. `updated_at` does move, because the column's
 * `$onUpdate` fires on every Drizzle update — which is why a lease must be keyed
 * off `locked_at` and never off `updated_at`.
 *
 * Fenced exactly like `complete`, so a worker whose row has already been taken
 * away writes nothing rather than scribbling on a job somebody else is running.
 * That makes this a best-effort note by design: it is written over the same pool
 * that just refused, and losing it costs a line of context, not correctness.
 */
export async function markUnsettled(
	id: string,
	workerId: string,
	error: unknown
): Promise<void> {
	await db
		.update(job)
		.set({
			lastError: `${SETTLEMENT_ERROR_PREFIX}${describeError(error)}`.slice(
				0,
				MAX_ERROR_LENGTH
			),
		})
		.where(
			and(eq(job.id, id), eq(job.lockedBy, workerId), eq(job.status, "running"))
		);
}
```

- [x] **Step 5: Run the test and watch it pass**

```bash
cd apps/server && bun test src/lib/jobs.settlement.test.ts
```

Expected: `5 pass`, `0 fail`, and no `[skip]` line.

- [x] **Step 6: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful. `check-naming` reports one more suite than before (34), 16 architecture rules verified, migrations match. `jobs.repository.ts` is now roughly 130 code lines against the 200 limit, so `noExcessiveLinesPerFile` stays quiet.

`runJob` still calls `complete` and discards the boolean at this point — that is fine, and Task 2 is what consumes it. Nothing else in the repo calls `complete`: `jobs.test.ts:82,93` and `jobs.ownership.test.ts:64,73,81` all `await` it as a statement, and a widened return type does not break a discarded value.

- [x] **Step 7: Commit**

```bash
git add apps/server/src/lib/jobs.repository.ts apps/server/src/lib/jobs.settlement.test.ts
git commit -m "feat(jobs): the queue can now say that settling a job did not land

\`complete\` returned void, so the runner could not distinguish \"this job is now
recorded as done\" from \"the row moved out from under me\". Both are ordinary
outcomes of a fenced UPDATE and they mean opposite things: after the first the
queue has a record of the work, after the second it has none. It returns whether
it was the call that settled the row.

\`markUnsettled\` is the other half, and it is defined by what it leaves alone.
\`attempts\`, \`run_at\` and \`status\` are untouched — the handler succeeded, so no
attempt was spent and re-arming the row would ask for the side effect twice —
and so are \`locked_at\` and \`locked_by\`, so a diagnostic write can never extend
the lease a reaper reads. \`updated_at\` does move, because the column carries
\`\$onUpdate\`; that is precisely why a lease has to be keyed off \`locked_at\`.

The prefix on \`last_error\` is for a human reading a job row who needs to know
that the work in it happened. It is not a control signal and nothing branches on
it: a handler may throw a message starting with anything, and what separates the
two failure kinds mechanically is the row's own state.

Five cases against the real queue, no doubles: both boolean outcomes, the note's
five untouched columns, the fence refusing a worker that no longer holds the
row, and the truncation bound."
```

---

### Task 2: Move settlement out of the handler's `try`

**Files:**
- Modify: `apps/server/src/lib/jobs.ts:1-2,58-88`
- Modify: `apps/server/src/lib/jobs.settlement.test.ts` (add one case)

**Interfaces:**
- Consumes: `complete(id: string, workerId: string): Promise<boolean>` and `markUnsettled(id: string, workerId: string, error: unknown): Promise<void>`, both produced by Task 1.
- Produces: no new export. `runOnce(registry, workerId, limit)` keeps its signature and its meaning — the count is claimed jobs, and a job whose settlement did not land still counts as processed, because the worker did process it.

- [x] **Step 1: Write the failing test**

Append this case inside the `describe.skipIf(!ready)("job settlement", …)` block in `apps/server/src/lib/jobs.settlement.test.ts`, after the last `it`:

```ts
	it("neither fails nor re-runs a job whose handler finished but whose settlement did not land", async () => {
		const runs: string[] = [];
		const registry: JobRegistry = new Map();

		// Taking the row's lock away from inside the handler is the one way real
		// input makes the fenced settling UPDATE match zero rows, and it lands in
		// exactly the window that matters: after the work, before the queue writes
		// it down. Nothing is mocked — this is an ordinary UPDATE against the test
		// database, which is what the repo's ban on Drizzle doubles leaves.
		registry.set("test.steal", async (_payload, jobId) => {
			runs.push(jobId);
			await db.update(job).set({ lockedBy: THIEF }).where(eq(job.id, jobId));
		});

		const id = await enqueueId("test.steal");
		const reported = captureStderr();

		expect(await runOnce(registry, WORKER, BATCH)).toBe(1);
		expect(runs).toEqual([id]);

		const row = await rowFor(id);
		// `fail` was not called. An attempt is what a handler spends, and this
		// handler succeeded; a settlement that could not be written down must not
		// cost the job one of its five, nor overwrite a diagnosis with a pool error.
		expect(row?.attempts).toBe(0);
		expect(row?.lastError).toBeNull();
		expect(row?.status).toBe("running");
		expect(row?.lockedBy).toBe(THIEF);
		// Unsettled work is not allowed to be silent: the row is now stuck until
		// plan 011's reaper exists, and a human needs the job id to find it.
		expect(reported.join("")).toContain(id);
		expect(reported.join("")).toContain("no longer owns");

		// Still `running`, so no poll can pick it up — the handler does not run a
		// second time on the strength of a settlement that did not happen.
		expect(await runOnce(registry, WORKER, BATCH)).toBe(0);
		expect(runs).toEqual([id]);
	});
```

Add the collector above the `describe`, next to `rowFor`:

```ts
/** Collects the runner's report, keeping the test output clean. */
function captureStderr(): string[] {
	const written: string[] = [];

	spyOn(process.stderr, "write").mockImplementation(((chunk: string) => {
		written.push(String(chunk));

		return true;
	}) as typeof process.stderr.write);

	return written;
}
```

And widen the two import statements at the top of the file:

```ts
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from "bun:test";
```
```ts
import { type JobRegistry, runOnce } from "@/lib/jobs";
```

The `@/lib/jobs` import goes above the `@/lib/jobs.repository` one, which is where Biome's import sorting will put it anyway.

- [x] **Step 2: Run it and watch it fail for the right reason**

```bash
cd apps/server && bun test src/lib/jobs.settlement.test.ts
```

Expected: `5 pass`, `1 fail`, and the failure is the stderr assertion:

```
error: expect(received).toContain(expected)
Expected to contain: "<the job id>"
Received: ""
```

Everything above it passes, and that is the finding's narrowing made visible: today's code already declines to `fail` this job, because `complete` matched zero rows without throwing. What it does instead is nothing at all — the row is stuck and no one is told. If you instead see a failure on `expect(row?.attempts).toBe(0)`, stop: something other than this plan has changed `runJob`.

- [x] **Step 3: Split the `try` in `runJob`**

In `apps/server/src/lib/jobs.ts`, replace the `try`/`catch` at lines 78-87 with:

```ts
	try {
		await handler(entry.payload, entry.id);
	} catch (error) {
		// A handler is arbitrary application code and is expected to throw
		// sometimes. Unhandled, the rejection would kill the worker process and
		// leave every job it had claimed stuck in `running` with nothing left
		// alive to release them.
		await fail(entry.id, workerId, error);

		return;
	}

	// Outside the try, and this is the whole point. Settling is not part of the
	// work: by the time it runs the side effect has already happened, so a failure
	// here says the queue could not write down an outcome, not that the outcome
	// went wrong. `fail` is the wrong answer to that three times over — it spends
	// one of five attempts on something the handler did not do, it replaces the
	// handler's own diagnosis with a pool error, and it re-arms `run_at`, which is
	// a request to run the side effect again.
	await settle(entry.id, workerId);
```

- [x] **Step 4: Add the settlement path**

Add these two constants directly above `runOnce` (after the `JobRegistry` type at line 31):

```ts
/**
 * How many times a worker re-tries the settling UPDATE before giving the row up.
 *
 * Three, not one, because `complete` is a single fenced UPDATE with no
 * constraint left to violate: the only way it throws is infrastructural — a pool
 * hiccup, a dropped connection, a failover — and those clear in milliseconds far
 * more often than they last. Not thirty, because a worker that cannot reach
 * Postgres three times running will not be talked round by a fourth, and every
 * extra try holds the single worker slot open while the queue drains nowhere.
 *
 * Retrying is safe by construction rather than by hope: the fence includes
 * `status = 'running'`, so a second attempt after a first that committed but
 * whose acknowledgement was lost matches zero rows and reports "not me" instead
 * of settling anything twice.
 */
const SETTLE_ATTEMPTS = 3;

/** Doubles per retry — 100ms then 200ms, the length of a pool hiccup. */
const SETTLE_RETRY_BASE_MS = 100;
```

And add these two functions at the end of the file, after `runJob`:

```ts
function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Writes down that the work finished, and says so loudly when it cannot.
 *
 * Three outcomes, and they are deliberately not the same. Settled: nothing to
 * report. Fenced out: the row moved on — either an earlier attempt at this same
 * statement committed, or something reclaimed it — so there is no work to do and
 * nothing to record, but a human still wants to know it happened. Exhausted: the
 * row stays `running`, which is the only state a worker that cannot reach the
 * database can leave it in, and plan 011's reaper is what releases it. Until
 * that exists the row is stuck, and stuck-and-logged is the better half of the
 * trade against the previous behaviour, which re-ran the side effect after
 * burning an attempt and overwriting the reason.
 */
async function settle(id: string, workerId: string): Promise<void> {
	let lastError: unknown;

	for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
		try {
			// biome-ignore lint/performance/noAwaitInLoops: each attempt exists only because the previous one threw, so there is nothing to overlap it with.
			const settled = await complete(id, workerId);

			if (!settled) {
				process.stderr.write(
					`[jobs] ${id} finished, but this worker no longer owns the row — settlement left to whoever does\n`
				);
			}

			return;
		} catch (error) {
			lastError = error;
		}

		if (attempt + 1 < SETTLE_ATTEMPTS) {
			// biome-ignore lint/performance/noAwaitInLoops: the wait is the retry — going straight round would spend all three attempts inside the same failed millisecond.
			await pause(SETTLE_RETRY_BASE_MS * 2 ** attempt);
		}
	}

	// Before the row, because the row may be unreachable — this line is the
	// record, and `markUnsettled` is a courtesy written over the same pool that
	// just refused three times.
	process.stderr.write(
		`[jobs] ${id} finished, but settlement failed ${SETTLE_ATTEMPTS} times — row left running: ${String(lastError)}\n`
	);

	try {
		await markUnsettled(id, workerId, lastError);
	} catch {
		// Swallowed on purpose and only here. The note is diagnostic; losing it
		// costs a line of context on a row whose real signal — still `running`,
		// still locked, `attempts` unmoved — is already written. Rethrowing would
		// propagate out of `runOnce` and abandon the rest of the claimed batch.
	}
}
```

Finally widen the import at line 2:

```ts
import {
	type ClaimedJob,
	claim,
	complete,
	fail,
	markUnsettled,
} from "./jobs.repository";
```

- [x] **Step 5: Run the test and watch it pass**

```bash
cd apps/server && bun test src/lib/jobs.settlement.test.ts
```

Expected: `6 pass`, `0 fail`.

Then run the two suites this change could plausibly break, which cover the paths that must not have moved:

```bash
cd apps/server && bun test src/lib/jobs.test.ts src/lib/jobs.ownership.test.ts
```

Expected: `11 pass`, `0 fail`. In particular `jobs.test.ts` still reports the throwing handler as `pending` with `lastError` `"handler exploded"`, still settles the sibling job in the same batch as `done`, and `jobs.ownership.test.ts` still refuses to resurrect a finished job — the fences are unchanged and only the caller's error path moved.

- [x] **Step 6: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful, 16 architecture rules verified, migrations match. `jobs.ts` lands at roughly 85 code lines against the 200 limit. Both `biome-ignore` lines are for `lint/performance/noAwaitInLoops`, a rule the file already suppresses at line 51 with the same shape of justification — no new exemption class, so `tools/check-rules.ts` needs no fixture.

- [x] **Step 7: Commit**

```bash
git add apps/server/src/lib/jobs.ts apps/server/src/lib/jobs.settlement.test.ts
git commit -m "fix(jobs): a settlement failure is not a work failure

\`complete\` sat inside the handler's own try, so the shared catch answered a pool
hiccup with \`fail\` — which increments \`attempts\`, writes the pool error over
whatever the handler had to say, and re-arms \`run_at\`. Every one of those three
is wrong about a job whose handler already returned. Repeated transient hiccups
could walk an already-completed job to \`failed\` and leave \`last_error\` blaming
the queue for something the job did not do.

Narrower than it looks, and worth saying so. \`fail\` is fenced on
\`status = 'running'\`, so a settlement that committed and then lost its
acknowledgement already matched zero rows; re-execution only ever followed a
commit that genuinely did not happen. And both shipped handlers are idempotent
already — mail carries the job id as Resend's idempotency key, \`ai.generate\`
early-returns on its own ledger row — so nothing in the tree was being executed
twice. What was real is the burnt attempt, the overwritten diagnosis, and the
fact that the third handler anyone adds inherits none of that protection.

Settlement now has its own path: bounded retry, because the only way a fenced
UPDATE with nothing left to violate throws is infrastructural and those clear in
milliseconds; then the row is left \`running\` and the failure is reported. Left
running rather than re-armed, because \`running\` is the only state a worker that
cannot reach Postgres can leave behind, and because re-arming is a request to
run the side effect again. Releasing it is the reaper's job and lands next.

No Drizzle was doubled to test this. A handler that takes its own row's lock is
the one real input that makes the fenced UPDATE match zero rows, and it proves
the property end to end: the job keeps its attempt, keeps a null \`last_error\`,
and a second poll does not run the handler again."
```

---

## Done when

- `complete` returns `true` only for the call that moved the row to `done`, and `false` for every call the fence excludes.
- `markUnsettled` leaves `attempts`, `status`, `run_at`, `locked_at` and `locked_by` exactly as it found them, and refuses a row the calling worker no longer holds.
- No code path in `apps/server/src/lib/jobs.ts` reaches `fail` after `handler` has resolved. `fail` is called from exactly two places: the unregistered-kind guard and the handler's own `catch`.
- A job whose handler succeeds and whose settlement does not land keeps `attempts` at `0`, keeps `status` `running`, is not re-run by a subsequent `runOnce`, and produces a `[jobs] <id> …` line on stderr naming it.
- `apps/server/src/lib/jobs.settlement.test.ts` reports `6 pass, 0 fail` against a live test database, and prints the skip notice — not a green run — without one.
- `bun run check` passes.
- The contract in [Contract for plan 011](#contract-for-plan-011) is true of the tree: points 1, 3 and 4 are each asserted by a test in the new suite.

## Out of scope

- **The reaper for rows stuck in `running` — plan 011 (CORR-01).** This plan creates one more way to reach that state and states the contract 011 consumes; it does not release anything.
- **Extracting and testing the worker poll loop — plan 016 (TEST-04, TEST-05).** `apps/server/src/worker.ts`'s loop, drain and shutdown are untouched here, as are `sweepSettledJobs` and the `BACKOFF_MAX_MS` ceiling.
- **The `fetch` timeout on Resend — PERF-01.** A hung socket holding the single worker slot is a different failure with a different fix; it happens to be the failure most likely to *reach* the settlement path, which is an argument for doing both, not for merging them.
- **`beforeEach(db.delete(job))` racing parallel suites — TEST-01.** The new suite follows the existing convention in `jobs.test.ts:60-62` and `jobs.ownership.test.ts:39-41` rather than inventing a third; whoever fixes TEST-01 fixes all three together.
- **`README.md` and `AGENTS.md` counts — plan 021.** This adds one suite and six tests; 021 owns those numbers.
- **A `settling` job status.** Rejected on the merits, not deferred — see [Do not](#do-not).
