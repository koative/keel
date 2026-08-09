import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { authClient } from "@/lib/auth-client";

/**
 * The tenant boundary of the SPA.
 *
 * Pathless, so `/dashboard` and `/settings/members` keep their URLs while every
 * descendant is guaranteed an organization in context. Resolving it once here
 * rather than per screen is what keeps the tenant identity single-sourced: a
 * child that re-fetched it could disagree with the guard that let it render.
 */
export const Route = createFileRoute("/_auth/_org")({
	beforeLoad: async ({ context }) => {
		// Everything below is tenant-scoped, so a session with no active
		// organization has nothing to render. Onboarding, not an empty shell:
		// the user's next action is to create the organization, not to look at a
		// page explaining that they cannot.
		if (!context.session.activeOrganizationId) {
			throw redirect({ to: "/onboarding" });
		}

		const { data: organization } =
			await authClient.organization.getFullOrganization();

		// The session pointer can outlive the membership — another admin removes
		// the user mid-session. better-auth clears the stale pointer while
		// answering this call and returns nothing, so onboarding is again the
		// honest destination rather than a broken tenant view.
		if (!organization) {
			throw redirect({ to: "/onboarding" });
		}

		return { organization };
	},
	component: OrgLayout,
	// No `pendingComponent` here on purpose: the fetch above makes this layout the
	// blocking step of every tenant navigation, and the router's
	// `defaultPendingComponent` (the shared `Loader`) is exactly what should show.
	// Declaring it again would only create a second spinner to keep in sync.
});

function OrgLayout() {
	return <Outlet />;
}
