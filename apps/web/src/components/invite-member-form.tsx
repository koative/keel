import { Button } from "@keel/ui/components/button";
import { Input } from "@keel/ui/components/input";
import { Label } from "@keel/ui/components/label";
import { type SubmitEvent, useState } from "react";
import { toast } from "sonner";

import { authClient } from "@/lib/auth-client";
import { invitationLink } from "@/lib/invitation-link";
import { ASSIGNABLE_ROLES, type AssignableRole, roleLabel } from "@/lib/roles";

export default function InviteMemberForm({
	onInvited,
}: {
	onInvited: () => Promise<void>;
}) {
	const [email, setEmail] = useState("");
	const [role, setRole] = useState<AssignableRole>("member");
	const [isInviting, setIsInviting] = useState(false);

	async function invite(event: SubmitEvent<HTMLFormElement>) {
		event.preventDefault();

		const address = email.trim().toLowerCase();
		if (!address) {
			toast.error("An email address is required");
			return;
		}

		setIsInviting(true);
		const { data, error } = await authClient.organization.inviteMember({
			email: address,
			role,
		});
		setIsInviting(false);

		if (error || !data) {
			toast.error(error?.message ?? "Could not create the invitation");
			return;
		}

		setEmail("");
		// No mailer exists, so the link is put on the clipboard the moment it is
		// created — that is the only delivery this invitation will ever get, and
		// it is also listed below in case the copy is lost.
		await navigator.clipboard.writeText(invitationLink(data.id));
		toast.success("Invitation created — link copied to your clipboard");
		await onInvited();
	}

	return (
		<form className="flex flex-wrap items-end gap-3" onSubmit={invite}>
			<div className="min-w-56 flex-1 space-y-2">
				<Label htmlFor="invite-email">Email</Label>
				<Input
					id="invite-email"
					onChange={(event) => setEmail(event.target.value)}
					placeholder="teammate@example.com"
					type="email"
					value={email}
				/>
			</div>
			<div className="w-40 space-y-2">
				<Label htmlFor="invite-role">Role</Label>
				<select
					className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
					id="invite-role"
					onChange={(event) => setRole(event.target.value as AssignableRole)}
					value={role}
				>
					{ASSIGNABLE_ROLES.map((value) => (
						<option key={value} value={value}>
							{roleLabel(value)}
						</option>
					))}
				</select>
			</div>
			<Button disabled={isInviting} type="submit">
				{isInviting ? "Inviting..." : "Invite"}
			</Button>
		</form>
	);
}
