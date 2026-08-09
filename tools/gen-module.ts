#!/usr/bin/env bun
/**
 * Scaffolds a server module and registers both of its surfaces.
 *
 * The file set is the part an agent gets wrong: which file may import what is
 * enforced by Biome, so a hand-rolled module fails `bun run check` in ways that
 * are tedious to unpick. What this writes compiles and passes the architecture
 * rules on the first run.
 *
 * It deliberately does not write the domain. Every generated function throws, so
 * a half-finished module cannot be mistaken for a working one.
 */
import { mkdir } from "node:fs/promises";
import { $, Glob } from "bun";

const APP = "apps/server/src/app.ts";
const MODULES = "apps/server/src/modules";

const [, , name] = process.argv;

if (!(name && /^[a-z][a-z0-9-]*$/.test(name))) {
	console.error(
		"usage: bun run gen:module <name>\n\nLowercase, hyphenated, plural — e.g. invoices, api-keys."
	);
	process.exit(1);
}

/** `api-keys` -> `apiKeys`, used for identifiers. */
const camel = name.replace(/-([a-z])/g, (_, letter: string) =>
	letter.toUpperCase()
);
/** `api-keys` -> `ApiKeys`, used for type names. */
const pascal = camel[0]?.toUpperCase() + camel.slice(1);
/** `api-keys` -> `ApiKey`, the singular a resource name reads best as. */
const singular = pascal.endsWith("s") ? pascal.slice(0, -1) : pascal;

const dir = `${MODULES}/${name}`;

if (await Bun.file(`${dir}/index.ts`).exists()) {
	console.error(`${dir} already exists.`);
	process.exit(1);
}

const UNIMPLEMENTED = `throw new Error("${name}: not implemented");`;

