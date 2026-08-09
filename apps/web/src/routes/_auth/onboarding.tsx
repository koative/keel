import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@keel/ui/components/card";
import { createFileRoute, redirect } from "@tanstack/react-router";

import CreateOrganizationForm from "@/components/create-organization-form";
import { authClient } from "@/lib/auth-client";

export const Route = createFileRoute("/_auth/onboarding")({
	beforeLoad: ({ context }) => {
		// This screen mints a tenant, so a session that already has one must not
		// reach it. Without the bounce a back button or a stale bookmark hands the
		// user a form whose only outcome is a second organization they did not
		// mean to create — and which `create` would immediately switch them into.
		if (context.session.activeOrganizationId) {
			throw redirect({ to: "/dashboard" });
		}
	},
	component: RouteComponent,
});

async function activate(organizationId: string) {
	// `create` already points the session at the new organization, but only as a
	// side effect gated on its `keepCurrentActiveOrganization` body flag. Asking
	// for the active organization explicitly makes onboarding's postcondition
	// local, instead of depending on a default set inside better-auth.
	await authClient.organization.setActive({ organizationId });

	// Full document navigation rather than `router.invalidate()`: the active
	// organization lives in the session cookie, so the router's cached
	// `beforeLoad` context and better-auth's session atom both hold the
	// pre-tenant scope. A reload rebuilds every one of them, and it happens once
	// per tenant in a user's lifetime.
	window.location.assign("/dashboard");
}

function RouteComponent() {
	return (
		<div className="mx-auto w-full max-w-md px-4 py-10">
			<Card>
				<CardHeader>
					<CardTitle>Create your organization</CardTitle>
					<CardDescription>
						Everything you create belongs to an organization. Working on your
						own is an organization with a single member — you can invite people
						later.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<CreateOrganizationForm onCreated={activate} />
				</CardContent>
			</Card>
		</div>
	);
}
