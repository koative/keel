import { db } from "@keel/db";
import { withUniqueConflict } from "@keel/db/errors";
import { project } from "@keel/db/schema/project";
import { and, desc, eq, sql } from "drizzle-orm";

/**
 * The only file in this module allowed to touch Drizzle.
 *
 * Return types are inferred from the queries rather than annotated with the
 * service's `Project`: annotating would mean importing the service, inverting the
 * dependency. Structural checking still catches a drift, at the wiring site in
 * the handlers, which is where the two halves actually meet.
 *
 * Every statement below is scoped by `organizationId`, in the same `and(...)` as
 * the id rather than as a separate check afterwards. Tenancy that lives in a
 * WHERE clause cannot be forgotten by a caller, and a row belonging to another
 * organization is simply not there — which is what makes the 404 the service
 * reports the truth rather than a disguise.
 */

/**
 * Keyset (seek) pagination, not OFFSET.
 *
 * OFFSET makes Postgres produce and discard every skipped row, so page 100
 * costs a hundred times page 1. Worse, the window is defined by position: a row
 * inserted between two requests shifts everything down, so the client sees one
 * row twice and never sees another. Seeking from the last row actually read is
 * stable under concurrent writes and reads the same number of rows every page.
 */
export async function listByOrganization(
	organizationId: string,
	page: { cursor: { createdAt: Date; id: string } | null; limit: number }
) {
	// `created_at` is compared and ordered truncated to milliseconds because that
	// is all an ISO-8601 cursor can carry, while the column stores microseconds.
	// Comparing the raw column against a truncated bound would silently drop
	// every row sharing the cursor's millisecond.
	const createdAtMs = sql`date_trunc('milliseconds', ${project.createdAt})`;

	// The bound is sent as text and cast rather than as a Date, because the
	// driver would render a Date in the local zone and this column is
	// `timestamp without time zone` holding UTC.
	const seek = page.cursor
		? sql`(${createdAtMs}, ${project.id}) < (${page.cursor.createdAt.toISOString()}::timestamptz at time zone 'UTC', ${page.cursor.id})`
		: undefined;

	// One row beyond the page. Its presence is what tells the service another
	// page exists; see `listProjects`.
	return await db
		.select()
		.from(project)
		.where(and(eq(project.organizationId, organizationId), seek))
		.orderBy(desc(createdAtMs), desc(project.id))
		.limit(page.limit + 1);
}

export async function findById(id: string, organizationId: string) {
	const [found] = await db
		.select()
		.from(project)
		.where(and(eq(project.id, id), eq(project.organizationId, organizationId)))
		.limit(1);
	return found;
}

export async function insert(input: {
	createdBy: string | null;
	description: string | null;
	name: string;
	organizationId: string;
	slug: string;
}) {
	const [created] = await withUniqueConflict(
		{ field: "slug", resource: "Project" },
		() => db.insert(project).values(input).returning()
	);

	if (!created) {
		throw new Error("insert into project returned no row");
	}

	return created;
}

export async function deleteById(id: string, organizationId: string) {
	await db
		.delete(project)
		.where(and(eq(project.id, id), eq(project.organizationId, organizationId)));
}

/**
 * The assembled store the handlers inject. Its shape is checked against the
 * service's `ProjectStore` where the two are joined, which is the only place
 * both halves are in scope.
 */
export const projectStore = {
	deleteById,
	findById,
	insert,
	listByOrganization,
};
