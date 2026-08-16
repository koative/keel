import { describe, expect, it } from "bun:test";
import { app } from "@/app";
import type { AuditEntry } from "@/lib/audit";
import { seedMember, skipNotice, testDbReady } from "../../test-db";
import {
	createClient,
	type Envelope,
	type ErrorEnvelope,
	signUp,
	signUpWithoutOrganization,
} from "../../test-http";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("audit read routes"));
}

interface AuditPage {
	entries: AuditEntry[];
	nextCursor: string | null;
}

/**
 * Who the cookie belongs to, straight from Better Auth. The suite needs the
 * actor id to tell one organization's lines from another's, and the tenant id to
 * seed a second member into it.
 */
async function identify(cookie: string) {
	const response = await app.request("/api/auth/get-session", {
		headers: { Cookie: cookie },
	});
	const body = (await response.json()) as {
		session: { activeOrganizationId: string | null };
		user: { id: string };
	};
	return {
		actorId: body.user.id,
		organizationId: body.session.activeOrganizationId ?? "",
	};
}

/**
 * End to end through the real stack: the middleware in `app.ts` writes the lines
 * these requests produce, and `/api/audit` reads them back. The session comes
 * from Better Auth's own sign-up flow, so the guards in front of the trail are
 * the ones that run in production.
 */
describe.skipIf(!ready)("audit read routes", () => {
	it("reads back the mutation the caller just made", async () => {
		const api = createClient();
		api.cookie = await signUp();
		const { actorId } = await identify(api.cookie);

		const created = await api.post("/api/projects", {
			name: "Audited",
			slug: `audited-${crypto.randomUUID().slice(0, 8)}`,
		});
		expect(created.status).toBe(201);

		const response = await api.request("/api/audit");
		expect(response.status).toBe(200);

		const { data } = await api.body<Envelope<AuditPage>>(response);
		expect(data.nextCursor).toBeNull();
		expect(data.entries[0]).toMatchObject({
			actorId,
			method: "POST",
			path: "/api/projects",
			status: 201,
		});
		expect(data.entries[0]?.requestId).toBeString();
		expect(new Date(data.entries[0]?.createdAt ?? "").getTime()).not.toBeNaN();
	});

	/**
	 * The tenancy claim, and the reason the organization filter sits in the same
	 * `and(...)` as the seek: another organization's activity is not filtered out
	 * of the answer, it was never in it.
	 */
	it("hides another organization's activity", async () => {
		const own = createClient();
		const other = createClient();
		[own.cookie, other.cookie] = await Promise.all([signUp(), signUp()]);
		const [mine, theirs] = await Promise.all([
			identify(own.cookie),
			identify(other.cookie),
		]);

		await Promise.all([
			own.post("/api/projects", { name: "Mine", slug: crypto.randomUUID() }),
			other.post("/api/projects", {
				name: "Theirs",
				slug: crypto.randomUUID(),
			}),
		]);

		const { data } = await own.body<Envelope<AuditPage>>(
			await own.request("/api/audit")
		);
		expect(data.entries.length).toBeGreaterThan(0);
		expect(data.entries.every((entry) => entry.actorId === mine.actorId)).toBe(
			true
		);
		expect(data.entries.some((entry) => entry.actorId === theirs.actorId)).toBe(
			false
		);
	});

	/**
	 * The trail is organization-wide activity, so reading it is an administrative
	 * act. The member's own tenant-scoped read is asserted first, which is what
	 * makes the 403 a statement about the role rather than about the tenant — both
	 * failures answer 403, and only one of them is this rule.
	 */
	it("refuses a plain member, who can still read their own tenant", async () => {
		const owner = createClient();
		owner.cookie = await signUp();
		const { organizationId } = await identify(owner.cookie);

		const member = createClient();
		member.cookie = await signUpWithoutOrganization();
		const { actorId } = await identify(member.cookie);
		await seedMember(organizationId, actorId, "member");
		const activated = await member.post("/api/auth/organization/set-active", {
			organizationId,
		});
		expect(activated.status).toBe(200);

		expect((await member.request("/api/projects")).status).toBe(200);

		const response = await member.request("/api/audit");
		expect(response.status).toBe(403);
		expect((await member.body<ErrorEnvelope>(response)).error.code).toBe(
			"FORBIDDEN"
		);
	});

	it("pages with the cursor from the previous response", async () => {
		const api = createClient();
		api.cookie = await signUp();

		await Promise.all(
			["first", "second", "third"].map((name) =>
				api.post("/api/projects", { name, slug: crypto.randomUUID() })
			)
		);

		const first = await api.body<Envelope<AuditPage>>(
			await api.request("/api/audit?limit=2")
		);
		expect(first.data.entries).toHaveLength(2);
		expect(first.data.nextCursor).toBeString();

		const second = await api.body<Envelope<AuditPage>>(
			await api.request(`/api/audit?cursor=${first.data.nextCursor}&limit=2`)
		);
		expect(second.data.entries).toHaveLength(1);
		expect(second.data.nextCursor).toBeNull();

		const seen = [...first.data.entries, ...second.data.entries].map(
			(entry) => entry.id
		);
		expect(new Set(seen).size).toBe(3);
	});
});
