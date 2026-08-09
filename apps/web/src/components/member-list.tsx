import { Button } from "@keel/ui/components/button";

import { ASSIGNABLE_ROLES, type AssignableRole, roleLabel } from "@/lib/roles";

/**
 * Structurally typed rather than imported from better-auth: this list renders
 * people, and pinning it to the plugin's inferred member type would drag the
 * whole organization generic into a presentational component.
 */
export interface MemberRow {
	id: string;
	role: string;
	user: { email: string; name: string };
	userId: string;
}

export default function MemberList({
	canManage,
	members,
	onRemove,
	onRoleChange,
	viewerUserId,
}: {
	canManage: boolean;
	members: MemberRow[];
	onRemove: (memberId: string) => Promise<void>;
	onRoleChange: (memberId: string, role: AssignableRole) => Promise<void>;
	viewerUserId: string;
}) {
	return (
		<ul className="divide-y">
			{members.map((member) => {
				// The owner is the organization's anchor: demoting or removing them
				// through this screen would leave it with nobody who can grant roles.
				const isOwner = member.role === "owner";
				const isViewer = member.userId === viewerUserId;

				return (
					<li
						className="flex flex-wrap items-center gap-3 py-3"
						key={member.id}
					>
						<div className="min-w-48 flex-1">
							<p className="font-medium">
								{member.user.name}
								{isViewer ? (
									<span className="text-muted-foreground"> (you)</span>
								) : null}
							</p>
							<p className="text-muted-foreground text-sm">
								{member.user.email}
							</p>
						</div>

						{canManage && !isOwner ? (
							<select
								aria-label={`Role for ${member.user.email}`}
								className="h-9 w-32 rounded-md border bg-transparent px-3 text-sm"
								onChange={(event) =>
									onRoleChange(member.id, event.target.value as AssignableRole)
								}
								value={member.role}
							>
								{ASSIGNABLE_ROLES.map((value) => (
									<option key={value} value={value}>
										{roleLabel(value)}
									</option>
								))}
							</select>
						) : (
							<span className="w-32 text-muted-foreground text-sm">
								{roleLabel(member.role)}
							</span>
						)}

						{canManage && !isOwner ? (
							<Button
								onClick={() => onRemove(member.id)}
								size="sm"
								variant="ghost"
							>
								Remove
							</Button>
						) : null}
					</li>
				);
			})}
		</ul>
	);
}
