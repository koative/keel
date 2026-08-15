import { OpenAPIHono } from "@hono/zod-openapi";
import { auth } from "@keel/auth";
import { env } from "@keel/env/server";
import {
	echoRequestId,
	failure,
	notFound,
	ok,
	serviceUnavailable,
} from "@keel/http/response";
import { Scalar } from "@scalar/hono-api-reference";
import {
	type BetterAuthInstance,
	createAuthMiddleware,
} from "evlog/better-auth";
import { evlog } from "evlog/hono";
import { cors } from "hono/cors";
import { internalRoutes } from "@/internal-routes";
import type { AppEnv } from "@/lib/context";
import { checkReadiness } from "@/lib/health";
import {
	apiSecurityHeaders,
	referenceSecurityHeaders,
	requestBodyLimit,
} from "@/lib/security";
import { rejectInvalid } from "@/lib/validate";
import { publicProjectRoutesV1 } from "@/modules/projects";
import { internalWebhookRoutes } from "@/modules/webhooks";

const identifyUser = createAuthMiddleware(auth as BetterAuthInstance, {
	exclude: ["/api/auth/**"],
	maskEmail: true,
});

const app = new OpenAPIHono<AppEnv>({ defaultHook: rejectInvalid });

/**
 * Scalar renders client-side from a CDN, so this is the one page that cannot run
 * under `default-src 'none'`.
 *
 * Registered ABOVE the global headers rather than relying on route-level
 * middleware to override them: `secureHeaders` writes after `next()`, so in Hono's
 * onion the outer instance unwinds last and wins. A route-level policy declared
 * below the global one is silently discarded — the page loads, the console shows
 * blocked scripts, and nothing in the code looks wrong.
 */
app.get(
	"/reference",
	referenceSecurityHeaders,
	Scalar({ pageTitle: "keel public API", url: "/doc" })
);

// Security headers go on before anything can short-circuit, so a preflight and an
// error carry them too.
app.use("*", apiSecurityHeaders);

/**
 * Probes are registered ahead of every other middleware, on purpose.
 *
 * A probe must answer whether the process and its dependencies are healthy, and
 * nothing else — it should not resolve a session, allocate a wide event, or be
 * rate limited. Middleware registered below does not apply to a route declared
 * above it, so this placement is the exclusion.
 *
 * It is also the safe placement: excluding these paths from evlog while leaving
 * them downstream of middleware that reads `c.get("log")` turns every probe into
 * a 500.
 *
 * Liveness consults nothing: a 503 here tells an orchestrator to restart the
 * process, and restarting does not fix Postgres.
 */
app.get("/health", (c) => ok(c, { status: "live" }));

// Readiness is the one that checks the database, which is what keeps a pod out of
// the load balancer while it cannot serve, and what the compose healthcheck polls.
app.get("/ready", async (c) => {
	const readiness = await checkReadiness();
	return readiness.ready
		? ok(c, { status: "ready" })
		: serviceUnavailable(c, readiness.reason);
});

// CORS is registered early so a preflight OPTIONS short-circuits here: neither a
// wide event nor a Better Auth session lookup carries information for a request
// that never reaches a handler.
app.use(
	"*",
	cors({
		allowHeaders: ["Content-Type", "Authorization", "Idempotency-Key"],
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		credentials: true,
		exposeHeaders: ["x-request-id", "Idempotency-Replayed"],
		origin: env.CORS_ORIGIN,
	})
);

app.use(evlog());

// evlog reads x-request-id but never echoes it, so the correlation id would
// otherwise be invisible to the client.
app.use(echoRequestId);

// Identification runs after evlog because it writes the resolved actor onto the
// request-scoped logger. Guarded rather than assumed: a future route excluded from
// logging must not become a 500 here.
app.use("*", async (c, next) => {
	const log = c.get("log");
	if (log) {
		await identifyUser(log, c.req.raw.headers, c.req.path);
	}
	await next();
});

// Before anything reads a body: a validator or a handler that has already buffered
// an oversized payload has already paid for it.
app.use("*", requestBodyLimit);

/**
 * The rate limiter is deliberately NOT mounted here, and this is the first place
 * anyone will look for it.
 *
 * It is keyed on `actorId`, which `requireUser` puts on the context, and
 * `requireUser` is mounted per module. Hono leaves no position in this file that
 * satisfies both: registered above, an `app.use("/api/*", …)` runs before the
 * module's guard and has no actor to key on; registered below `app.route(…)` it
 * never runs at all, because by then the module's own route handler is already
 * ahead of it in the chain and terminates it. So the limiter is mounted beside
 * `requireUser` in each module's `*.routes.ts`, and `tools/gen-module.ts` emits
 * it, so a generated module is limited from its first commit.
 *
 * That placement also gives the exclusions for free rather than as a path list
 * to maintain: `/api/auth/*` is Better Auth's handler below and limits itself on
 * IP, having no actor yet, while `/health`, `/ready`, `/doc` and `/reference`
 * belong to no module.
 */
app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

// Declaring the 401 responses without declaring how to authenticate leaves the
// contract half-written: a generated SDK has no reason to send the cookie.
app.openAPIRegistry.registerComponent("securitySchemes", "sessionCookie", {
	description: "Session cookie issued by POST /api/auth/sign-in/email.",
	in: "cookie",
	name: "better-auth.session_token",
	type: "apiKey",
});

// Only `publicProjectRoutesV1` is an OpenAPIHono, so only its routes land in the
// registry. The internal surface is a plain Hono and is therefore absent from the
// document by construction rather than by a filter someone has to remember.
app.doc("/doc", {
	info: {
		description:
			"The versioned, stable surface. Endpoints under /api are internal and are not described here.",
		title: "keel public API",
		version: "1.0.0",
	},
	openapi: "3.1.0",
});

// The `/v1` half stays mounted here — only its presence in the client's type
// bundle changes. Mounting both halves keeps the runtime surface intact while
// `AppType` sees the internal router alone. `/api/webhooks` sits here too, and
// internal-routes.ts says why: a provider callback is not an SPA endpoint.
app
	.get("/", (c) => c.text("OK"))
	.route("/", internalRoutes)
	.route("/api/webhooks", internalWebhookRoutes)
	.route("/v1/projects", publicProjectRoutesV1);

// Both terminal paths render the same envelope as every handler, so a client
// never has to branch on which layer produced the failure.
app.notFound((c) => notFound(c, "Route"));
app.onError((error, c) => failure(c, error));

export { app };
