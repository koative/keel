import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

/** The states a job moves through. `done` and `failed` are terminal. */
export const JOB_STATUSES = ["pending", "running", "done", "failed"] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * Background work, queued in the database the application already has.
 *
 * Deliberately not tenant-scoped: a job is infrastructure, and the payload — not
 * a foreign key — carries whatever tenant the work belongs to. A tenant column
 * here would have to be nullable for every job that has no tenant (a nightly
 * sweep, a provider reconciliation), which makes it useless as a filter.
 */
export const job = pgTable(
	"job",
	{
		attempts: integer("attempts").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		/**
		 * Opt-in collapse key. Null means "always enqueue"; Postgres treats every
		 * null as distinct, so unkeyed jobs never collide with each other.
		 */
		dedupeKey: text("dedupe_key"),
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		kind: text("kind").notNull(),
		lastError: text("last_error"),
		lockedAt: timestamp("locked_at", { withTimezone: true }),
		lockedBy: text("locked_by"),
		maxAttempts: integer("max_attempts").notNull().default(5),
		payload: jsonb("payload").notNull(),
		runAt: timestamp("run_at", { withTimezone: true }).defaultNow().notNull(),
		status: text("status", { enum: JOB_STATUSES }).notNull().default("pending"),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		// The claim query's exact shape: `status = 'pending' AND run_at <= now()`
		// ordered by run_at. Without it every poll — once a second, per worker —
		// is a sequential scan over the whole history of completed jobs.
		index("job_status_runAt_idx").on(table.status, table.runAt),
		// Partial on purpose, and this is the load-bearing part of the design.
		//
		// Restricted to the two unsettled statuses, the index makes a second
		// enqueue of a key that is already in flight a no-op: duplicate work
		// collapses into the row that is doing it, whether that row is still
		// waiting or already running. Only when the job reaches `done` or
		// `failed` does it leave the index and free the key for the next round
		// of the same work.
		//
		// `running` is inside the predicate deliberately. With `pending` alone
		// the key was released by `claim` — the same statement that starts the
		// work — so "resend verification" pressed while the first mail was being
		// sent produced a second row that ran concurrently, and a keyed
		// `ai.generate` was paid for twice.
		//
		// So one index is both a debounce and a mutex, enforced by Postgres. A
		// non-partial index would instead permanently burn the key after its
		// first use, and getting the same behaviour in the application would
		// need a read-then-write under an advisory lock on every enqueue.
		uniqueIndex("job_dedupeKey_unsettled_idx")
			.on(table.dedupeKey)
			.where(sql`${table.status} in ('pending', 'running')`),
		// The status vocabulary is enforced by the database rather than only by
		// TypeScript: the claim and fail statements write it as raw SQL, and a
		// typo there would otherwise silently strand rows in a state no worker
		// looks for.
		check(
			"job_status_check",
			sql`${table.status} in ('pending', 'running', 'done', 'failed')`
		),
	]
);
