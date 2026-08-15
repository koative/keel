import { Hono } from "hono";
import type { AppEnv } from "@/lib/context";
import { internalAiRoutes } from "@/modules/ai";
import { internalProjectRoutes } from "@/modules/projects";
import { internalStorageRoutes } from "@/modules/storage";

/**
 * The router behind the typed client, and nothing else.
 *
 * `AppType` in app-type.ts derives from `internalRoutes`, so the declaration
 * bundle can never carry the frozen `/v1` half again — a route added there
 * stops compiling the client instead of silently degrading it to `any`.
 * Mounted on `app` at "/" so the type surface and the runtime cannot drift:
 * the paths the client sees are the paths the server serves.
 *
 * It lives in its own module on purpose: the type bundle is built from
 * app-type.ts, so everything reachable from here ends up in the client's
 * types. A route a browser calls belongs here; `app` keeps the rest — the
 * `/v1` contract, the probes, Better Auth.
 *
 * `/api/webhooks` is the one internal router deliberately mounted on `app`
 * instead: a provider posts to it server-to-server with a signature and no
 * cookie, so no browser client ever calls it and typing it would only widen
 * the surface the SPA can reach.
 */
export const internalRoutes = new Hono<AppEnv>()
	.route("/api/projects", internalProjectRoutes)
	.route("/api/storage", internalStorageRoutes)
	.route("/api/ai", internalAiRoutes);
