import { auth } from "@keel/auth";
import { forbidden, unauthorized } from "@keel/http/errors";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";
import { findMembership } from "./membership.repository";

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
 * filter by, and confirms the actor is still a member of it. MUST be mounted after
 * `requireUser`, which is what puts the actor and the pointer on the context.
 *
 * The membership lookup is the authorization decision; the session's pointer is
 * only a claim. Better Auth does not clear that pointer when an admin removes
 * someone else, so trusting it left a removed member with full read and write
 * access to the organization's data until their session expired — seven days by
 * default, and reachable with nothing but a saved cookie. The SPA bounced them,
 * but the SPA is not the security boundary.
 *
 * Deliberately not `auth.api.hasPermission`: it re-resolves the session inside the
 * endpoint, which is the second resolution `requireUser` exists to prevent, and it
 * answers a non-member with 401 — which would tell the SPA to sign the user in
 * again rather than that they are in the wrong place.
 *
 * 403 and not 401 for both failures: the caller's credentials are fine. The
 * distinction is load-bearing for the SPA, which reads a 403 here as "no
 * organization to act in" and routes to onboarding, while a 401 sends it to
 * sign-in.
 */
export const requireOrg = createMiddleware<AppEnv>(async (c, next) => {
	const organizationId = c.get("activeOrganizationId");
	if (!organizationId) {
		throw forbidden("act without an active organization");
	}

	const membership = await findMembership(c.get("actorId"), organizationId);
	if (!membership) {
		throw forbidden("act in an organization you do not belong to");
	}

	c.set("organizationId", organizationId);
	c.set("role", membership.role);
	c.get("log").set({ organization: { id: organizationId } });
	await next();
});
