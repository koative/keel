import { auth } from "@keel/auth";
import { unauthorized } from "@keel/http/errors";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";

/**
 * Resolves the Better Auth session and pins the actor onto the request.
 *
 * Throws rather than returning a response so the 401 travels through the single
 * `app.onError` translation and comes back in the same envelope as every other
 * failure.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) {
		throw unauthorized();
	}

	c.set("actorId", session.user.id);
	c.get("log").set({ actor: { id: session.user.id } });
	await next();
});
