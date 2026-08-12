import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

/**
 * A webhook delivery exactly as it arrived, one row per verified event.
 *
 * The row is the durable record the receiver's 200 rests on: the signature
 * verified over the raw bytes, then the bytes persisted, then the job queued.
 * `raw_body` is text because the payload must survive byte for byte — the same
 * reasoning plan 022 applies to `idempotency.response` — and a jsonb round
 * trip would normalise key order and whitespace. The provider's payload is
 * UTF-8 JSON, so a lossless UTF-8 decode is the exact bytes.
 *
 * Deliberately not tenant-scoped. A webhook may target a resource of any kind,
 * and the receiver is generic: whatever tenancy applies is read from the
 * verified payload by a provider integration, not by this table.
 *
 * `processed_at` is the worker's durable marker — the smallest honest record
 * that the delivery's background work ran. Null means the worker has not got
 * to it yet; the worker's UPDATE is the one statement that sets it, and the
 * `IS NULL` predicate is what makes a redelivered job a no-op.
 */
export const webhookEvent = pgTable(
	"webhook_event",
	{
		eventId: text("event_id").notNull(),
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		processedAt: timestamp("processed_at", { withTimezone: true }),
		provider: text("provider").notNull(),
		rawBody: text("raw_body").notNull(),
		receivedAt: timestamp("received_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// The replay guard, enforced by Postgres: the same provider event can be
		// delivered any number of times (its own retries, an attacker's replay)
		// and exactly one row wins. Provider first because two providers can and
		// do mint the same event id. This is the durable half of the receiver's
		// deduplication — `dedupeKey` on the job is the in-flight half and stops
		// working the moment a job settles — which is why the receiver enqueues
		// only for the delivery that created the row.
		uniqueIndex("webhook_event_provider_event_id_idx").on(
			table.provider,
			table.eventId
		),
	]
);
