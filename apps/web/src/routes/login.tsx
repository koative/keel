import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";

export const Route = createFileRoute("/login")({
	component: RouteComponent,
	// Guards bounce unauthenticated visitors here with their original target, so
	// an invitation link survives the detour through sign-in.
	validateSearch: z.object({
		// A search parameter is attacker-controlled, and it is navigated to with
		// `navigate({ href })` after a successful sign-in. TanStack Router treats
		// an absolute href as an external navigation, so `?redirect=https://evil`
		// would carry the just-signed-in user to another origin on a trusted page.
		// Only a root-relative path is accepted; anything else — including the
		// protocol-relative `//evil.example`, which reads as root-relative and is
		// not — falls back to the default.
		redirect: z
			.string()
			.optional()
			.refine(
				(value) => value === undefined || (value.startsWith("/") && !value.startsWith("//")),
			),
	}),
});

function RouteComponent() {
	const { redirect } = Route.useSearch();
	const [showSignIn, setShowSignIn] = useState(false);
	const redirectTo = redirect ?? "/dashboard";

	return showSignIn ? (
		<SignInForm
			onSwitchToSignUp={() => setShowSignIn(false)}
			redirectTo={redirectTo}
		/>
	) : (
		<SignUpForm
			onSwitchToSignIn={() => setShowSignIn(true)}
			redirectTo={redirectTo}
		/>
	);
}
