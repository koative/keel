import { z } from "zod";

/**
 * The wire shape of a failure, and the one thing both sides of the network need.
 *
 * It lives in its own module because a browser must be able to read it without
 * importing the server-side helpers: `response.ts` pulls in hono and evlog, and
 * `@keel/http/envelope` pulls in nothing but zod.
 *
 * It is not part of any route's type. Errors are rendered by `app.onError`, which
 * sits outside the route definition, so a typed client knows the success shape and
 * learns the failure shape from here instead.
 *
 * ## RFC 9457
 *
 * `type` and `title` make this a valid Problem Details document, and errors are
 * served as `application/problem+json`. That is what lets an API gateway, an SDK
 * generator or a customer's error-handling library recognise the body without
 * being taught our shape first. `error` is the RFC's extension member, kept so a
 * client reads one nested object rather than a flat bag where our fields and the
 * RFC's sit side by side.
 *
 * Applied to both surfaces, not just `/v1`. The error path is the one place that
 * must never carry a conditional, and no client anywhere cares that the media type
 * is more specific than `application/json`.
 */
export const PROBLEM_CONTENT_TYPE = "application/problem+json";

/** Stable, dereferenceable identity for an error class. Never renamed. */
export const problemType = (code: string) =>
	`https://keel.dev/errors/${code.toLowerCase().replaceAll("_", "-")}`;

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
		status: z.number().int(),
		title: z.string(),
		type: z.string(),
	})
	.meta({ id: "Problem" });

export type ErrorBody = z.infer<typeof errorSchema>;

/**
 * Reads a failure body without trusting it. A 502 from a proxy in front of the app
 * will not carry our envelope, so the status is the fallback.
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