const files: Record<string, string> = {
	[`${dir}/${name}.service.ts`]: `import { notFound } from "@keel/http/errors";
import type { LogPort } from "@/lib/log";

/**
 * The domain model. Declared here rather than derived from the Drizzle row: this
 * file may not import @keel/db, which is what keeps a schema change from silently
 * rewriting the business rules.
 *
 * No \`organizationId\` here on purpose. The row has one; nothing in this file may
 * compare it, because tenancy is a WHERE clause in the repository and a field
 * here would invite a check that can be forgotten. \`createdBy\` is display data
 * and nullable: a departing member does not take the organization's work.
 */
export interface ${singular} {
	createdAt: Date;
	createdBy: string | null;
	id: string;
}

/**
 * The persistence this service needs, and nothing more. Every member takes the
 * organization, so a query that forgot the tenant is a type error.
 */
export interface ${singular}Store {
	findById: (id: string, organizationId: string) => Promise<${singular} | undefined>;
	listByOrganization: (organizationId: string) => Promise<${singular}[]>;
}

/**
 * Dependencies arrive in the signature so a unit test needs no database.
 *
 * \`organizationId\` is the tenant every query is scoped to; \`actorId\` is only ever
 * recorded, never used to decide what may be seen. A single-user account is an
 * organization with one member, not a second code path.
 */
export interface ${singular}Context {
	actorId: string;
	log: LogPort;
	organizationId: string;
	repository: ${singular}Store;
}

export async function list${pascal}(ctx: ${singular}Context): Promise<${singular}[]> {
	return await ctx.repository.listByOrganization(ctx.organizationId);
}

/**
 * A resource in another organization is reported as missing, not as forbidden: a
 * 403 confirms the id exists, which is enough to enumerate another tenant's data.
 * There is no ownership comparison here — the store was asked for a row in this
 * organization, so "someone else's" and "absent" arrive as the same undefined.
 */
export async function get${singular}(id: string, ctx: ${singular}Context): Promise<${singular}> {
	const found = await ctx.repository.findById(id, ctx.organizationId);
	if (!found) {
		throw notFound("${singular}");
	}

	return found;
}
`,

	[`${dir}/${name}.repository.ts`]: `// The only file in this module allowed to touch Drizzle.
//
// Return types are inferred from the queries rather than annotated with the
// service's domain type; annotating would mean importing the service and
// inverting the dependency. The structural check happens where the handler
// assembles the context.
//
// Every statement must filter on organizationId in the same and(...) as the id.
// Tenancy that lives in a WHERE clause cannot be skipped by a caller, and it is
// what makes the service's 404 the truth rather than a disguise.

export function listByOrganization(_organizationId: string): Promise<never[]> {
	${UNIMPLEMENTED}
}

export function findById(_id: string, _organizationId: string): Promise<undefined> {
	${UNIMPLEMENTED}
}

/** The assembled store the handlers inject. */
export const ${camel}Store = { findById, listByOrganization };
`,

	[`${dir}/${name}.fixtures.ts`]: `import type { LogPort } from "@/lib/log";
import type { ${singular}, ${singular}Store } from "./${name}.service";

/** Test doubles for the service's two injected dependencies. */

export const ACTOR = "actor-1";
export const ORGANIZATION = "org-1";
export const OTHER_ORGANIZATION = "org-2";

/**
 * A stored row, carrying the tenant the service's domain type deliberately does
 * not. Seeding two organizations is how the fake reproduces the repository's
 * WHERE clause, and therefore how a service test can show that another tenant's
 * row is invisible rather than merely refused.
 */
export interface Seed${singular} extends ${singular} {
	organizationId: string;
}

export const ${camel}Row = (overrides: Partial<Seed${singular}> = {}): Seed${singular} => ({
	createdAt: new Date("2026-01-01T00:00:00.000Z"),
	createdBy: ACTOR,
	id: "r1",
	organizationId: ORGANIZATION,
	...overrides,
});

export function fakeStore(seed: Seed${singular}[] = []): ${singular}Store {
	return {
		findById(id, organizationId) {
			return Promise.resolve(
				seed.find(
					(item) => item.id === id && item.organizationId === organizationId
				)
			);
		},
		listByOrganization(organizationId) {
			return Promise.resolve(
				seed.filter((item) => item.organizationId === organizationId)
			);
		},
	};
}

export function fakeLog(): LogPort {
	return {
		error: () => undefined,
		info: () => undefined,
		set: () => undefined,
		warn: () => undefined,
	};
}
`,

	[`${dir}/${name}.service.test.ts`]: `import { describe, expect, it } from "bun:test";
import { parseError } from "evlog";
import {
	ACTOR,
	fakeLog,
	fakeStore,
	ORGANIZATION,
	OTHER_ORGANIZATION,
	${camel}Row,
} from "./${name}.fixtures";
import { get${singular}, list${pascal}, type ${singular}Context } from "./${name}.service";

const ctx = (seed = [${camel}Row()]): ${singular}Context => ({
	actorId: ACTOR,
	log: fakeLog(),
	organizationId: ORGANIZATION,
	repository: fakeStore(seed),
});

describe("${camel} service", () => {
	it("lists only the active organization's rows", async () => {
		const found = await list${pascal}(ctx([${camel}Row({ id: "ours" }), ${camel}Row({ id: "theirs", organizationId: OTHER_ORGANIZATION })]));

		expect(found.map((item) => item.id)).toEqual(["ours"]);
	});

	// A 403 would confirm the id exists, which is enough to walk another tenant's
	// ids one guess at a time.
	it("reports another organization's row as missing, not forbidden", async () => {
		const thrown = await get${singular}("theirs", ctx([${camel}Row({ id: "theirs", organizationId: OTHER_ORGANIZATION })])).catch(
			(error: unknown) => error
		);

		expect(parseError(thrown).status).toBe(404);
	});
});
`,

	[`${dir}/internal/${name}.schema.ts`]: `import { z } from "zod";

/**
 * The internal surface. Shaped for the frontend in this repo and free to change
 * in the same commit as the component that reads it — no version, no deprecation
 * window.
 *
 * Derive the field shapes from \`@keel/contracts\` once the table exists, so a
 * renamed column stops this file from compiling.
 */

export const ${camel}IdSchema = z.object({
	id: z.uuid(),
});

export const ${camel}Schema = z.object({
	createdAt: z.iso.datetime(),
	createdBy: z.string().nullable(),
	id: z.uuid(),
});

export type ${singular}Response = z.infer<typeof ${camel}Schema>;
`,

	[`${dir}/internal/${name}.handlers.ts`]: `import { ok } from "@keel/http/response";
import type { Context } from "hono";
import type { AppEnv } from "@/lib/context";
import { ${camel}Store } from "../${name}.repository";
import { get${singular}, list${pascal}, type ${singular}, type ${singular}Context } from "../${name}.service";
import type { ${singular}Response } from "./${name}.schema";

/**
 * The composition root for this surface: the only layer that knows both the
 * request and the concrete repository, so it is where the two are joined.
 */
const contextOf = (c: Context<AppEnv>): ${singular}Context => ({
	actorId: c.get("actorId"),
	log: c.get("log"),
	organizationId: c.get("organizationId"),
	repository: ${camel}Store,
});

// Field by field rather than a spread: the stored row carries organizationId at
// runtime even though the domain type does not declare it, so a spread would
// publish the tenancy key. It is redundant anyway — the guard already scoped the
// caller to that organization.
const present = (item: ${singular}): ${singular}Response => ({
	createdAt: item.createdAt.toISOString(),
	createdBy: item.createdBy,
	id: item.id,
});

type IdContext = Context<AppEnv, string, { in: { param: { id: string } }; out: { param: { id: string } } }>;

export async function list(c: Context<AppEnv>) {
	const items = await list${pascal}(contextOf(c));
	return ok(c, items.map(present));
}

export async function get(c: IdContext) {
	const item = await get${singular}(c.req.valid("param").id, contextOf(c));
	return ok(c, present(item));
}
`,

	[`${dir}/internal/${name}.routes.ts`]: `import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireOrg, requireUser } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
import { rejectInvalid } from "@/lib/validate";
import { get, list } from "./${name}.handlers";
import { ${camel}IdSchema } from "./${name}.schema";

/**
 * \`/api/${name}\` — the surface the bundled frontend talks to.
 *
 * Routes are chained so the app type carries every endpoint, which is what makes
 * the typed client possible.
 *
 * \`requireOrg\` follows \`requireUser\` and never precedes it: it only asserts on
 * what the session already resolved, so a signed-in member with no active
 * organization gets a 403 the SPA can route to onboarding, while an anonymous
 * caller still gets the 401 that tells it to sign in.
 */
export const internal${pascal}Routes = new Hono<AppEnv>()
	.use(requireUser)
	.use(requireOrg)
	.get("/", list)
	.get("/:id", zValidator("param", ${camel}IdSchema, rejectInvalid), get);
`,

	[`${dir}/public/${name}.v1.schema.ts`]: `import { z } from "zod";

/**
 * The v1 customer contract. FROZEN.
 *
 * Removing a field, tightening a constraint or renaming anything here breaks
 * integrations that update on their own schedule. Additive changes are allowed;
 * anything else needs a v2 alongside this file.
 *
 * Do not derive this from \`@keel/contracts\`. A frozen contract built from a
 * mutable schema is not frozen.
 */

export const ${camel}V1Schema = z
	.object({
		created_at: z.iso.datetime(),
		id: z.uuid(),
	})
	.meta({ id: "${singular}V1" });

export type ${singular}V1 = z.infer<typeof ${camel}V1Schema>;

export const ${camel}IdV1Schema = z.object({
	id: z.uuid(),
});

export const ${camel}ListV1Schema = z.object({ data: z.array(${camel}V1Schema) });
export const ${camel}V1Envelope = z.object({ data: ${camel}V1Schema });
`,

	[`${dir}/public/${name}.v1.handlers.ts`]: `import type { RouteHandler } from "@hono/zod-openapi";
import { ok } from "@keel/http/response";
import type { Context } from "hono";
import type { AppEnv } from "@/lib/context";
import { ${camel}Store } from "../${name}.repository";
import { get${singular}, list${pascal}, type ${singular}, type ${singular}Context } from "../${name}.service";
import type { get${singular}Route, list${pascal}Route } from "./${name}.v1.routes";
import type { ${singular}V1 } from "./${name}.v1.schema";

/**
 * Same service, same repository, different projection. Fields the public contract
 * does not promise are dropped here rather than in the service, so a change to the
 * frontend's needs cannot widen what a customer receives.
 */
const contextOf = (c: Context<AppEnv>): ${singular}Context => ({
	actorId: c.get("actorId"),
	log: c.get("log"),
	organizationId: c.get("organizationId"),
	repository: ${camel}Store,
});

const present = (item: ${singular}): ${singular}V1 => ({
	created_at: item.createdAt.toISOString(),
	id: item.id,
});

export const list: RouteHandler<typeof list${pascal}Route, AppEnv> = async (c) => {
	const items = await list${pascal}(contextOf(c));
	return ok(c, items.map(present));
};

export const get: RouteHandler<typeof get${singular}Route, AppEnv> = async (c) => {
	const item = await get${singular}(c.req.valid("param").id, contextOf(c));
	return ok(c, present(item));
};
`,

	[`${dir}/public/${name}.v1.routes.ts`]: `import { createRoute, OpenAPIHono } from "@hono/zod-openapi";
import { errorSchema } from "@keel/http/envelope";
import { jsonContent } from "@keel/http/openapi";
import { status } from "@keel/http/status";
import { requireOrg, requireUser } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
import { rejectInvalid } from "@/lib/validate";
import { get, list } from "./${name}.v1.handlers";
import { ${camel}IdV1Schema, ${camel}ListV1Schema, ${camel}V1Envelope } from "./${name}.v1.schema";

/**
 * \`/v1/${name}\` — the customer-facing contract, and the only surface that appears
 * in the OpenAPI document. Every status an operation can return must be listed
 * here, and mirrored in ${name}.v1.contract.test.ts.
 */

const TAGS = ["${pascal}"];
const unauthorized = jsonContent(errorSchema, "No usable credentials");

// Reachable on every operation: the session is valid but no organization is
// active, so there is no tenant to read or write. Declared rather than left to
// surprise an integration, and distinct from 404 — the caller is not being told
// a row is missing, they are being told to pick an organization first.
const forbidden = jsonContent(errorSchema, "The session has no active organization");

export const list${pascal}Route = createRoute({
	method: "get",
	path: "/",
	responses: {
		[status.OK]: jsonContent(${camel}ListV1Schema, "The organization's ${name}"),
		[status.UNAUTHORIZED]: unauthorized,
		[status.FORBIDDEN]: forbidden,
	},
	summary: "List ${name}",
	tags: TAGS,
});

export const get${singular}Route = createRoute({
	method: "get",
	path: "/{id}",
	request: { params: ${camel}IdV1Schema },
	responses: {
		[status.OK]: jsonContent(${camel}V1Envelope, "The ${singular.toLowerCase()}"),
		[status.UNAUTHORIZED]: unauthorized,
		[status.FORBIDDEN]: forbidden,
		[status.NOT_FOUND]: jsonContent(errorSchema, "No such ${singular.toLowerCase()} in this organization"),
		[status.UNPROCESSABLE_ENTITY]: jsonContent(errorSchema, "The id is not a UUID"),
	},
	summary: "Fetch one ${singular.toLowerCase()}",
	tags: TAGS,
});

const surface = new OpenAPIHono<AppEnv>({ defaultHook: rejectInvalid });

// Registered as a statement, not in the chain: Hono's \`.use\` returns \`Hono\`, so
// chaining it would erase \`.openapi\` from the type.
surface.use(requireUser);

// After \`requireUser\`, which resolved the session it reads. A member without an
// active organization is refused here, so no handler below ever runs without a
// tenant to scope its queries to.
surface.use(requireOrg);

export const public${pascal}RoutesV1 = surface.openapi(list${pascal}Route, list).openapi(get${singular}Route, get);
`,

	[`${dir}/index.ts`]: `/**
 * The module's only entry point. Nothing outside this directory may name a file
 * inside it; the layer rules reject both a deep \`@/modules/${name}/...\` import
 * and a relative import that escapes the module.
 */
export { internal${pascal}Routes } from "./internal/${name}.routes";

// Uncomment when you are ready to publish /v1/${name} and hold its shape forever:
// export { public${pascal}RoutesV1 } from "./public/${name}.v1.routes";
`,
};

