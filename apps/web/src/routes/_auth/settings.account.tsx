import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@keel/ui/components/card";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";

import ChangePasswordForm from "@/components/change-password-form";
import SessionList from "@/components/session-list";
import { authClient } from "@/lib/auth-client";

/**
 * Under `_auth` and deliberately not under `_auth/_org`.
 *
 * A password and a device list belong to the person, not to a tenant: they are
 * the same objects whichever organization is active, and they are exactly what
 * someone whose account was just compromised needs to reach. `_org` would gate
 * both behind an active organization and bounce a member with none to
 * onboarding — so the one screen that locks an attacker out would be
 * unreachable precisely when the user's tenant state is broken. `/settings/members`
 * is the opposite case and stays where it is: it renders one organization's
 * people, so it has nothing to show without one.
 */
export const Route = createFileRoute("/_auth/settings/account")({
	component: RouteComponent,
	loader: async () => {
		const { data, error } = await authClient.listSessions();

		// Better Auth serves this list through `freshSessionMiddleware`, which
		// refuses a session older than `freshAge` — 24 hours — with
		// SESSION_NOT_FRESH. That is not an error to throw at the router: the list
		// is simply unreadable until the user proves the session again, and the
		// page's other half still works.
		if (error) {
			return {
				sessions: null,
				unavailable:
					error.code === "SESSION_NOT_FRESH"
						? "Sign out and back in to see your devices — this list is only readable from a session started in the last 24 hours."
						: error.message || error.statusText,
			};
		}

		return { sessions: data, unavailable: null };
	},
});

function RouteComponent() {
	const { session, user } = Route.useRouteContext();
	const { sessions, unavailable } = Route.useLoaderData();
	const router = useRouter();

	async function revokeSession(token: string) {
		const { error } = await authClient.revokeSession({ token });

		if (error) {
			toast.error(error.message ?? "Could not end that session");
			return;
		}

		toast.success("Session ended");
		// The list came from this route's loader, so re-running it is what refreshes
		// the screen — the same shape the members screen uses after a mutation.
		await router.invalidate();
	}

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
			<div>
				<h1 className="font-semibold text-2xl">Account</h1>
				<p className="text-muted-foreground text-sm">{user.email}</p>
			</div>

			<Card>
				<CardHeader>
					<CardTitle>Change password</CardTitle>
					<CardDescription>
						Your other devices stay signed in. End the ones you do not recognise
						below.
					</CardDescription>
				</CardHeader>
				<CardContent>
					<ChangePasswordForm />
				</CardContent>
			</Card>

			<Card>
				<CardHeader>
					<CardTitle>Devices</CardTitle>
					<CardDescription>
						Ending a session deletes it immediately, but the API keeps a signed
						copy of the session cookie valid for up to 60 seconds — so that
						device can keep making requests for up to a minute before it is
						locked out. If you are ending a session because someone else has it,
						change your password too.
					</CardDescription>
				</CardHeader>
				<CardContent>
					{sessions === null ? (
						<p className="text-muted-foreground text-sm">{unavailable}</p>
					) : (
						<SessionList
							currentSessionId={session.id}
							onRevoke={revokeSession}
							sessions={sessions}
						/>
					)}
				</CardContent>
			</Card>
		</div>
	);
}
