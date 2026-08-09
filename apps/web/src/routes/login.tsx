import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { z } from "zod";

import SignInForm from "@/components/sign-in-form";
import SignUpForm from "@/components/sign-up-form";

export const Route = createFileRoute("/login")({
	component: RouteComponent,
	// Guards bounce unauthenticated visitors here with their original target, so
	// an invitation link survives the detour through sign-in. Validated rather
	// than read raw: this value is a navigation target taken from the URL.
	validateSearch: z.object({ redirect: z.string().optional() }),
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
