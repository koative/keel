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
 *
 * That last claim only holds while the predicate and the ORDER BY name the bare
 * column, so `project_organization_created_idx` can be range-scanned from the
 * cursor. `created_at` is therefore stored at `precision: 3`: an ISO-8601 cursor
 * carries milliseconds and nothing finer, and storing more than the cursor can
 * express is what used to force a `date_trunc` on both sides — which is exactly
 * what made the column unsargable, so every page read the organization's whole
 * project set and top-N sorted it.
 */
export async function listByOrganization(
	organizationId: string,
	page: { cursor: { createdAt: Date; id: string } | null; limit: number }
) {
	// The bound is a `Date` passed straight through. It can be, because the column
	// is `timestamptz`: node-postgres renders a Date with an explicit offset and
	// Postgres honours it, so the instant survives whatever the session's TimeZone
	// happens to be. Against a bare `timestamp` column the same code silently
	// shifted the bound by the server's offset, and that is the reason every
	// timestamp in this schema carries a zone.
	const seek = page.cursor
		? sql`(${project.createdAt}, ${project.id}) < (${page.cursor.createdAt}, ${page.cursor.id})`
		: undefined;

	// One row beyond the page. Its presence is what tells the service another
	// page exists; see `listProjects`.
	return await db
		.select()
		.from(project)
		.where(and(eq(project.organizationId, organizationId), seek))
		.orderBy(desc(project.createdAt), desc(project.id))
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
