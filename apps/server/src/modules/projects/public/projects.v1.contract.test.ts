import { describe, expect, it } from "bun:test";
import { app } from "@/app";
import { createProjectV1Schema, projectV1Schema } from "./projects.v1.schema";

/**
 * The frozen v1 contract, asserted against the OpenAPI document customers
 * actually consume — and written out rather than snapshotted to a file.
 *
 * A `__snapshots__` entry can be re-blessed with `bun test -u` without anyone
 * reading the diff, which is precisely the accident this test exists to prevent.
 * Spelled out here, breaking an integration means editing an expectation by hand,
 * in a diff a reviewer sees.
 *
 * `pattern` is dropped from the comparison: which regex Zod emits for `uuid` or
 * `date-time` is Zod's business and changes on a patch bump, while
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
	responses: Record<string, unknown>;
}

/**
 * The expected paths are written into the type, not looked up defensively. An
 * optional-chained index would put Biome and `noUncheckedIndexedAccess` in
 * direct disagreement, and the runtime assertion below is what actually proves
 * the document still has these operations.
 */
const document = (await (await app.request("/doc")).json()) as {
	components: { schemas: Record<string, Json> };
	paths: {
		"/v1/projects": { get: Operation; post: Operation };
		"/v1/projects/{id}": { get: Operation };
	};
};

describe("published surface", () => {
	it("declares every status each operation can return", () => {
		expect(Object.keys(document.paths["/v1/projects"].get.responses)).toEqual([
			"200",
			"401",
		]);
		expect(Object.keys(document.paths["/v1/projects"].post.responses)).toEqual([
			"201",
			"401",
			"409",
			"422",
		]);
		expect(
			Object.keys(document.paths["/v1/projects/{id}"].get.responses)
		).toEqual(["200", "401", "404", "422"]);
	});
});

describe("v1 project schema", () => {
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

	// The internal surface has these. Promising them publicly would mean
	// maintaining an owner identifier and a mutation timestamp forever.
	it.each(["ownerId", "owner_id", "updatedAt", "updated_at", "description"])(
		"does not leak %s",
		(field) => {
			expect(Object.keys(projectV1Schema.shape)).not.toContain(field);
		}
	);

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

	// The public slug rule is stricter than the internal one, which accepts mixed
	// case. Loosening it later is additive; tightening it would reject bodies a
	// customer is already sending.
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
});

describe("error envelope", () => {
	it("is published once and shared by every failure", () => {
		expect(withoutPatterns(document.components.schemas.Error)).toEqual({
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
			},
			required: ["error"],
			type: "object",
		});
	});
});
