import { notFound } from "@keel/http/errors";
import type { LogPort } from "@/lib/log";

/**
 * The domain model. Deliberately declared here rather than derived from the
 * Drizzle row type: this file may not import `@keel/db`, which is exactly what
 * keeps a schema change from silently rewriting the business rules. The
 * repository satisfies it structurally, so the mismatch surfaces at the wiring
 * site with a type error.
 */
export interface Project {
	createdAt: Date;
	description: string | null;
	id: string;
	name: string;
	ownerId: string;
	slug: string;
	updatedAt: Date;
}

export interface CreateProject {
	description: string | null;
	name: string;
	slug: string;
}

/**
 * Where to resume a listing. Declared here rather than imported from
 * `@/lib/cursor` for the same reason as `Project`: the service does not know
 * that the caller speaks HTTP, so it cannot know a cursor is ever a string.
 */
export interface ProjectCursor {
	createdAt: Date;
	id: string;
}

export interface ProjectPage {
	cursor: ProjectCursor | null;
	limit: number;
}

export interface ProjectListing {
	items: Project[];
	nextCursor: ProjectCursor | null;
}

/** The persistence this service needs, and nothing more. */
export interface ProjectStore {
	deleteById: (id: string) => Promise<void>;
	findById: (id: string) => Promise<Project | undefined>;
	insert: (input: CreateProject & { ownerId: string }) => Promise<Project>;
	listByOwner: (ownerId: string, page: ProjectPage) => Promise<Project[]>;
}

/**
 * Dependencies arrive in the signature instead of being imported.
 *
 * This is what lets a service test run with no database and no HTTP server, and
 * it is forced by the layer rules rather than chosen per-service: a file named
 * `*.service.ts` cannot import `hono`, so it cannot read `c.get("log")`.
 */
export interface ProjectContext {
	actorId: string;
	log: LogPort;
	repository: ProjectStore;
}

/**
 * Slugs are compared as the user would expect them to be: `"My-Project "` and
 * `"my-project"` are the same project, so normalising before the uniqueness
 * check is the difference between a 409 and two rows that look identical.
 */
const normaliseSlug = (slug: string) => slug.trim().toLowerCase();

/**
 * One page of the actor's projects, newest first.
 *
 * The store is asked for `limit + 1` rows. The extra row is never returned; its
 * mere presence answers "is there another page?" without a second COUNT over
 * the same predicate, which would double the work and could still disagree with
 * the page under a concurrent insert.
 */
export async function listProjects(
	page: ProjectPage,
	ctx: ProjectContext
): Promise<ProjectListing> {
	const rows = await ctx.repository.listByOwner(ctx.actorId, page);
	const items = rows.slice(0, page.limit);
	const last = items.at(-1);

	return {
		items,
		nextCursor:
			rows.length > page.limit && last
				? { createdAt: last.createdAt, id: last.id }
				: null,
	};
}

export async function createProject(
	input: CreateProject,
	ctx: ProjectContext
): Promise<Project> {
	const slug = normaliseSlug(input.slug);
	const created = await ctx.repository.insert({
		...input,
		ownerId: ctx.actorId,
		slug,
	});

	ctx.log.set({ project: { id: created.id, slug: created.slug } });
	return created;
}

/**
 * A project owned by somebody else is reported as missing, not as forbidden.
 * A 403 would confirm the id exists, which is enough to enumerate another
 * tenant's projects one guess at a time.
 */
export async function getProject(
	id: string,
	ctx: ProjectContext
): Promise<Project> {
	const found = await ctx.repository.findById(id);
	if (!found || found.ownerId !== ctx.actorId) {
		throw notFound("Project");
	}

	return found;
}

export async function deleteProject(
	id: string,
	ctx: ProjectContext
): Promise<void> {
	const target = await getProject(id, ctx);
	await ctx.repository.deleteById(target.id);
	ctx.log.set({ project: { deleted: target.id } });
}
