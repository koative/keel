import { auth } from "@keel/auth";
import { forbidden, unauthorized } from "@keel/http/errors";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";

/**
 * Resolves the Better Auth session and pins the actor onto the request.
 *
 * Throws rather than returning a response so the 401 travels through the single
 * `app.onError` translation and comes back in the same envelope as every other
 * failure.
 *
 * This is the only place in a request that resolves a session. `requireOrg`
 * reads what this leaves behind rather than asking again, so the tenant a
 * request acts on cannot drift from the actor it was authenticated as partway
 * through.
 */
export const requireUser = createMiddleware<AppEnv>(async (c, next) => {
	const session = await auth.api.getSession({ headers: c.req.raw.headers });
	if (!session) {
		throw unauthorized();
	}

	c.set("actorId", session.user.id);
	c.set("activeOrganizationId", session.session.activeOrganizationId ?? null);
	c.get("log").set({ actor: { id: session.user.id } });
	await next();
});

/**
 * Narrows the active organization to a tenant every downstream repository can
 * filter by. MUST be mounted after `requireUser`, which is what puts the value
 * on the context.
 *
 * Deliberately does not call `getSession` — one session resolution per request.
 * A second call would be a second database round trip on every tenant-scoped
 * route, and a second answer that could disagree with the first.
 *
 * 403 and not 401: the caller's credentials are fine, so telling them to sign in
 * again would send them in a circle. The distinction is load-bearing for the
 * SPA, which reads a 403 here as "this account has no organization yet" and
 * routes to onboarding, while a 401 sends it to the sign-in screen.
 */
export const requireOrg = createMiddleware<AppEnv>(async (c, next) => {
	const organizationId = c.get("activeOrganizationId");
	if (!organizationId) {
		throw forbidden("act without an active organization");
	}

	c.set("organizationId", organizationId);
	c.get("log").set({ organization: { id: organizationId } });
	await next();
});
