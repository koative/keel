import { Button } from "@keel/ui/components/button";
import { toast } from "sonner";

import { invitationLink } from "@/lib/invitation-link";
import { roleLabel } from "@/lib/roles";

export interface InvitationRow {
	email: string;
	expiresAt: Date;
	id: string;
	role: string;
}

export default function PendingInvitationList({
	canManage,
	invitations,
	onCancel,
}: {
	canManage: boolean;
	invitations: InvitationRow[];
	onCancel: (invitationId: string) => Promise<void>;
}) {
	return (
		<ul className="divide-y">
			{invitations.map((invitation) => (
				<li
					className="flex flex-wrap items-center gap-3 py-3"
					key={invitation.id}
				>
					<div className="min-w-48 flex-1">
						<p className="font-medium">{invitation.email}</p>
						<p className="text-muted-foreground text-sm">
							Expires {new Date(invitation.expiresAt).toLocaleDateString()}
						</p>
					</div>

					<span className="w-32 text-muted-foreground text-sm">
						{roleLabel(invitation.role)}
					</span>

					{/* The only delivery mechanism there is: nothing emails this link,
					    so it has to be copyable for as long as the invitation lives. */}
					<Button
						onClick={async () => {
							await navigator.clipboard.writeText(
								invitationLink(invitation.id)
							);
							toast.success("Invitation link copied");
						}}
						size="sm"
						variant="ghost"
					>
						Copy link
					</Button>

					{canManage ? (
						<Button
							onClick={() => onCancel(invitation.id)}
							size="sm"
							variant="ghost"
						>
							Cancel
						</Button>
					) : null}
				</li>
			))}
		</ul>
	);
}
