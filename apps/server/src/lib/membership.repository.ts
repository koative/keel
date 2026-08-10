import { db } from "@keel/db";
import { member } from "@keel/db/schema/organization";
import { and, eq } from "drizzle-orm";

/**
 * The only file allowed to touch Drizzle for membership, mirroring the per-module
 * repositories. It lives under `lib/` because tenancy is infrastructure: every
 * module's guard shares this one lookup.
 */

/**
 * Confirms the actor is still a member of this organization, returning the role.
 *
 * This exists because a session's tenant pointer outlives the membership it names.
 * Better Auth clears `activeOrganizationId` only when a user removes themselves —
 * `crud-members.mjs` guards that branch with
 * `session.user.id === toBeRemovedMember.userId`, and `deleteMember` in
 * `adapter.mjs` never touches the session table at all. So when an admin removes
 * someone, the removed user's session still points at the organization, and a guard
 * that trusts the pointer keeps letting them in until the session expires — seven
 * days at Better Auth's default.
 *
 * Covered by `member_userId_idx`, and one indexed lookup is proportionate next to
 * the session query already on this path.
 */
export async function findMembership(actorId: string, organizationId: string) {
	return await db.query.member.findFirst({
		columns: { role: true },
		where: and(
			eq(member.organizationId, organizationId),
			eq(member.userId, actorId)
		),
	});
}
