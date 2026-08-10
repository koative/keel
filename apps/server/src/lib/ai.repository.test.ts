import { describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { sql } from "drizzle-orm";
import {
	hasUsageForJob,
	recordUsage,
	usageForOrganization,
} from "@/lib/ai.repository";
import { seedOrganization, skipNotice, testDbReady } from "../../test-db";

/**
 * `testDbReady` gates on `project`, a table every migration set has had for a
 * long time. This suite also needs `ai_usage`, and the schema declaration lands
 * before the migration that creates it — so a checkout in between says which
 * step is missing instead of failing five times with a Postgres error. The
 * short-circuit matters: without a database the second query would throw rather
 * than answer.
 */
const ready =
	(await testDbReady()) &&
	(
		await db.execute(
			sql`select to_regclass('public.ai_usage') is not null as ready`
		)
	).rows[0]?.ready === true;

if (!ready) {
	process.stdout.write(skipNotice("ai.repository"));
}

const PERIOD = {
	from: new Date(Date.now() - 60_000),
	to: new Date(Date.now() + 60_000),
};

describe.skipIf(!ready)("ai usage ledger", () => {
	it("records the model alongside both token counts", async () => {
		// Without the model the row cannot be priced later: cost per token differs
		// by an order of magnitude between models.
		const organizationId = await seedOrganization();
		await recordUsage({
			inputTokens: 120,
			jobId: crypto.randomUUID(),
			model: "anthropic/claude-haiku",
			organizationId,
			outputTokens: 45,
		});

		expect(await usageForOrganization(organizationId, PERIOD)).toEqual({
			inputTokens: 120,
			outputTokens: 45,
		});
	});

	it("sums only the asking organization's rows", async () => {
		const mine = await seedOrganization();
		const theirs = await seedOrganization();

		await recordUsage({
			inputTokens: 10,
			jobId: crypto.randomUUID(),
			model: "openai/gpt-4o-mini",
			organizationId: mine,
			outputTokens: 1,
		});
		await recordUsage({
			inputTokens: 5,
			jobId: crypto.randomUUID(),
			model: "openai/gpt-4o-mini",
			organizationId: mine,
			outputTokens: 2,
		});
		await recordUsage({
			inputTokens: 9999,
			jobId: crypto.randomUUID(),
			model: "openai/gpt-4o-mini",
			organizationId: theirs,
			outputTokens: 9999,
		});

		expect(await usageForOrganization(mine, PERIOD)).toEqual({
			inputTokens: 15,
			outputTokens: 3,
		});
	});

	it("reports zero for an organization that has spent nothing", async () => {
		// `sum` over no rows is null, and a caller doing arithmetic on that would
		// get NaN rather than a bill of nothing.
		expect(
			await usageForOrganization(await seedOrganization(), PERIOD)
		).toEqual({ inputTokens: 0, outputTokens: 0 });
	});

	it("counts a job's call once however often the row is written", async () => {
		// The retry path: a redelivered job whose usage was already recorded must
		// not add a second charge, and must be recognisable as already paid.
		const organizationId = await seedOrganization();
		const jobId = crypto.randomUUID();
		const entry = {
			inputTokens: 30,
			jobId,
			model: "openai/gpt-4o-mini",
			organizationId,
			outputTokens: 8,
		};

		expect(await hasUsageForJob(jobId)).toBe(false);
		await recordUsage(entry);
		expect(await hasUsageForJob(jobId)).toBe(true);
		await recordUsage({ ...entry, inputTokens: 99, outputTokens: 99 });

		expect(await usageForOrganization(organizationId, PERIOD)).toEqual({
			inputTokens: 30,
			outputTokens: 8,
		});
	});

	it("excludes rows outside the period", async () => {
		const organizationId = await seedOrganization();
		await recordUsage({
			inputTokens: 7,
			jobId: crypto.randomUUID(),
			model: "openai/gpt-4o-mini",
			organizationId,
			outputTokens: 3,
		});

		const past = {
			from: new Date(Date.now() - 7_200_000),
			to: new Date(Date.now() - 3_600_000),
		};

		expect(await usageForOrganization(organizationId, past)).toEqual({
			inputTokens: 0,
			outputTokens: 0,
		});
	});
});
