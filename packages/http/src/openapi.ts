import type { ZodType } from "zod";

/**
 * The two shapes `@hono/zod-openapi` needs for a `responses` or `request.body`
 * entry. Written by hand rather than pulled from a helper package so the object
 * literal stays visible: a route definition is a contract, and hiding its shape
 * behind a dependency makes the contract harder to read.
 */

export const jsonContent = <T extends ZodType>(
	schema: T,
	description: string
) => ({
	content: { "application/json": { schema } },
	description,
});

export const jsonContentRequired = <T extends ZodType>(
	schema: T,
	description: string
) => ({
	content: { "application/json": { schema } },
	description,
	required: true,
});
