import { db } from "@keel/db";
import { webhookEvent } from "@keel/db/schema/webhook-event";
import { and, eq, isNull } from "drizzle-orm";

/**
 * The only file in the webhooks module allowed to touch Drizzle.
 *
 * The receiver inserts under the unique (provider, event_id) index — the
 * durable half of the deduplication — and takes the row back out when it could
 * not queue the job beside it; the worker marks the row processed under the same
 * key.
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
 * Removes a delivery the receiver could not finish queueing.
 *
 * The compensation for a `webhook_event` row that committed while the job
 * beside it did not: without it the provider's retry finds the row present,
 * inserts nothing, skips the enqueue and gets a 200, so the event stays
 * persisted and unprocessed with nothing left to trigger it. Deleting the row
 * puts the event back to never-received, which is the one state the provider's
 * own retry can repair.
 *
 * By the natural key rather than the row id, like `markProcessed`: the receiver
 * knows the delivery it just created by (provider, eventId), and the unique
 * index guarantees that is one row.
 */
export async function deleteEvent(
	provider: string,
	eventId: string
): Promise<void> {
	await db
		.delete(webhookEvent)
		.where(
			and(
				eq(webhookEvent.provider, provider),
				eq(webhookEvent.eventId, eventId)
			)
		);
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
