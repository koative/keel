import { Button } from "@keel/ui/components/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardFooter,
	CardHeader,
	CardTitle,
} from "@keel/ui/components/card";
import { createFileRoute } from "@tanstack/react-router";
import { useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";
import { roleLabel } from "@/lib/roles";

/**
 * The destination the login `redirect` search param exists to protect.
 *
 * A signed-out user opening an invitation link hits `_auth`'s guard, which
 * throws to `/login?redirect=<this href>`; the sign-in form navigates back here
 * on success. That is the whole mechanism — this route adds none of its own,
 * and deliberately does not try to read the invitation before authentication:
 * `/organization/get-invitation` is 401 without a session and 403 unless the
 * signed-in email is the addressee.
 *
 * It sits under `_auth` and not `_org` for the obvious-in-hindsight reason: the
 * typical recipient has no organization yet, so the tenant layout would bounce
 * them to onboarding and make them create one — the exact thing the invitation
 * was supposed to spare them.
 */
export const Route = createFileRoute("/_auth/accept-invitation/$invitationId")({
	component: RouteComponent,
	loader: async ({ params }) => {
		const { data, error } = await authClient.organization.getInvitation({
			query: { id: params.invitationId },
		});

		// Not thrown: an expired, cancelled or misaddressed invitation is an
		// ordinary outcome of a link that travelled by hand, and the reason it
		// failed is more useful to the recipient than an error boundary.
		return { error: error?.message ?? null, invitation: data };
	},
});

function RouteComponent() {
	const { invitationId } = Route.useParams();
	const { error, invitation } = Route.useLoaderData();
	const [pending, setPending] = useState<"accept" | "reject" | null>(null);

	if (!invitation) {
		return (
			<div className="mx-auto w-full max-w-md px-4 py-10">
				<Card>
					<CardHeader>
						<CardTitle>Invitation unavailable</CardTitle>
						<CardDescription>
							{error ??
								"This invitation has expired, was cancelled, or was sent to a different address."}
						</CardDescription>
					</CardHeader>
				</Card>
			</div>
		);
	}

	// Bound out here rather than read inside `respond`: narrowing from the guard
	// above does not cross a function boundary, and the alternative is a non-null
	// assertion that would survive the guard being moved or removed.
	const { organizationId } = invitation;

	async function respond(action: "accept" | "reject") {
		setPending(action);

		const { error: responseError } =
			action === "accept"
				? await authClient.organization.acceptInvitation({ invitationId })
				: await authClient.organization.rejectInvitation({ invitationId });

		if (responseError) {
			setPending(null);
			toast.error(responseError.message ?? "Could not complete the request");
			return;
		}

		if (action === "accept") {
			// Accepting creates the membership and points the session at the
			// organization inside better-auth's own transaction. Asking for it
			// explicitly keeps the landing scope a property of this flow rather
			// than of that internal ordering.
			await authClient.organization.setActive({
				organizationId,
			});
		}

		// Full document navigation: the router context and better-auth's session
		// atom still hold the pre-membership scope. `pending` stays set so the
		// buttons cannot fire twice before the page unloads.
		window.location.assign(action === "accept" ? "/dashboard" : "/");
	}

	return (
		<div className="mx-auto w-full max-w-md px-4 py-10">
			<Card>
				<CardHeader>
					<CardTitle>Join {invitation.organizationName}</CardTitle>
					<CardDescription>
						{invitation.inviterEmail} invited you as{" "}
						{roleLabel(invitation.role)}.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<p className="text-muted-foreground text-sm">
						This invitation was sent to {invitation.email}.
					</p>
				</CardContent>
				<CardFooter className="gap-2">
					<Button disabled={pending !== null} onClick={() => respond("accept")}>
						{pending === "accept" ? "Joining..." : "Accept"}
					</Button>
					<Button
						disabled={pending !== null}
						onClick={() => respond("reject")}
						variant="outline"
					>
						{pending === "reject" ? "Declining..." : "Decline"}
					</Button>
				</CardFooter>
			</Card>
		</div>
	);
}
