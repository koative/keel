import type { StatusCode } from "hono/utils/http-status";

/**
 * The status codes this project actually emits — not the full HTTP registry.
 *
 * Deliberately a frozen object literal rather than an enum: `@hono/zod-openapi`
 * keys its `responses` map by numeric literal, and an enum member widens to
 * `number` there. `as const satisfies` keeps every value a literal type while
 * still failing the build if one of them stops being a status Hono recognises.
 */
export const status = {
	BAD_REQUEST: 400,
	CONFLICT: 409,
	CREATED: 201,
	FORBIDDEN: 403,
	INTERNAL_SERVER_ERROR: 500,
	NO_CONTENT: 204,
	NOT_FOUND: 404,
	OK: 200,
	PAYLOAD_TOO_LARGE: 413,
	SERVICE_UNAVAILABLE: 503,
	TOO_MANY_REQUESTS: 429,
	UNAUTHORIZED: 401,
	UNPROCESSABLE_ENTITY: 422,
} as const satisfies Record<string, StatusCode>;

/** Machine-readable error codes are exactly the names above. */
export type ErrorCode = keyof typeof status;
