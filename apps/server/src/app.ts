import { auth } from "@keel/auth";
import { env } from "@keel/env/server";
import { echoRequestId, failure, notFound } from "@keel/http/response";
import {
	type BetterAuthInstance,
	createAuthMiddleware,
} from "evlog/better-auth";
import { evlog } from "evlog/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import type { AppEnv } from "@/lib/context";
import {
	internalProjectRoutes,
	publicProjectRoutesV1,
} from "@/modules/projects";

const identifyUser = createAuthMiddleware(auth as BetterAuthInstance, {
	exclude: ["/api/auth/**"],
	maskEmail: true,
});

export const app = new Hono<AppEnv>();

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

app.get("/", (c) => c.text("OK"));

// Two surfaces over one module. `/api` moves with the frontend; `/v1` is the
// customer contract and only ever grows.
app.route("/api/projects", internalProjectRoutes);
app.route("/v1/projects", publicProjectRoutesV1);

// Both terminal paths render the same envelope as every handler, so a client
// never has to branch on which layer produced the failure.
app.notFound((c) => notFound(c, "Route"));
app.onError((error, c) => failure(c, error));
