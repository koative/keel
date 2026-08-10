import {
	index,
	integer,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";

import { organization } from "./organization";

/**
 * What each tenant spent on model calls, one row per completion.
 *
 * Append-only: nothing updates or deletes a row here, because this is the answer
 * to "what does this organization owe" and a meter that can be rewritten is not
 * a meter. The `job` sweep in `tasks.ts` deletes settled jobs after three days,
 * which is exactly why `jobId` carries no foreign key — a cascade from that
 * routine cleanup would take the billing history with it.
 *
 * Deliberately holds no prompt and no completion. A ledger that answers "what
 * did this tenant spend" does not need the content to do it, and storing it
 * turns a small billing table into a data-retention problem: subject-access
 * requests, deletion requests, a retention policy, and an encryption question,
 * all inherited by a table whose only job is arithmetic. Whatever a consumer
 * wants to keep, it keeps in its own domain table where it can reason about the
 * lifetime.
 *
 * This is the metering distinction the README draws. A rate limit is protection,
 * where approximate is fine and a dropped counter costs nothing. A quota is
 * billing, where exact is required and the domain owns the record.
 */
export const aiUsage = pgTable(
	"ai_usage",
	{
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		inputTokens: integer("input_tokens").notNull(),
		/**
		 * The job that made the call, and the reason a retry cannot be billed
		 * twice: the unique index below makes this row the record that says the
		 * call already happened, so the handler can check before spending again.
		 *
		 * No `references(() => job.id)`. Job rows are swept three days after they
		 * settle; this one has to survive for as long as the invoice does.
		 */
		jobId: text("job_id").notNull(),
		/**
		 * Which model answered — not decoration. Cost per token differs by an
		 * order of magnitude between models, so token counts without the model
		 * cannot be priced afterwards at all, and the price list is not something
		 * this table can reconstruct once the row is old.
		 */
		model: text("model").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		outputTokens: integer("output_tokens").notNull(),
	},
	(table) => [
		// The idempotency guarantee, enforced by Postgres rather than by the
		// handler reading before it writes: two workers that somehow claimed the
		// same job cannot both record a charge for it.
		uniqueIndex("ai_usage_jobId_idx").on(table.jobId),
		// The only query this table is read by: one organization's usage over a
		// period. Tenant equality first, then the range column, so the seek starts
		// at the period's lower bound instead of scanning every tenant's history.
		index("ai_usage_organization_created_idx").on(
			table.organizationId,
			table.createdAt
		),
	]
);
