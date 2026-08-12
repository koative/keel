import { db } from "@keel/db";
import { webhookEvent } from "@keel/db/schema/webhook-event";
import { and, eq, isNull } from "drizzle-orm";

/**
 * The only file in the webhooks module allowed to touch Drizzle.
 *
 * The receiver inserts under the unique (provider, event_id) index — the
 * durable half of the deduplication — and the worker marks the row processed
 * under the same key.
 */

/**
 * Persists a delivery, reporting whether THIS call created the row.
 *
 * The unique index is the arbiter: a provider retry or an attacker's replay of
 * the same event inserts nothing, and the receiver must not enqueue for it
 * (once the first job settled, its dedupeKey left the unsettled index and a
 * second enqueue would run the work a second time — the trap plan 022's
 * contract warns about). `onConflictDoNothing` with an explicit target, never a
 * bare swallow: the target names the index that arbitrates, so a surprise
 * primary-key collision is a loud error rather than a silent success.
 */
export async function insertEvent(input: {
	eventId: string;
	provider: string;
	rawBody: string;
	receivedAt: Date;
}): Promise<boolean> {
	const [row] = await db
		.insert(webhookEvent)
		.values(input)
		.onConflictDoNothing({
			target: [webhookEvent.provider, webhookEvent.eventId],
		})
		.returning({ id: webhookEvent.id });

	return row !== undefined;
}

/**
 * Marks a delivery processed, reporting whether THIS call did it.
 *
 * The `processed_at IS NULL` predicate is the idempotency: the worker may run
 * the same job twice — a crash between `claim` and settlement hands it back —
 * and the second run matches no row, so it does nothing and settles. The job
 * row's own status is not enough: the crash that redelivers a job is exactly
 * the one that leaves it `pending` again with the work already done.
 */
export async function markProcessed(
	provider: string,
	eventId: string
): Promise<boolean> {
	const [row] = await db
		.update(webhookEvent)
		.set({ processedAt: new Date() })
		.where(
			and(
				eq(webhookEvent.provider, provider),
				eq(webhookEvent.eventId, eventId),
				isNull(webhookEvent.processedAt)
			)
		)
		.returning({ id: webhookEvent.id });

	return row !== undefined;
}
