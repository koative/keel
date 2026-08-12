import { describe, expect, it } from "bun:test";
import { app } from "@/app";
import { createProjectV1Schema, projectV1Schema } from "./projects.v1.schema";

/**
 * The frozen v1 contract, asserted against the OpenAPI document customers
 * consume — written out rather than snapshotted, because a `__snapshots__`
 * entry can be re-blessed with `bun test -u` without anyone reading the diff.
 * `pattern` is dropped: Zod's regex for `uuid` changes on a patch bump, while
 * `format: "uuid"` is the promise we made.
 */
type Json = Record<string, unknown>;

const withoutPatterns = (node: unknown): unknown => {
	if (Array.isArray(node)) {
		return node.map(withoutPatterns);
	}
	if (node === null || typeof node !== "object") {
		return node;
	}
	return Object.fromEntries(
		Object.entries(node)
			.filter(([key]) => key !== "pattern")
			.map(([key, value]) => [key, withoutPatterns(value)])
	);
};

interface Operation {
	parameters?: Json[];
	responses: Record<string, { content?: Record<string, Json> }>;
	security: Json[];
}

/**
 * The expected paths are written into the type, not looked up defensively: an
 * optional-chained index would put Biome and `noUncheckedIndexedAccess` in
 * direct disagreement, and the assertions below prove they are still there.
 */
const document = (await (await app.request("/doc")).json()) as {
	components: { schemas: Record<string, Json> };
	paths: {
		"/v1/projects": { get: Operation; post: Operation };
		"/v1/projects/{id}": { get: Operation };
	};
};

const PROBLEM = "application/problem+json";

const operations: Record<string, Operation> = {
	"GET /v1/projects": document.paths["/v1/projects"].get,
	"GET /v1/projects/{id}": document.paths["/v1/projects/{id}"].get,
	"POST /v1/projects": document.paths["/v1/projects"].post,
};

describe("the published v1 contract", () => {
	it.each([
		["GET /v1/projects", ["200", "401", "403", "422", "429"]],
		["POST /v1/projects", ["201", "401", "403", "409", "413", "422", "429"]],
		["GET /v1/projects/{id}", ["200", "401", "403", "404", "422", "429"]],
	])("%s is behind the session and declares its statuses", (name, expected) => {
		expect(operations[name]?.security).toEqual([{ sessionCookie: [] }]);
		expect(Object.keys(operations[name]?.responses ?? {})).toEqual(expected);
	});

	// A generated SDK matches on the declared media type. Errors are RFC 9457
	// documents, so declaring `application/json` for one would send every
	// consumer looking for a content type this API never sends. 429 is called out
	// because it is the one every operation shares: `/v1` is rate limited as a
	// whole, so a reader can exhaust its budget just as a writer can.
	it.each(Object.keys(operations))("%s serves failures as problems", (name) => {
		const failures = Object.entries(operations[name]?.responses ?? {}).filter(
			([code]) => !code.startsWith("2")
		);
		expect(failures.map(([code]) => code)).toContain("429");
		expect(failures.map(([, body]) => Object.keys(body.content ?? {}))).toEqual(
			failures.map(() => [PROBLEM])
		);
	});

	it("publishes limit and cursor as query parameters on the list", () => {
		expect(
			withoutPatterns(document.paths["/v1/projects"].get.parameters)
		).toEqual([
			{
				in: "query",
				name: "cursor",
				required: false,
				schema: { type: "string" },
			},
			{
				in: "query",
				name: "limit",
				required: false,
				schema: { default: 25, maximum: 100, minimum: 1, type: "integer" },
			},
		]);
	});

	// Published under a name rather than inlined: a generated SDK gets a
	// reusable `ProjectListV1`, so the name itself is part of the contract.
	it("returns the page token beside the list data", () => {
		expect(
			Object.values(document.paths["/v1/projects"].get.responses).map(
				(response) => response.content
			)
		).toContainEqual({
			"application/json": {
				schema: { $ref: "#/components/schemas/ProjectListV1" },
			},
		});

		expect(withoutPatterns(document.components.schemas.ProjectListV1)).toEqual({
			properties: {
				data: {
					items: { $ref: "#/components/schemas/ProjectV1" },
					type: "array",
				},
				meta: {
					properties: { nextCursor: { nullable: true, type: "string" } },
					required: ["nextCursor"],
					type: "object",
				},
			},
			required: ["data", "meta"],
			type: "object",
		});
	});

	it("exposes exactly four fields, all required, and nothing else", () => {
		expect(withoutPatterns(document.components.schemas.ProjectV1)).toEqual({
			properties: {
				created_at: { format: "date-time", type: "string" },
				id: { format: "uuid", type: "string" },
				name: { type: "string" },
				slug: { type: "string" },
			},
			required: ["created_at", "id", "name", "slug"],
			type: "object",
		});
	});

	// Promising an internal identifier or a mutation timestamp means forever. The
	// tenant id is on the list too: a caller is already scoped to one
	// organization, so publishing it would freeze a field that says nothing.
	it.each([
		"createdBy",
		"created_by",
		"organizationId",
		"organization_id",
		"ownerId",
		"owner_id",
		"updatedAt",
		"updated_at",
		"description",
	])("does not leak %s", (field) => {
		expect(Object.keys(projectV1Schema.shape)).not.toContain(field);
	});

	it("accepts exactly name and slug on create, with the published bounds", () => {
		expect(
			withoutPatterns(document.components.schemas.CreateProjectV1)
		).toEqual({
			properties: {
				name: { maxLength: 120, minLength: 1, type: "string" },
				slug: { maxLength: 60, minLength: 1, type: "string" },
			},
			required: ["name", "slug"],
			type: "object",
		});
	});

	// Stricter than the internal rule, which accepts mixed case. Loosening this
	// later is additive; tightening it rejects bodies a customer already sends.
	it.each([
		["billing", true],
		["billing-eu", true],
		["Billing", false],
		["billing--eu", false],
		["-billing", false],
		["billing eu", false],
	])("treats slug %p as valid=%p", (slug, valid) => {
		expect(
			createProjectV1Schema.safeParse({ name: "Billing", slug }).success
		).toBe(valid);
	});

	it("publishes the error envelope once, as a Problem Details document", () => {
		expect(withoutPatterns(document.components.schemas.Problem)).toEqual({
			properties: {
				error: {
					properties: {
						code: { type: "string" },
						fix: { type: "string" },
						link: { type: "string" },
						message: { type: "string" },
						requestId: { type: "string" },
						why: { type: "string" },
					},
					required: ["code", "message", "requestId"],
					type: "object",
				},
				status: { type: "integer" },
				title: { type: "string" },
				type: { type: "string" },
			},
			required: ["error", "status", "title", "type"],
			type: "object",
		});
	});
});
