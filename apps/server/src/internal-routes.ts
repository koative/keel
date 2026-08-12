import { Hono } from "hono";
import type { AppEnv } from "@/lib/context";
import { internalProjectRoutes } from "@/modules/projects";

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
 * types. A route that should be typed in the client belongs here; `app` keeps
 * the rest — the `/v1` contract, the probes, Better Auth.
 */
export const internalRoutes = new Hono<AppEnv>()
	.route("/api/projects", internalProjectRoutes);
