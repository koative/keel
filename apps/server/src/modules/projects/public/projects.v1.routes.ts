import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { errorSchema } from "@keel/http/envelope";
import {
	jsonContent,
	jsonContentRequired,
	problemContent,
} from "@keel/http/openapi";
import { status } from "@keel/http/status";
import { requireUser } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
import { idempotent } from "@/lib/idempotency";
import { rejectInvalid } from "@/lib/validate";
import { create, get, list } from "./projects.v1.handlers";
import {
	createProjectV1Schema,
	projectIdV1Schema,
	projectListV1Schema,
	projectPageV1Schema,
	projectV1Envelope,
} from "./projects.v1.schema";

/**
 * `/v1/projects` — the customer-facing contract, and the only surface that
 * appears in the OpenAPI document.
 *
 * Deliberately fewer endpoints than `internal/`: there is no DELETE here yet,
 * because publishing one commits us to its semantics forever. Adding an endpoint
 * later is additive and safe; removing one is not.
 */

const TAGS = ["Projects"];

// Errors are `application/problem+json`, so every failure is declared with
// `problemContent`. Declaring `application/json` for a body we do not send
// would make a generated SDK look for a content type that never arrives.
const unauthorized = problemContent(errorSchema, "No usable credentials");

// Every endpoint here is behind `requireUser`. Stated per route rather than as a
// document-level default so an operation that is ever made anonymous has to say
// so explicitly instead of inheriting silence.
const SECURITY = [{ sessionCookie: [] }];

export const listProjectsRoute = createRoute({
	description:
		"Projects owned by the authenticated actor, newest first. Pass `meta.nextCursor` back as `cursor` for the following page; a null `nextCursor` is the last page.",
	method: "get",
	path: "/",
	request: {
		query: projectPageV1Schema,
	},
	responses: {
		[status.OK]: jsonContent(projectListV1Schema, "One page of projects"),
		[status.UNAUTHORIZED]: unauthorized,
		[status.UNPROCESSABLE_ENTITY]: problemContent(
			errorSchema,
			"The limit is out of range, or the cursor did not come from us"
		),
	},
	security: SECURITY,
	summary: "List projects",
	tags: TAGS,
});

export const createProjectRoute = createRoute({
	description:
		"Slugs are unique per owner, so two accounts may both use `billing`.",
	method: "post",
	path: "/",
	request: {
		body: jsonContentRequired(createProjectV1Schema, "The project to create"),
	},
	responses: {
		[status.CREATED]: jsonContent(projectV1Envelope, "The created project"),
		[status.UNAUTHORIZED]: unauthorized,
		[status.CONFLICT]: problemContent(
			errorSchema,
			"This owner already has a project with that slug"
		),
		[status.UNPROCESSABLE_ENTITY]: problemContent(
			errorSchema,
			"The body failed validation"
		),
	},
	security: SECURITY,
	summary: "Create a project",
	tags: TAGS,
});

export const getProjectRoute = createRoute({
	description:
		"A project owned by another account is reported as missing, not as forbidden.",
	method: "get",
	path: "/{id}",
	request: {
		params: projectIdV1Schema,
	},
	responses: {
		[status.OK]: jsonContent(projectV1Envelope, "The project"),
		[status.UNAUTHORIZED]: unauthorized,
		[status.NOT_FOUND]: problemContent(
			errorSchema,
			"No such project for this owner"
		),
		[status.UNPROCESSABLE_ENTITY]: problemContent(
			errorSchema,
			"The id is not a UUID"
		),
	},
	security: SECURITY,
	summary: "Fetch one project",
	tags: TAGS,
});

// `defaultHook` is the single translation from a validation failure to a 422 for
// every route below, replacing the per-validator hook the internal surface needs.
const surface = new OpenAPIHono<AppEnv>({ defaultHook: rejectInvalid });

// Registered as a statement, not in the chain: Hono's `.use` returns `Hono`, so
// chaining it would erase `.openapi` from the type. Middleware contributes
// nothing to the schema, so nothing is lost by splitting it out.
surface.use(requireUser);

// After `requireUser`, because a key is scoped to the actor — a global key space
// would let one tenant probe another's. Method-scoped rather than `use`, so a GET
// is never stored and replayed.
surface.on("POST", "*", idempotent);

export const publicProjectRoutesV1 = surface
	.openapi(listProjectsRoute, list)
	.openapi(createProjectRoute, create)
	.openapi(getProjectRoute, get);
