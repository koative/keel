import { z } from "zod";

/**
 * The wire shape of a failure, and the one thing both sides of the network need.
 *
 * It lives in its own module because a browser must be able to read it without
 * importing the server-side helpers: `response.ts` pulls in hono and evlog, and
 * `@keel/http/envelope` pulls in nothing but zod.
 *
 * It is not part of any route's type. Errors are rendered by `app.onError`, which
 * sits outside the route definition, so a typed client knows the success shape
 * and learns the failure shape from here instead.
 */
export const errorSchema = z
	.object({
		error: z.object({
			code: z.string(),
			fix: z.string().optional(),
			link: z.string().optional(),
			message: z.string(),
			requestId: z.string(),
			why: z.string().optional(),
		}),
	})
	.meta({ id: "Error" });

export type ErrorBody = z.infer<typeof errorSchema>;

/**
 * Reads a failure body without trusting it. A 502 from a proxy in front of the
 * app will not carry our envelope, so the status is the fallback.
 */
export function readError(body: unknown, status: number): ErrorBody["error"] {
	const parsed = errorSchema.safeParse(body);
	if (parsed.success) {
		return parsed.data.error;
	}

	return {
		code: "INTERNAL_SERVER_ERROR",
		message: `Request failed with status ${status}`,
		requestId: "unknown",
		why: "The response did not carry the expected error envelope",
	};
}
