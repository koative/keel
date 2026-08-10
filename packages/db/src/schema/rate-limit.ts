import {
	doublePrecision,
	index,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

/**
 * Token buckets for this application's own endpoints.
 *
 * Separate from `rateLimit` in `./auth` on purpose: Better Auth owns every row in
 * that table, keys it by IP and path, and stores `lastRequest` as an epoch in
 * milliseconds because that is what its adapter expects. Writing our own rows into
 * it would make both the sweep and the column semantics ambiguous, and a starter
 * should not teach that a third party's table is a good place to keep your data.
 *
 * A token bucket rather than a fixed window. A fixed window lets a caller spend its
 * whole budget at 11:59:59 and again at 12:00:00, so the effective burst is twice
 * the limit at every boundary. The bucket costs the same — one row, one conditional
 * update — and smooths that away.
 */
export const apiRateLimit = pgTable(
	"api_rate_limit",
	{
		/** `<actor>|<bucket>`. Opaque here; the middleware owns the format. */
		key: text("key").primaryKey(),
		/**
		 * Fractional on purpose: the refill is `elapsed * rate`, and rounding it to
		 * an integer at every request would either grant free tokens or lose them,
		 * depending on which way it rounded.
		 */
		tokens: doublePrecision("tokens").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
	},
	(table) => [
		// The sweep in `tasks.ts` deletes buckets nobody has touched. Without this it
		// is a sequential scan over every actor that ever made a request.
		index("api_rate_limit_updatedAt_idx").on(table.updatedAt),
	]
);
