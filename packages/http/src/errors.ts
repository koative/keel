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