await Promise.all(
	Object.entries(files).map(async ([path, source]) => {
		await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
		await Bun.write(path, source);
	})
);

// Registering the surfaces is the step that is easy to forget and silent when
// missed: the module compiles, the tests pass, and no request ever reaches it.
const appSource = await Bun.file(APP).text();
// Anchored on statements the formatter cannot reshape, not on formatted text: the
// import list gets wrapped once it grows past the line width, and an anchor that
// depends on that wrapping fails the second time this script runs.
const APP_ANCHOR = "const app = new OpenAPIHono";
const CHAIN_ANCHOR = "const routes = app";

const chainStart = appSource.indexOf(CHAIN_ANCHOR);
const chainEnd = chainStart === -1 ? -1 : appSource.indexOf(";", chainStart);

if (!appSource.includes(APP_ANCHOR) || chainEnd === -1) {
	console.error(
		`Wrote ${Object.keys(files).length} files, but could not register the routes.`
	);
	console.error(
		`${APP} no longer matches the expected shape. Add these by hand:`
	);
	console.error(
		`  import { internal${pascal}Routes } from "@/modules/${name}";`
	);
	console.error(`  .route("/api/${name}", internal${pascal}Routes)`);
	process.exit(1);
}

// Only the internal surface is mounted. The public files are written so the
// pattern is in front of the author, but publishing a /v1 endpoint is a promise
// with no expiry date, so it should take a deliberate edit rather than fall out of
// running a generator.
const mounted = `${appSource.slice(0, chainEnd)}\n\t.route("/api/${name}", internal${pascal}Routes)${appSource.slice(chainEnd)}`;

