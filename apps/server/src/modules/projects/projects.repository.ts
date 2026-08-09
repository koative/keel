import { db } from "@keel/db";
import { withUniqueConflict } from "@keel/db/errors";
import { project } from "@keel/db/schema/project";
import { desc, eq } from "drizzle-orm";

/**
 * The only file in this module allowed to touch Drizzle.
 *
 * Return types are inferred from the queries rather than annotated with the
 * service's `Project`: annotating would mean importing the service, inverting the
 * dependency. Structural checking still catches a drift, at the wiring site in
 * the handlers, which is where the two halves actually meet.
 */

export async function listByOwner(ownerId: string) {
	return await db
		.select()
		.from(project)
		.where(eq(project.ownerId, ownerId))
		.orderBy(desc(project.createdAt));
}

export async function findById(id: string) {
	const [found] = await db
		.select()
		.from(project)
		.where(eq(project.id, id))
		.limit(1);
	return found;
}

export async function insert(input: {
	description: string | null;
	name: string;
	ownerId: string;
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

export async function deleteById(id: string) {
	await db.delete(project).where(eq(project.id, id));
}

/**
 * The assembled store the handlers inject. Its shape is checked against the
 * service's `ProjectStore` where the two are joined, which is the only place
 * both halves are in scope.
 */
export const projectStore = { deleteById, findById, insert, listByOwner };
