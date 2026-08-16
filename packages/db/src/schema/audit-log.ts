import { index, integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

/**
 * One row per mutating request: who did what, where, and what answer they got.
 *
 * Append-only, and nothing prunes it. Every other table with a retention story
 * is a cache whose rows stop meaning anything, while this one is the record;
 * `apps/server/src/tasks.ts` is where the absent sweep is argued, next to the
 * sweeps that do exist.
 *
 * The row is a verbatim record of an HTTP exchange rather than a domain event:
 * method, path, status. That is a deliberate floor, not a first draft — it is
 * what a middleware can record for every endpoint without an endpoint opting in,
 * and an audit line that a new route has to remember to write is a line that
 * eventually goes missing.
 */
export const auditLog = pgTable(
	"audit_log",
	{
		/**
		 * Nullable, twice over.
		 *
		 * Null at insert because plenty of mutations have no actor: a failed
		 * sign-in, a password reset, a 401 against a guarded route. Those are the
		 * attempts an audit trail is most often read for, so refusing to record
		 * them would gut it.
		 *
		 * Null later because the actor was deleted — `set null` and never
		 * `cascade`. Losing the name of who acted is bad; deleting the record that
		 * something happened is the one thing this table must not do.
		 */
		actorId: text("actor_id").references(() => user.id, {
			onDelete: "set null",
		}),
		// Millisecond precision, matching `project.createdAt` and for the same
		// reason: this is a keyset sort key, the page cursor is an ISO-8601 string
		// carrying exactly three fractional digits, and storing anything finer is
		// precision the cursor can never round-trip.
		createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
			.defaultNow()
			.notNull(),
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		method: text("method").notNull(),
		/**
		 * Nullable because an authentication request has no tenant. `requireOrg` is
		 * what resolves one, and sign-in, sign-up and password reset run in front
		 * of every guard — a user may belong to several organizations, so pinning
		 * such a request to one of them would be a guess, and a guess in an audit
		 * trail is worse than a null.
		 *
		 * `cascade` because the read path is per-organization: once the tenant is
		 * gone, its rows are unreachable by construction and only the erasure
		 * request they are answering is left.
		 */
		organizationId: text("organization_id").references(() => organization.id, {
			onDelete: "cascade",
		}),
		path: text("path").notNull(),
		// The wide event's own id, so a row and the request that produced it can be
		// joined in whatever the deployment drains logs to. Without it the trail
		// says what happened and the log says why, and nothing connects them.
		requestId: text("request_id").notNull(),
		status: integer("status").notNull(),
	},
	(table) => [
		// The read path's exact shape: the tenant equality first, then the sort key
		// spelled the way the ORDER BY spells it, so the seek starts the scan at the
		// cursor instead of reading the organization's whole history and top-N
		// sorting it. An audit trail only grows, which makes this the one index the
		// table cannot do without.
		//
		// `nullsFirst()` is load-bearing, for the reason `project_organization_created_idx`
		// spells out: Drizzle emits `DESC NULLS LAST` for an index column and a bare
		// `DESC` — which Postgres reads as NULLS FIRST — for an `orderBy`, and two
		// disagreeing orderings mean the index cannot supply the ordering at all.
		index("audit_log_organization_created_idx").on(
			table.organizationId,
			table.createdAt.desc().nullsFirst(),
			table.id.desc().nullsFirst()
		),
	]
);
