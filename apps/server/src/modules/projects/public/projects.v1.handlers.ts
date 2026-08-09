import { created, ok } from "@keel/http/response";
import type { Context } from "hono";
import type { AppEnv } from "@/lib/context";
import { projectStore } from "../projects.repository";
import {
	createProject,
	getProject,
	listProjects,
	type Project,
	type ProjectContext,
} from "../projects.service";
import type { CreateProjectV1, ProjectV1 } from "./projects.v1.schema";

/**
 * Same service, same repository, different projection.
 *
 * Every field the public contract does not promise is dropped here rather than
 * in the service, so a change to the frontend's needs cannot widen what a
 * customer receives.
 */
const contextOf = (c: Context<AppEnv>): ProjectContext => ({
	actorId: c.get("actorId"),
	log: c.get("log"),
	repository: projectStore,
});

const present = (item: Project): ProjectV1 => ({
	created_at: item.createdAt.toISOString(),
	id: item.id,
	name: item.name,
	slug: item.slug,
});

type CreateContext = Context<
	AppEnv,
	string,
	{ in: { json: CreateProjectV1 }; out: { json: CreateProjectV1 } }
>;
type IdContext = Context<
	AppEnv,
	string,
	{ in: { param: { id: string } }; out: { param: { id: string } } }
>;

export async function list(c: Context<AppEnv>) {
	const items = await listProjects(contextOf(c));
	return ok(c, items.map(present));
}

export async function create(c: CreateContext) {
	const item = await createProject(
		{ ...c.req.valid("json"), description: null },
		contextOf(c)
	);
	return created(c, present(item));
}

export async function get(c: IdContext) {
	const item = await getProject(c.req.valid("param").id, contextOf(c));
	return ok(c, present(item));
}
