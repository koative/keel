import type { RouteHandler } from "@hono/zod-openapi";
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
import type {
	createProjectRoute,
	getProjectRoute,
	listProjectsRoute,
} from "./projects.v1.routes";
import type { ProjectV1 } from "./projects.v1.schema";

/**
 * Same service, same repository, different projection.
 *
 * Every field the public contract does not promise is dropped here rather than in
 * the service, so a change to the frontend's needs cannot widen what a customer
 * receives.
 *
 * `RouteHandler<typeof route>` is a type-only import from the routes file. The
 * value dependency still runs routes -> handlers; this is the type flowing back
 * so `c.req.valid()` and the response status are checked against the published
 * contract.
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

export const list: RouteHandler<typeof listProjectsRoute, AppEnv> = async (
	c
) => {
	const items = await listProjects(contextOf(c));
	return ok(c, items.map(present));
};

export const create: RouteHandler<typeof createProjectRoute, AppEnv> = async (
	c
) => {
	const item = await createProject(
		{ ...c.req.valid("json"), description: null },
		contextOf(c)
	);
	return created(c, present(item));
};

export const get: RouteHandler<typeof getProjectRoute, AppEnv> = async (c) => {
	const item = await getProject(c.req.valid("param").id, contextOf(c));
	return ok(c, present(item));
};
