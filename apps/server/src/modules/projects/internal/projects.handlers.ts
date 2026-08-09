import { created, noContent, ok, page } from "@keel/http/response";
import type { Context } from "hono";
import type { AppEnv } from "@/lib/context";
import { encodeCursor } from "@/lib/cursor";
import { projectStore } from "../projects.repository";
import {
	createProject,
	deleteProject,
	getProject,
	listProjects,
	type Project,
	type ProjectContext,
} from "../projects.service";
import type {
	CreateProjectInput,
	CreateProjectOutput,
	ProjectPageQuery,
	ProjectResponse,
} from "./projects.schema";

/**
 * The composition root for this surface.
 *
 * The handler is the only layer that knows both the request — who the actor is,
 * which logger belongs to it — and the concrete repository, so it is where the
 * two are joined. The arrow `handlers -> service -> repository` says which file
 * may name which; wiring necessarily runs the other way.
 */
const contextOf = (c: Context<AppEnv>): ProjectContext => ({
	actorId: c.get("actorId"),
	log: c.get("log"),
	organizationId: c.get("organizationId"),
	repository: projectStore,
});

/**
 * The internal surface returns the row, with timestamps serialised.
 *
 * Field by field rather than a spread: the stored row carries `organizationId`
 * at runtime even though the service's `Project` does not declare it, so a
 * spread would publish the tenancy key that the type says is not there. It is
 * also redundant — the guard already scoped the caller to that organization.
 */
const present = (item: Project): ProjectResponse => ({
	createdAt: item.createdAt.toISOString(),
	createdBy: item.createdBy,
	description: item.description,
	id: item.id,
	name: item.name,
	slug: item.slug,
	updatedAt: item.updatedAt.toISOString(),
});

type CreateContext = Context<
	AppEnv,
	string,
	{ in: { json: CreateProjectInput }; out: { json: CreateProjectOutput } }
>;
type IdContext = Context<
	AppEnv,
	string,
	{ in: { param: { id: string } }; out: { param: { id: string } } }
>;
type ListContext = Context<
	AppEnv,
	string,
	{ in: { query: Record<string, string> }; out: { query: ProjectPageQuery } }
>;

export async function list(c: ListContext) {
	const query = c.req.valid("query");
	const listing = await listProjects(
		{ cursor: query.cursor ?? null, limit: query.limit },
		contextOf(c)
	);

	return page(c, listing.items.map(present), {
		nextCursor: listing.nextCursor && encodeCursor(listing.nextCursor),
	});
}

export async function create(c: CreateContext) {
	const item = await createProject(c.req.valid("json"), contextOf(c));
	return created(c, present(item));
}

export async function get(c: IdContext) {
	const item = await getProject(c.req.valid("param").id, contextOf(c));
	return ok(c, present(item));
}

export async function remove(c: IdContext) {
	await deleteProject(c.req.valid("param").id, contextOf(c));
	return noContent(c);
}
