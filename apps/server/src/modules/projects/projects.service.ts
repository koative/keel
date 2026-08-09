import { notFound } from "@keel/http/errors";
import type { LogPort } from "@/lib/log";

/**
 * The domain model. Deliberately declared here rather than derived from the
 * Drizzle row type: this file may not import `@keel/db`, which is exactly what
 * keeps a schema change from silently rewriting the business rules. The
 * repository satisfies it structurally, so the mismatch surfaces at the wiring
 * site with a type error.
 *
 * `organizationId` is absent on purpose. The row has one, but nothing in this
 * file may compare it: tenancy is a WHERE clause in the repository, and a field
 * here would be an invitation to re-check it in a branch that can be forgotten.
 * `createdBy` is present because it is display data — which member added this —
 * and is nullable because a departing member does not take the row with them.
 */
export interface Project {
	createdAt: Date;
	createdBy: string | null;
	description: string | null;
	id: string;
	name: string;
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

/**
 * The persistence this service needs, and nothing more.
 *
 * Every member takes the organization, because every statement is scoped by it.
 * Making it an argument rather than something the repository reads for itself is
 * what lets the type checker catch a query that forgot the tenant.
 */
export interface ProjectStore {
	deleteById: (id: string, organizationId: string) => Promise<void>;
	findById: (
		id: string,
		organizationId: string
	) => Promise<Project | undefined>;
	insert: (
		input: CreateProject & { createdBy: string | null; organizationId: string }
	) => Promise<Project>;
	listByOrganization: (
		organizationId: string,
		page: ProjectPage
	) => Promise<Project[]>;
}

/**
 * Dependencies arrive in the signature instead of being imported.
 *
 * This is what lets a service test run with no database and no HTTP server, and
 * it is forced by the layer rules rather than chosen per-service: a file named
 * `*.service.ts` cannot import `hono`, so it cannot read `c.get("log")`.
 *
 * `organizationId` is the tenant every query is scoped to; `actorId` is only ever
 * recorded, never used to decide what may be seen. A single-user account is an
 * organization with one member, so there is no second code path for it.
 */
export interface ProjectContext {
	actorId: string;
	log: LogPort;
	organizationId: string;
	repository: ProjectStore;
}

/**
 * Slugs are compared as the user would expect them to be: `"My-Project "` and
 * `"my-project"` are the same project, so normalising before the uniqueness
 * check is the difference between a 409 and two rows that look identical.
 */
const normaliseSlug = (slug: string) => slug.trim().toLowerCase();

/**
 * One page of the organization's projects, newest first.
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
	const rows = await ctx.repository.listByOrganization(
		ctx.organizationId,
		page
	);
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
		createdBy: ctx.actorId,
		organizationId: ctx.organizationId,
		slug,
	});

	ctx.log.set({ project: { id: created.id, slug: created.slug } });
	return created;
}

/**
 * A project belonging to another organization is reported as missing, not as
 * forbidden. A 403 would confirm the id exists, which is enough to enumerate
 * another tenant's projects one guess at a time.
 *
 * Note there is no ownership comparison here: the store is asked for a row in
 * this organization, so "belongs to someone else" and "does not exist" arrive
 * as the same `undefined`, and the safe answer is the only answer available.
 */
export async function getProject(
	id: string,
	ctx: ProjectContext
): Promise<Project> {
	const found = await ctx.repository.findById(id, ctx.organizationId);
	if (!found) {
		throw notFound("Project");
	}

	return found;
}

export async function deleteProject(
	id: string,
	ctx: ProjectContext
): Promise<void> {
	const target = await getProject(id, ctx);
	await ctx.repository.deleteById(target.id, ctx.organizationId);
	ctx.log.set({ project: { deleted: target.id } });
}
