import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { errorSchema } from "@keel/http/envelope";
import {
	jsonContent,
	jsonContentRequired,
	problemContent,
} from "@keel/http/openapi";
import { status } from "@keel/http/status";
import { requireOrg, requireUser } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
import { idempotent } from "@/lib/idempotency";
import { rateLimit } from "@/lib/rate-limit";
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

// Reachable on every operation: the session is valid but no organization is
// active, so there is no tenant to read or write. Declared rather than left to
// surprise an integration, and distinct from 404 — the caller is not being told
// a project is missing, they are being told to pick an organization first.
const forbidden = problemContent(
	errorSchema,
	"The session has no active organization"
);

// Every operation is behind the actor-keyed limiter, so 429 is reachable from
// any of them. Undeclared, a generated SDK would treat it as an unknown status
// and lose the `Retry-After` the response carries.
const rateLimited = problemContent(
	errorSchema,
	"The actor's request budget for this window is exhausted"
);

// Every endpoint here is behind `requireUser` and `requireOrg`. Stated per route
// rather than as a document-level default so an operation that is ever made
// anonymous has to say so explicitly instead of inheriting silence.
const SECURITY = [{ sessionCookie: [] }];

export const listProjectsRoute = createRoute({
	description:
		"Projects belonging to the active organization, newest first. Pass `meta.nextCursor` back as `cursor` for the following page; a null `nextCursor` is the last page.",
	method: "get",
	path: "/",
	request: {
		query: projectPageV1Schema,
	},
	responses: {
		[status.OK]: jsonContent(projectListV1Schema, "One page of projects"),
		[status.UNAUTHORIZED]: unauthorized,
		[status.FORBIDDEN]: forbidden,
		[status.UNPROCESSABLE_ENTITY]: problemContent(
			errorSchema,
			"The limit is out of range, or the cursor did not come from us"
		),
		[status.TOO_MANY_REQUESTS]: rateLimited,
	},
	security: SECURITY,
	summary: "List projects",
	tags: TAGS,
});

export const createProjectRoute = createRoute({
	description:
		"Slugs are unique per organization, so two organizations may both use `billing`.",
	method: "post",
	path: "/",
	request: {
		body: jsonContentRequired(createProjectV1Schema, "The project to create"),
	},
	responses: {
		[status.CREATED]: jsonContent(projectV1Envelope, "The created project"),
		[status.UNAUTHORIZED]: unauthorized,
		[status.FORBIDDEN]: forbidden,
		[status.CONFLICT]: problemContent(
			errorSchema,
			"This organization already has a project with that slug"
		),
		[status.PAYLOAD_TOO_LARGE]: problemContent(
			errorSchema,
			"The body is larger than this deployment's BODY_LIMIT_BYTES"
		),
		[status.UNPROCESSABLE_ENTITY]: problemContent(
			errorSchema,
			"The body failed validation"
		),
		[status.TOO_MANY_REQUESTS]: rateLimited,
	},
	security: SECURITY,
	summary: "Create a project",
	tags: TAGS,
});

export const getProjectRoute = createRoute({
	description:
		"A project belonging to another organization is reported as missing, not as forbidden.",
	method: "get",
	path: "/{id}",
	request: {
		params: projectIdV1Schema,
	},
	responses: {
		[status.OK]: jsonContent(projectV1Envelope, "The project"),
		[status.UNAUTHORIZED]: unauthorized,
		[status.FORBIDDEN]: forbidden,
		[status.NOT_FOUND]: problemContent(
			errorSchema,
			"No such project in this organization"
		),
		[status.UNPROCESSABLE_ENTITY]: problemContent(
			errorSchema,
			"The id is not a UUID"
		),
		[status.TOO_MANY_REQUESTS]: rateLimited,
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

// Immediately after `requireUser`, which is what puts the actor this is keyed on
// onto the context, and deliberately before `requireOrg`: a caller already over
// budget is refused without spending a membership query on them.
surface.use(rateLimit);

// After `requireUser`, which resolved the session it reads. A member without an
// active organization is refused here rather than deeper down, so no handler
// below ever runs without a tenant to scope its queries to.
surface.use(requireOrg);

// After both guards, because a key is scoped to the actor — a global key space
// would let one tenant probe another's. Method-scoped rather than `use`, so a GET
// is never stored and replayed.
surface.on("POST", "*", idempotent);

export const publicProjectRoutesV1 = surface
	.openapi(listProjectsRoute, list)
	.openapi(createProjectRoute, create)
	.openapi(getProjectRoute, get);
