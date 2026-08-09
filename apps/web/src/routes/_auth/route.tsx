import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";

import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth")({
	beforeLoad: async ({ location }) => {
		const { data } = await authClient.getSession();
		if (!data) {
			// Carry the original target through sign-in. Without it every emailed deep
			// link — an invitation, a password reset, a shared resource — is silently
			// downgraded to the dashboard, and the user has to find their way back to
			// a URL they no longer have.
			throw redirect({ search: { redirect: location.href }, to: "/login" });
		}
		// Narrowed here, once. Returning better-auth's `{ data, error }` wrapper
		// instead pushes `session.data?.user` onto every descendant — an optional
		// chain that is provably non-null, because this guard already threw.
		return { session: data.session, user: data.user };
	},
	component: AuthLayout,
});

function AuthLayout() {
	return <Outlet />;
}
