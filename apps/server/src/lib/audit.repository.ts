import { db } from "@keel/db";
import { auditLog } from "@keel/db/schema/audit-log";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * The only file behind the audit trail allowed to touch Drizzle, mirroring the
 * per-module repositories. It lives under lib/ rather than in a module for the
 * same reason `idempotency.repository.ts` and `rate-limit.repository.ts` do: the
 * trail is cross-cutting request machinery with its own table, written by one
 * middleware that every route runs through, and owned by no module.
 */

export async function record(entry: {
	actorId: string | null;
	method: string;
	organizationId: string | null;
	path: string;
	requestId: string;
	status: number;
}) {
	await db.insert(auditLog).values(entry);
}

/**
 * One page of an organization's activity, newest first, seeking from the cursor
 * rather than counting past it — `projects.repository.ts` explains at length why
 * OFFSET is the wrong tool for a growing table, and nothing grows like an audit
 * trail.
 *
 * The tenant equality sits in the same `and(...)` as the seek, not as a check
 * afterwards. Tenancy that lives in the WHERE clause cannot be forgotten by a
 * caller, and another organization's rows are simply not there.
 *
 * Rows with a null `organization_id` are therefore invisible here — an
 * authentication attempt is recorded, and no per-organization view claims it.
 * That is the honest consequence of not guessing which of a user's tenants a
 * sign-in belonged to; reading those rows is an operator's job, against the
 * table.
 */
export async function listByOrganization(
	organizationId: string,
	page: { cursor: { createdAt: Date; id: string } | null; limit: number }
) {
	const seek = page.cursor
		? sql`(${auditLog.createdAt}, ${auditLog.id}) < (${page.cursor.createdAt}, ${page.cursor.id})`
		: undefined;

	// One row beyond the page, whose presence is what answers "is there another
	// page?" without a second COUNT over the same predicate.
	return await db
		.select()
		.from(auditLog)
		.where(and(eq(auditLog.organizationId, organizationId), seek))
		.orderBy(desc(auditLog.createdAt), desc(auditLog.id))
		.limit(page.limit + 1);
}
