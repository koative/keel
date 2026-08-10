import { afterEach, describe, expect, it } from "bun:test";
import { failure, ok } from "@keel/http/response";
import { type DrainContext, initLogger } from "evlog";
import { evlog } from "evlog/hono";
import { Hono } from "hono";
import { requireOrg } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
import {
	seedMember,
	seedOrganization,
	seedUser,
	skipNotice,
	testDbReady,
} from "../../test-db";
import type { ErrorEnvelope } from "../../test-http";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("lib/auth"));
}

/**
 * `requireOrg` is driven through a throwaway app rather than the real one, with a
 * stub standing in for `requireUser` — that guard's entire contribution here is the
 * actor and the session's tenant pointer.
 *
 * The database is real and not optional. The whole point of this middleware is that
 * the pointer is a claim and the `member` row is the decision, so a stubbed
 * membership lookup would pass against the version of this code that trusted the
 * pointer — the version that let a removed member keep reading an organization's
 * data until their session expired.
 *
 * `requireUser`'s own 401 is exercised where it is mounted, in
 * `projects.routes.tenancy.test.ts`, because it needs a real Better Auth session.
 */
function buildApp(actorId: string, activeOrganizationId: string | null) {
	const calls = { count: 0 };
	const app = new Hono<AppEnv>();
	app.use(evlog());
	app.use(async (c, next) => {
		c.set("actorId", actorId);
		c.set("activeOrganizationId", activeOrganizationId);
		await next();
	});
	app.use(requireOrg);

	app.get("/things", (c) => {
		calls.count += 1;
		return ok(c, {
			organizationId: c.get("organizationId"),
			role: c.get("role"),
		});
	});
	app.onError((error, c) => failure(c, error));
	return { app, calls };
}

describe.skipIf(!ready)("requireOrg", () => {
	it("hands the handler the tenant and the role from the membership row", async () => {
		const [organizationId, actorId] = await Promise.all([
			seedOrganization(),
			seedUser(),
		]);
		await seedMember(organizationId, actorId, "admin");

		const { app, calls } = buildApp(actorId, organizationId);

		const response = await app.request("/things");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: { organizationId, role: "admin" },
		});
		expect(calls.count).toBe(1);
	});

	/**
	 * The regression this middleware exists for. Better Auth clears
	 * `activeOrganizationId` only when a user removes themselves, so after an admin
	 * removes someone the removed user's session still points at the organization.
	 * A guard that trusted the pointer answered 200 here, and a saved cookie was
	 * enough to keep reading the tenant's rows for the session's whole lifetime.
	 */
	it("rejects an actor whose membership no longer exists as 403", async () => {
		const [organizationId, actorId] = await Promise.all([
			seedOrganization(),
			seedUser(),
		]);
		// Deliberately no `seedMember`: this is the shape of a session that outlived
		// its membership.

		const { app, calls } = buildApp(actorId, organizationId);

		const response = await app.request("/things");
		expect(response.status).toBe(403);
		expect(((await response.json()) as ErrorEnvelope).error.code).toBe(
			"FORBIDDEN"
		);
		expect(calls.count).toBe(0);
	});

	it("rejects an actor holding a pointer to someone else's organization", async () => {
		const [ownOrganization, otherOrganization, actorId] = await Promise.all([
			seedOrganization(),
			seedOrganization(),
			seedUser(),
		]);
		await seedMember(ownOrganization, actorId);

		const { app, calls } = buildApp(actorId, otherOrganization);

		expect((await app.request("/things")).status).toBe(403);
		expect(calls.count).toBe(0);
	});

	/**
	 * 403 rather than 401 is load-bearing: the SPA branches on it to send a signed-in
	 * but organization-less user to onboarding, so a 401 would bounce them to the
	 * sign-in screen they just came from.
	 */
	it("rejects a signed-in actor with no active organization as 403", async () => {
		const { app, calls } = buildApp(await seedUser(), null);

		const response = await app.request("/things");
		expect(response.status).toBe(403);
		expect(((await response.json()) as ErrorEnvelope).error.code).toBe(
			"FORBIDDEN"
		);
		expect(calls.count).toBe(0);
	});

	describe("wide event", () => {
		afterEach(() => {
			initLogger({ drain: () => Promise.resolve(), silent: true });
		});

		it("records the tenant every request acted on", async () => {
			const [organizationId, actorId] = await Promise.all([
				seedOrganization(),
				seedUser(),
			]);
			await seedMember(organizationId, actorId);

			const events: DrainContext[] = [];
			initLogger({
				drain: (context) => {
					events.push(context);
				},
				silent: true,
			});

			await buildApp(actorId, organizationId).app.request("/things");

			expect(events).toHaveLength(1);
			expect(events[0]?.event.organization).toEqual({ id: organizationId });
		});
	});
});
