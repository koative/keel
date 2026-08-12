import { type AuditableLogger, type EvlogError, parseError } from "evlog";
import type { Context, MiddlewareHandler } from "hono";
import { PROBLEM_CONTENT_TYPE, problemType } from "./envelope";
import {
	badRequest as badRequestError,
	conflict as conflictError,
	notFound as notFoundError,
	serviceUnavailable as serviceUnavailableError,
} from "./errors";
import { type ErrorCode, status } from "./status";

// Declared here so every helper can read `c.get("log")` without threading an Env
// generic through each handler. Optional on purpose: the variable exists only
// after evlog's middleware has run, and these helpers *are* the error path — the
// one place that must never be the thing that throws. An app typed as
// `Hono<EvlogVariables>` still sees evlog's own non-optional declaration.
declare module "hono" {
	interface ContextVariableMap {
		log?: AuditableLogger;
	}
}

/** Every error status this app can emit, keyed by the code the client receives. */
const ERROR_CODE_BY_STATUS = {
	[status.BAD_REQUEST]: "BAD_REQUEST",
	[status.UNAUTHORIZED]: "UNAUTHORIZED",
	[status.FORBIDDEN]: "FORBIDDEN",
	[status.NOT_FOUND]: "NOT_FOUND",
	[status.CONFLICT]: "CONFLICT",
	[status.PAYLOAD_TOO_LARGE]: "PAYLOAD_TOO_LARGE",
	[status.UNPROCESSABLE_ENTITY]: "UNPROCESSABLE_ENTITY",
	[status.TOO_MANY_REQUESTS]: "TOO_MANY_REQUESTS",
	[status.SERVICE_UNAVAILABLE]: "SERVICE_UNAVAILABLE",
	[status.INTERNAL_SERVER_ERROR]: "INTERNAL_SERVER_ERROR",
} as const satisfies Record<number, ErrorCode>;

type ErrorStatus = keyof typeof ERROR_CODE_BY_STATUS;

/**
 * evlog derives a requestId for every request from the inbound `x-request-id`
 * header, falling back to a generated UUID, and stores it on the request logger.
 * It is typed `unknown` there because it is not one of evlog's declared internal
 * fields, so it needs narrowing before it can be handed to a client.
 */
function requestIdOf(c: Context): string {
	const value = c.get("log")?.getContext().requestId;
	return typeof value === "string" ? value : "unknown";
}

/**
 * Echoes the correlation id back to the caller. evlog reads `x-request-id` but
 * never writes it, so without this a client has no way to quote the id that
 * appears in our logs. Registered as middleware rather than set per-response so
 * successful responses carry it too.
 *
 * Silent on routes excluded from logging — health probes have no wide event, and
 * advertising an id that appears in no log is worse than advertising none.
 */
export const echoRequestId: MiddlewareHandler = async (c, next) => {
	const id = c.get("log")?.getContext().requestId;
	if (typeof id === "string") {
		c.header("x-request-id", id);
	}
	await next();
};

/**
 * A human-readable summary of the status, required by RFC 9457. Derived from the
 * code so there is no second table to keep in step.
 */
const titleOf = (code: ErrorCode) =>
	code
		.toLowerCase()
		.split("_")
		.map((word, index) =>
			index === 0 ? word[0]?.toUpperCase() + word.slice(1) : word
		)
		.join(" ");

function errorBody(
	c: Context,
	httpStatus: ErrorStatus,
	body: {
		code: ErrorCode;
		message: string;
		why?: string;
		fix?: string;
		link?: string;
	}
) {
	return c.json(
		{
			error: { ...body, requestId: requestIdOf(c) },
			status: httpStatus,
			title: titleOf(body.code),
			type: problemType(body.code),
		},
		httpStatus,
		{ "content-type": PROBLEM_CONTENT_TYPE }
	);
}

/** Renders a thrown-style error as a returned response, so both paths agree. */
function fromError(c: Context, httpStatus: ErrorStatus, error: EvlogError) {
	return errorBody(c, httpStatus, {
		code: ERROR_CODE_BY_STATUS[httpStatus],
		fix: error.fix,
		link: error.link,
		message: error.message,
		why: error.why,
	});
}

export function ok<T>(c: Context, data: T) {
	return c.json({ data }, status.OK);
}

/**
 * A list response carries cursor state alongside the rows.
 *
 * Separate from `ok` rather than making `meta` optional there, so a caller cannot
 * accidentally omit it on an endpoint whose contract promises it — and so the
 * envelope stays owned by this package rather than assembled at each call site.
 */
export function page<T, M>(c: Context, data: T, meta: M) {
	return c.json({ data, meta }, status.OK);
}

export function created<T>(c: Context, data: T) {
	return c.json({ data }, status.CREATED);
}

export function noContent(c: Context) {
	return c.body(null, status.NO_CONTENT);
}

export function notFound(c: Context, resource: string) {
	return fromError(c, status.NOT_FOUND, notFoundError(resource));
}

export function conflict(c: Context, resource: string, field: string) {
	return fromError(c, status.CONFLICT, conflictError(resource, field));
}

export function badRequest(c: Context, detail: string) {
	return fromError(c, status.BAD_REQUEST, badRequestError(detail));
}

/**
 * Returned rather than thrown, deliberately.
 *
 * A readiness probe fires every few seconds, and `failure` records a 5xx at error
 * level — a pod thirty seconds from ready would emit dozens of error-level events
 * during an ordinary rolling deploy. Returning keeps the event at info while the
 * body stays identical to every other failure.
 */
export function serviceUnavailable(c: Context, reason: string) {
	return fromError(
		c,
		status.SERVICE_UNAVAILABLE,
		serviceUnavailableError(reason)
	);
}

/**
 * The single translation from a thrown value to the error envelope, used by
 * `app.onError`.
 *
 * A 5xx message is never forwarded: an unexpected throw carries connection
 * strings, SQL fragments and file paths. Only author-written 4xx text reaches
 * the client. `parseError` returns no stack trace at all, so there is nothing to
 * accidentally leak.
 *
 * evlog is a wide-event logger: the calls below enrich the request's single
 * event rather than emitting a second one, which is why severity has to be
 * chosen here and cannot be corrected later.
 */
export function failure(c: Context, error: unknown) {
	const parsed = parseError(error);
	const log = c.get("log");
	const known =
		parsed.status in ERROR_CODE_BY_STATUS
			? (parsed.status as ErrorStatus)
			: status.INTERNAL_SERVER_ERROR;

	if (known === status.INTERNAL_SERVER_ERROR) {
		// The stack belongs in the event and nowhere else.
		log?.error(error instanceof Error ? error : new Error(parsed.message));
		return errorBody(c, status.INTERNAL_SERVER_ERROR, {
			code: "INTERNAL_SERVER_ERROR",
			fix: "Retry the request, and quote the requestId if it keeps failing",
			message: "Something went wrong",
			why: "The server failed while handling this request",
		});
	}

	const code =
		parsed.code && parsed.code in status
			? (parsed.code as ErrorCode)
			: ERROR_CODE_BY_STATUS[known];
	// A 4xx is the caller's mistake, not a server failure. Recording a mistyped
	// identifier at error severity is how an alerting channel becomes noise.
	log?.warn(parsed.message, { errorCode: code });

	return errorBody(c, known, {
		code,
		fix: parsed.fix,
		link: parsed.link,
		message: parsed.message,
		why: parsed.why,
	});
}
