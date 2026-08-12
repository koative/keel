import { evlog } from "evlog/hono";
import { Hono } from "hono";
import { notFound as notFoundError, payloadTooLarge } from "./errors";
import {
	badRequest,
	conflict,
	created,
	echoRequestId,
	failure,
	noContent,
	notFound,
	ok,
} from "./response";

/**
 * A throwaway app wired exactly the way `apps/server` wires it, so the helpers
 * are exercised through real middleware rather than called in isolation.
 *
 * `LEAKED_SECRET` is thrown deliberately: the point of `/crash` is to prove the
 * string reaches the log and never the response.
 */
export const LEAKED_SECRET = "postgres://admin:hunter2@10.0.0.4/prod";

export const testApp = new Hono()
	.use(evlog())
	.use(echoRequestId)
	.onError((error, c) => failure(c, error))
	.get("/ok", (c) => ok(c, { id: "p1" }))
	.post("/created", (c) => created(c, { id: "p1" }))
	.delete("/no-content", (c) => noContent(c))
	.get("/not-found", (c) => notFound(c, "Project"))
	.get("/conflict", (c) => conflict(c, "Project", "slug"))
	.get("/bad-request", (c) => badRequest(c, "cursor is not a valid timestamp"))
	.get("/oversized", () => {
		throw payloadTooLarge(1024);
	})
	.get("/thrown-not-found", () => {
		throw notFoundError("Project");
	})
	.get("/crash", () => {
		throw new Error(`connect ECONNREFUSED ${LEAKED_SECRET}`);
	});

/** The same wiring with the logger middleware left out. */
export const appWithoutLogger = new Hono()
	.use(echoRequestId)
	.onError((error, c) => failure(c, error))
	.get("/crash", () => {
		throw new Error("boom");
	})
	.get("/thrown-not-found", () => {
		throw notFoundError("Project");
	});
