import type { ZodType } from "zod";
import { PROBLEM_CONTENT_TYPE } from "./envelope";

/**
 * The shapes `@hono/zod-openapi` needs for a `responses` or `request.body` entry.
 * Written by hand rather than pulled from a helper package so the object literal
 * stays visible: a route definition is a contract, and hiding its shape behind a
 * dependency makes the contract harder to read.
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

/**
 * Errors are served as `application/problem+json` (RFC 9457), so the document has
 * to say so — a generated SDK matches on the declared media type, and declaring
 * `application/json` for a body we do not send is a lie in the contract.
 */
export const problemContent = <T extends ZodType>(
	schema: T,
	description: string
) => ({
	content: { [PROBLEM_CONTENT_TYPE]: { schema } },
	description,
});
