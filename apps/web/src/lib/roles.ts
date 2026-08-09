/**
 * The roles a human may hand out from the members screen.
 *
 * `owner` is deliberately absent: better-auth assigns it to whoever created the
 * organization, and transferring it is a different operation from "change this
 * person's role" — it would leave the organization with two owners or none.
 */
export const ASSIGNABLE_ROLES = ["member", "admin"] as const;

export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];

const ROLE_LABELS: Record<string, string> = {
	admin: "Admin",
	member: "Member",
	owner: "Owner",
};

/**
 * Roles arrive from the server as opaque strings, so an unmapped one falls back
 * to its raw value rather than rendering blank.
 */
export function roleLabel(role: string): string {
	return ROLE_LABELS[role] ?? role;
}
