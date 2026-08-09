import { auth } from "@keel/auth";
import { env } from "@keel/env/server";
import {
	type BetterAuthInstance,
	createAuthMiddleware,
} from "evlog/better-auth";
import { type EvlogVariables, evlog } from "evlog/hono";
import { Hono } from "hono";
import { cors } from "hono/cors";

const identifyUser = createAuthMiddleware(auth as BetterAuthInstance, {
	exclude: ["/api/auth/**"],
	maskEmail: true,
});

export const app = new Hono<EvlogVariables>();

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

// Identification runs after evlog because it writes the resolved actor onto the
// request-scoped logger.
app.use("*", async (c, next) => {
	await identifyUser(c.get("log"), c.req.raw.headers, c.req.path);
	await next();
});

app.on(["POST", "GET"], "/api/auth/*", (c) => auth.handler(c.req.raw));

app.get("/", (c) => c.text("OK"));
