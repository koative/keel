import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "@keel/ui/components/card";
import { createFileRoute, useRouter } from "@tanstack/react-router";
import { toast } from "sonner";

import InviteMemberForm from "@/components/invite-member-form";
import MemberList from "@/components/member-list";
import PendingInvitationList from "@/components/pending-invitation-list";
import { authClient } from "@/lib/auth-client";
import type { AssignableRole } from "@/lib/roles";

export const Route = createFileRoute("/_auth/_org/settings/members")({
	component: RouteComponent,
});

function RouteComponent() {
	const { organization, user } = Route.useRouteContext();
	const router = useRouter();

	// Missing means the membership vanished between the layout's fetch and this
	// render; the least-privilege reading is the safe one, and the next
	// navigation will bounce them out through the layout guard anyway.
	const viewerRole =
		organization.members.find((member) => member.userId === user.id)?.role ??
		"member";
	const canManage = viewerRole === "owner" || viewerRole === "admin";
	const pendingInvitations = organization.invitations.filter(
		(invitation) => invitation.status === "pending"
	);

	async function changeRole(memberId: string, role: AssignableRole) {
		const { error } = await authClient.organization.updateMemberRole({
			memberId,
			role,
		});

		if (error) {
			toast.error(error.message ?? "Could not change the role");
			return;
		}

		toast.success("Role updated");
		// The organization is resolved once, by the `_org` layout's `beforeLoad`.
		// Re-running that is what refreshes this screen: a second fetch owned by
		// this page could disagree with the guard that let the page render.
		await router.invalidate();
	}

	async function removeMember(memberId: string) {
		const { error } = await authClient.organization.removeMember({
			memberIdOrEmail: memberId,
		});

		if (error) {
			toast.error(error.message ?? "Could not remove the member");
			return;
		}

		toast.success("Member removed");
		await router.invalidate();
	}

	async function cancelInvitation(invitationId: string) {
		const { error } = await authClient.organization.cancelInvitation({
			invitationId,
		});

		if (error) {
			toast.error(error.message ?? "Could not cancel the invitation");
			return;
		}

		toast.success("Invitation cancelled");
		await router.invalidate();
	}

	return (
		<div className="mx-auto flex w-full max-w-3xl flex-col gap-6 px-4 py-6">
			<div>
				<h1 className="font-semibold text-2xl">Members</h1>
				<p className="text-muted-foreground text-sm">{organization.name}</p>
			</div>

			{canManage ? (
				<Card>
					<CardHeader>
						<CardTitle>Invite someone</CardTitle>
						<CardDescription>
							No email is sent. The invitation link is copied to your clipboard
							and stays listed below until it is used, cancelled, or expires
							after seven days.
						</CardDescription>
					</CardHeader>
					<CardContent>
						<InviteMemberForm onInvited={() => router.invalidate()} />
					</CardContent>
				</Card>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>Team</CardTitle>
					<CardDescription>
						{organization.members.length} member
						{organization.members.length === 1 ? "" : "s"}
					</CardDescription>
				</CardHeader>
				<CardContent>
					<MemberList
						canManage={canManage}
						members={organization.members}
						onRemove={removeMember}
						onRoleChange={changeRole}
						viewerUserId={user.id}
					/>
				</CardContent>
			</Card>

			{pendingInvitations.length > 0 ? (
				<Card>
					<CardHeader>
						<CardTitle>Pending invitations</CardTitle>
						<CardDescription>
							{pendingInvitations.length} waiting to be accepted
						</CardDescription>
					</CardHeader>
					<CardContent>
						<PendingInvitationList
							canManage={canManage}
							invitations={pendingInvitations}
							onCancel={cancelInvitation}
						/>
					</CardContent>
				</Card>
			) : null}
		</div>
	);
}
