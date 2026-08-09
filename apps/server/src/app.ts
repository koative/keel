import { OpenAPIHono } from "@hono/zod-openapi";
import { auth } from "@keel/auth";
import { env } from "@keel/env/server";
import { echoRequestId, failure, notFound } from "@keel/http/response";
import { Scalar } from "@scalar/hono-api-reference";
import {
	type BetterAuthInstance,
	createAuthMiddleware,
} from "evlog/better-auth";
import { evlog } from "evlog/hono";
import { cors } from "hono/cors";
import type { AppEnv } from "@/lib/context";
import { rejectInvalid } from "@/lib/validate";
import {
	internalProjectRoutes,
	publicProjectRoutesV1,
} from "@/modules/projects";

const identifyUser = createAuthMiddleware(auth as BetterAuthInstance, {
	exclude: ["/api/auth/**"],
	maskEmail: true,
});

const app = new OpenAPIHono<AppEnv>({ defaultHook: rejectInvalid });

// CORS is registered first so a preflight OPTIONS short-circuits here: neither a
// wide event nor a Better Auth session lookup carries information for a request
// that never reaches a handler.
app.use(
	"*",
	cors({
		allowHeaders: ["Content-Type", "Authorization"],
		allowMethods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
		credentials: true,
		origin: env.CORS_ORIGIN,
	})
);

app.use(evlog());

// evlog reads x-request-id but never echoes it, so the correlation id would
// otherwise be invisible to the client.
app.use(echoRequestId);

// Identification runs after evlog because it writes the resolved actor onto the
// request-scoped logger.
app.use("*", async (c, next) => {
	await identifyUser(c.get("log"), c.req.raw.headers, c.req.path);
	await next();
});

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

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

app.get("/reference", Scalar({ pageTitle: "keel public API", url: "/doc" }));

// Routes are chained so the app type carries every endpoint, which is what makes
// the typed client in @keel/api-client possible.
const routes = app
	.get("/", (c) => c.text("OK"))
	.route("/api/projects", internalProjectRoutes)
	.route("/v1/projects", publicProjectRoutesV1);

// Both terminal paths render the same envelope as every handler, so a client
// never has to branch on which layer produced the failure.
app.notFound((c) => notFound(c, "Route"));
app.onError((error, c) => failure(c, error));

export { app };
export type AppType = typeof routes;