// The import is placed just above `const app`; `organizeImports` moves it into
// the import block on the format pass below.
await Bun.write(
	APP,
	mounted.replace(
		APP_ANCHOR,
		`import { internal${pascal}Routes } from "@/modules/${name}";\n\n${APP_ANCHOR}`
	)
);

// Formatting here rather than leaving it to the author: an unformatted scaffold
// fails `bun run check` on its first run, which teaches the wrong lesson about
// what the check is for.
await $`bunx biome check --write ${APP} ${dir}`.nothrow().quiet();

const written = new Glob(`${dir}/**/*.ts`);
const count = (await Array.fromAsync(written.scan("."))).length;

console.log(`Created ${count} files in ${dir} and mounted /api/${name}.

Next, in this order:
  1. packages/db/src/schema/${name}.ts, exported from schema/index.ts. It is
     org-scoped like every tenant table: organizationId text notNull references
     organization.id onDelete cascade, createdBy text nullable references user.id
     onDelete "set null", and any unique index keyed on (organizationId, ...).
  2. packages/contracts/src/${name}.ts — derive and .pick() the API's fields.
     Leave organizationId out: the caller is already scoped to one.
  3. replace the throwing bodies in ${name}.repository.ts, filtering every
     statement on organizationId in the same and(...) as the id
  4. bun run check

The generated repository throws on purpose: a half-finished module must not look
like a working one.

public/ is written but NOT mounted. Publishing /v1/${name} is a promise with no
expiry date, so it takes three deliberate steps:
  - .route("/v1/${name}", public${pascal}RoutesV1) in ${APP}
  - export it from ${dir}/index.ts
  - add it to the expected operations in apps/server/src/app.test.ts, and write
    ${name}.v1.contract.test.ts

See .claude/skills/server-module/SKILL.md.`);
