import {
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * The reply a request already produced, keyed by the client's `Idempotency-Key`.
 *
 * `response` holds the reply's exact serialized bytes under a single `body` key
 * rather than the decoded envelope: jsonb normalises object key order, so a
 * decoded-and-re-encoded replay would not be byte-for-byte the original answer,
 * and a client that diffs or signs the payload would see two different replies
 * to one request.
 */
export const idempotencyKey = pgTable(
	"idempotency_key",
	{
		actorId: text("actor_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		createdAt: timestamp("created_at").defaultNow().notNull(),
		expiresAt: timestamp("expires_at").notNull(),
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		key: text("key").notNull(),
		method: text("method").notNull(),
		path: text("path").notNull(),
		requestHash: text("request_hash").notNull(),
		response: jsonb("response").$type<{ body: string }>().notNull(),
		status: integer("status").notNull(),
	},
	(table) => [
		// Scoped to the actor, never global: a global key space would let one
		// tenant replay another's reply by guessing a key, and would collide two
		// clients that both number their keys from one. This is the constraint
		// @keel/db/errors translates to a 409.
		uniqueIndex("idempotency_key_actor_key_idx").on(table.actorId, table.key),
		index("idempotency_key_expiresAt_idx").on(table.expiresAt),
	]
);
