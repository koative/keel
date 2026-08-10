import { db } from "@keel/db";
import { aiUsage } from "@keel/db/schema/ai-usage";
import { and, eq, gte, lt, sum } from "drizzle-orm";

/**
 * The only file allowed to touch the usage ledger, mirroring the per-module
 * repositories. It lives under lib/ rather than in a module because the meter is
 * cross-cutting: the worker writes it and billing reads it, and neither owns it.
 */

export interface UsageEntry {
	inputTokens: number;
	jobId: string;
	model: string;
	organizationId: string;
	outputTokens: number;
}

export interface UsagePeriod {
	/** Inclusive. */
	from: Date;
	/** Exclusive, so two consecutive periods cannot both count the same row. */
	to: Date;
}

export interface UsageTotal {
	inputTokens: number;
	outputTokens: number;
}

/**
 * Records what one job's call cost.
 *
 * The conflict is swallowed rather than raised, exactly as `enqueue` does with a
 * dedupe key: a second write for a job id that is already metered is a
 * redelivery, not a bug, and the first row is the true one. Raising here would
 * fail a job whose work is already done and send it back for another paid retry.
 */
export async function recordUsage(entry: UsageEntry): Promise<void> {
	await db.insert(aiUsage).values(entry).onConflictDoNothing({
		target: aiUsage.jobId,
	});
}

/** Whether this job's call has already been made and paid for. */
export async function hasUsageForJob(jobId: string): Promise<boolean> {
	const [found] = await db
		.select({ id: aiUsage.id })
		.from(aiUsage)
		.where(eq(aiUsage.jobId, jobId))
		.limit(1);
	return found !== undefined;
}

/**
 * What one organization spent over a period.
 *
 * Summed in Postgres rather than by reading rows, because the caller wants two
 * numbers and a busy tenant's month is thousands of rows. `sum` returns a
 * numeric as a string — Postgres cannot promise it fits a double — and both
 * columns are bounded by a context window here, so the narrowing is safe.
 */
export async function usageForOrganization(
	organizationId: string,
	period: UsagePeriod
): Promise<UsageTotal> {
	const [total] = await db
		.select({
			inputTokens: sum(aiUsage.inputTokens),
			outputTokens: sum(aiUsage.outputTokens),
		})
		.from(aiUsage)
		.where(
			and(
				eq(aiUsage.organizationId, organizationId),
				gte(aiUsage.createdAt, period.from),
				lt(aiUsage.createdAt, period.to)
			)
		);

	return {
		inputTokens: Number(total?.inputTokens ?? 0),
		outputTokens: Number(total?.outputTokens ?? 0),
	};
}
