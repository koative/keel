import { afterEach, describe, expect, it } from "bun:test";
import { failure, ok } from "@keel/http/response";
import { type DrainContext, initLogger } from "evlog";
import { evlog } from "evlog/hono";
import { Hono } from "hono";
import { requireOrg } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
import type { ErrorEnvelope } from "../../test-http";

/**
 * `requireOrg` is driven through a throwaway app rather than the real one, and
 * needs no database: it only reads what `requireUser` left on the context. The
 * stub below is that guard's entire contribution as far as this middleware is
 * concerned, which is what lets the tenancy contract be tested without a
 * session, a user, or an organization row.
 *
 * `requireUser`'s own 401 is exercised where it is mounted, in
 * `projects.routes.test.ts`, because it needs a real Better Auth session.
 */
function buildApp(activeOrganizationId: string | null) {
	const calls = { count: 0 };
	const app = new Hono<AppEnv>();
	app.use(evlog());
	app.use(async (c, next) => {
		c.set("activeOrganizationId", activeOrganizationId);
		await next();
	});
	app.use(requireOrg);

	app.get("/things", (c) => {
		calls.count += 1;
		return ok(c, { organizationId: c.get("organizationId") });
	});
	app.onError((error, c) => failure(c, error));
	return { app, calls };
}

describe("requireOrg", () => {
	it("hands the handler the active organization as a plain string", async () => {
		const { app, calls } = buildApp("org_alpha");

		const response = await app.request("/things");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			data: { organizationId: "org_alpha" },
		});
		expect(calls.count).toBe(1);
	});

	/**
	 * 403 rather than 401 is the load-bearing part: the SPA branches on it to send
	 * a signed-in but organization-less user to onboarding, so downgrading this to
	 * a 401 would bounce them to the sign-in screen they just came from.
	 */
	it("rejects a signed-in actor with no active organization as 403", async () => {
		const { app, calls } = buildApp(null);

		const response = await app.request("/things");
		expect(response.status).toBe(403);

		const body = (await response.json()) as ErrorEnvelope;
		expect(body.error.code).toBe("FORBIDDEN");
		// The guard must short-circuit, not merely annotate: a handler that ran
		// would have queried without a tenant filter.
		expect(calls.count).toBe(0);
	});

	describe("wide event", () => {
		afterEach(() => {
			initLogger({ drain: () => Promise.resolve(), silent: true });
		});

		it("records the tenant every request acted on", async () => {
			const events: DrainContext[] = [];
			initLogger({
				drain: (context) => {
					events.push(context);
				},
				silent: true,
			});

			await buildApp("org_beta").app.request("/things");

			expect(events).toHaveLength(1);
			expect(events[0]?.event.organization).toEqual({ id: "org_beta" });
		});
	});
});
