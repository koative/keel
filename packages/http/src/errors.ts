import { createError } from "evlog";
import { status } from "./status";

/**
 * Thin factories over evlog's `createError`.
 *
 * There is deliberately no bespoke `AppError` class: one error system means the
 * wide event and the HTTP envelope can never disagree about what went wrong.
 * `why` and `fix` are mandatory in practice — they are rendered to the client,
 * so an error explains itself without the caller reading our source.
 *
 * This module imports neither `hono` nor `@keel/db`, which is what lets the
 * service layer throw these without reaching across a layer boundary.
 */

export const notFound = (resource: string) =>
	createError({
		code: "NOT_FOUND",
		fix: "Check the identifier and retry, or list the collection to discover valid ones",
		message: `${resource} not found`,
		status: status.NOT_FOUND,
		why: `No ${resource.toLowerCase()} matched the given identifier`,
	});

export const conflict = (resource: string, field: string) =>
	createError({
		code: "CONFLICT",
		fix: `Choose a different ${field}`,
		message: `${resource} with this ${field} already exists`,
		status: status.CONFLICT,
		why: `${field} must be unique across all ${resource.toLowerCase()}s`,
	});

export const forbidden = (action: string) =>
	createError({
		code: "FORBIDDEN",
		fix: "Request access from an account that owns this resource",
		message: `Not allowed to ${action}`,
		status: status.FORBIDDEN,
		why: "The authenticated actor lacks permission for this resource",
	});

export const unauthorized = () =>
	createError({
		code: "UNAUTHORIZED",
		fix: "Sign in and send the session cookie, or attach a valid bearer token",
		message: "Authentication required",
		status: status.UNAUTHORIZED,
		why: "The request carried no usable credentials",
	});

export const validationFailed = (detail: string) =>
	createError({
		code: "UNPROCESSABLE_ENTITY",
		fix: "Correct the highlighted fields and resend",
		message: "Request body failed validation",
		status: status.UNPROCESSABLE_ENTITY,
		why: detail,
	});

export const badRequest = (detail: string) =>
	createError({
		code: "BAD_REQUEST",
		fix: "Compare the request against the endpoint's schema",
		message: "Malformed request",
		status: status.BAD_REQUEST,
		why: detail,
	});

/**
 * The body is larger than this deployment accepts. Distinct from a 400: the
 * request is not malformed, and distinct from a 422: nothing about its contents
 * was read, let alone rejected. The caller is being told a size, so the size is
 * in the message — an error that says "too large" without saying "than what"
 * leaves them guessing at a number only the server knows.
 *
 * `BODY_LIMIT_BYTES` is a deployment's own setting, so this is a limit the
 * caller can ask to have raised rather than a fact about the protocol.
 */
export const payloadTooLarge = (limitBytes: number) =>
	createError({
		code: "PAYLOAD_TOO_LARGE",
		fix: `Send at most ${limitBytes} bytes, or split the payload across several requests`,
		message: "Request body too large",
		status: status.PAYLOAD_TOO_LARGE,
		why: `The request body exceeds the ${limitBytes} byte limit this deployment accepts`,
	});

/**
 * A dependency the request needs is not reachable. Distinct from a 500: nothing
 * is broken in our code, so a caller — or an orchestrator's readiness probe — is
 * right to retry rather than escalate.
 */
export const serviceUnavailable = (reason: string) =>
	createError({
		code: "SERVICE_UNAVAILABLE",
		fix: "Retry shortly; this clears without intervention once the dependency recovers",
		message: "Temporarily unavailable",
		status: status.SERVICE_UNAVAILABLE,
		why: reason,
	});

/**
 * The caller is over its budget. Distinct from a 403: nothing about who they are
 * is wrong, only how often, so the same request succeeds later untouched.
 *
 * `retryAfterSeconds` is carried on the error rather than set as a header here,
 * because this factory has no response to attach one to — the single `failure`
 * translation does that, which is the same reason every other status travels as a
 * thrown value.
 */
export const tooManyRequests = (retryAfterSeconds: number) =>
	createError({
		code: "TOO_MANY_REQUESTS",
		fix: `Wait ${retryAfterSeconds}s and retry; slow the caller down if this repeats`,
		message: "Too many requests",
		status: status.TOO_MANY_REQUESTS,
		why: `Rate limit exceeded; the budget refills in ${retryAfterSeconds}s`,
	});
