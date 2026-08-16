import { zValidator } from "@hono/zod-validator";
import { forbidden } from "@keel/http/errors";
import { ok } from "@keel/http/response";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { z } from "zod";
import { listByOrganization, record } from "./audit.repository";
import { requireOrg, requireUser } from "./auth";
import type { AppEnv } from "./context";
import { type Cursor, decodeCursor, encodeCursor } from "./cursor";
import { rateLimit } from "./rate-limit";
import { rejectInvalid } from "./validate";

/**
 * The public face of the audit trail: the middleware that writes it and the
 * router that reads it. `audit.repository.ts` is private to the subsystem, the
 * same shape `rate-limit.ts` and `idempotency.ts` use.
 *
 * Both halves live in one file because they are one decision made twice — what
 * gets recorded, and who may read it back. Splitting them would put the answer
 * to "is this line trustworthy?" a file away from the line's only reader.
 */

/**
 * The three methods that leave no line, as a denylist rather than the allowlist
 * `rate-limit.ts` uses for its write budget. The difference is which way an
 * unfamiliar method should fail: a limiter that mistakes one for a read charges
 * the wrong bucket, while a trail that mistakes one for a read loses the record
 * outright. So anything that is not plainly a read is recorded.
 */
const SILENT: Record<string, true> = {
	GET: true,
	HEAD: true,
	OPTIONS: true,
};

/**
 * Writes one line per mutating request, after the response status is known.
 *
 * A middleware and not a call in each handler, because a rule you have to
 * remember is a rule that eventually gets forgotten: a new endpoint is audited
 * from its first commit without opting in, and there is no way to write one that
 * is not. The cost is a row this middleware cannot describe in domain terms —
 * method, path, status — which is the honest price of that guarantee.
 *
 * Reading `c.res.status` after `await next()` sees the status the client actually
 * received, including a translated failure: Hono's compose catches a thrown error
 * at the frame that threw and hands it to `app.onError` there, so by the time the
 * middleware above it resumes, `c.res` is already the error envelope. That is
 * what puts a 401, a 403 and a 422 in the trail — the attempts it is most often
 * read for.
 *
 * The insert is awaited before the response leaves, so a client told its mutation
 * happened is a client whose mutation is recorded. That costs one INSERT on the
 * request's critical path, and it is the difference between a record and a
 * best-effort.
 */
export const audit = createMiddleware<AppEnv>(async (c, next) => {
	await next();

	if (SILENT[c.req.method]) {
		return;
	}

	/**
	 * Both are declared wider than `AppEnv` types them, and deliberately.
	 * `actorId` and `organizationId` are non-optional there because a route that
	 * reads them without its guard is a wiring mistake — but this middleware runs
	 * outside every guard on purpose, so absent is a state it genuinely meets: an
	 * anonymous sign-in attempt has no actor, and an authentication request has no
	 * tenant. Those are the two nullable columns in `audit_log`.
	 */
	const actorId: string | undefined = c.get("actorId");
	const organizationId: string | undefined = c.get("organizationId");
	const log = c.get("log");
	// evlog types its own requestId as `unknown`, since it is not one of the
	// declared internal fields; `@keel/http`'s error envelope narrows it the same
	// way, down to the same fallback.
	const { requestId } = log.getContext();

	try {
		await record({
			actorId: actorId ?? null,
			method: c.req.method,
			organizationId: organizationId ?? null,
			path: c.req.path,
			requestId: typeof requestId === "string" ? requestId : "unknown",
			status: c.res.status,
		});
	} catch (error) {
		/**
		 * The request already happened. Its effect is committed and failing it here
		 * would roll nothing back — it would only turn a bookkeeping outage into an
		 * outage of the product, and answer 500 to a client whose write succeeded.
		 *
		 * A silently lost line is still the loss nobody can detect later, so it is
		 * reported on the request's own wide event, which already carries the
		 * method, the path, the status and the requestId the row would have held.
		 * `written: false` is the field to alert on: it is the only signal that the
		 * trail has a hole in it.
		 */
		log.error(error as Error, { auditLog: { written: false } });
	}
});

/**
 * The trail is organization-wide activity — every member's writes, not the
 * reader's own — so reading it is an administrative act and a plain member gets
 * 403 rather than a filtered view. A filtered view would be the more helpful
 * answer and the wrong one: it invents a "my activity" endpoint nothing asked
 * for, out of rows recorded for a different purpose.
 *
 * MUST be mounted after `requireOrg`, which is what puts the role on the context
 * — and which read the membership row to get it, so this decision costs no query.
 */
const requireAdministrator = createMiddleware<AppEnv>(async (c, next) => {
	const role = c.get("role");
	if (role !== "owner" && role !== "admin") {
		throw forbidden("read this organization's audit trail");
	}

	await next();
});

/**
 * Paging is validated, not merely parsed: `limit` is capped so one client cannot
 * ask for the whole trail, and a cursor that did not come from us is rejected
 * here rather than in the handler, where it would surface as a 500 for a client's
 * typo.
 */
const auditPageSchema = z.object({
	cursor: z
		.string()
		.transform(decodeCursor)
		.refine(
			(cursor: Cursor | null) => cursor !== null,
			"Not a cursor from a previous page"
		)
		.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(25),
});

/** One line of the trail as the typed client sees it. */
export interface AuditEntry {
	actorId: string | null;
	createdAt: string;
	id: string;
	method: string;
	path: string;
	requestId: string;
	status: number;
}

/**
 * Field by field rather than a spread: the row carries `organization_id`, and
 * publishing the tenancy key of a tenant the guard already scoped the caller to
 * is at best redundant.
 */
const present = (row: {
	actorId: string | null;
	createdAt: Date;
	id: string;
	method: string;
	path: string;
	requestId: string;
	status: number;
}): AuditEntry => ({
	actorId: row.actorId,
	createdAt: row.createdAt.toISOString(),
	id: row.id,
	method: row.method,
	path: row.path,
	requestId: row.requestId,
	status: row.status,
});

/**
 * `/api/audit` — one organization's activity, newest first.
 *
 * `nextCursor` travels inside `data` rather than in the `meta` a list endpoint
 * usually carries, because the SPA reads one object: entries and where to resume.
 */
export const auditRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.use(rateLimit)
	.use(requireOrg)
	.use(requireAdministrator)
	.get("/", zValidator("query", auditPageSchema, rejectInvalid), async (c) => {
		const query = c.req.valid("query");
		const rows = await listByOrganization(c.get("organizationId"), {
			cursor: query.cursor ?? null,
			limit: query.limit,
		});
		const entries = rows.slice(0, query.limit);
		const last = entries.at(-1);

		return ok(c, {
			entries: entries.map(present),
			nextCursor:
				rows.length > query.limit && last
					? encodeCursor({ createdAt: last.createdAt, id: last.id })
					: null,
		});
	});
