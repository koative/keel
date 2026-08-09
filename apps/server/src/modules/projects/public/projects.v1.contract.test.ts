import { describe, expect, it } from "bun:test";
import { z } from "zod";
import { createProjectV1Schema, projectV1Schema } from "./projects.v1.schema";

/**
 * The frozen v1 contract, written out rather than snapshotted to a file.
 *
 * A `__snapshots__` entry can be re-blessed with `bun test -u` without anyone
 * reading the diff, which is precisely the accident this test exists to prevent.
 * Spelled out here, breaking a customer's integration requires editing the
 * expectation by hand, in a diff a reviewer sees.
 *
 * Zod's emitted `pattern` for `uuid` and `date-time` is dropped: which regex Zod
 * generates for a format is Zod's business and changes on a patch bump, while
 * `format: "uuid"` is the promise we actually made.
 */
type JsonSchemaNode = Record<string, unknown>;

function contractOf(schema: z.ZodType): JsonSchemaNode {
	const strip = (node: unknown): unknown => {
		if (Array.isArray(node)) {
			return node.map(strip);
		}
		if (node === null || typeof node !== "object") {
			return node;
		}

		const result: JsonSchemaNode = {};
		for (const [key, value] of Object.entries(node)) {
			if (key === "pattern" || key === "$schema") {
				continue;
			}
			result[key] = strip(value);
		}
		return result;
	};

	return strip(z.toJSONSchema(schema)) as JsonSchemaNode;
}

describe("v1 project contract", () => {
	it("exposes exactly four fields, all required, nothing extra", () => {
		expect(contractOf(projectV1Schema)).toEqual({
			additionalProperties: false,
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
		expect(contractOf(createProjectV1Schema)).toEqual({
			additionalProperties: false,
			properties: {
				name: { maxLength: 120, minLength: 1, type: "string" },
				slug: { maxLength: 60, minLength: 1, type: "string" },
			},
			required: ["name", "slug"],
			type: "object",
		});
	});

	// The public slug rule is stricter than the internal one, which accepts
	// mixed case. Loosening it here would be an additive change; tightening it
	// later would reject bodies a customer is already sending.
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
