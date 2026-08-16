import { afterEach, describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { auditLog } from "@keel/db/schema/audit-log";
import { notFound } from "@keel/http/errors";
import { created, failure, ok } from "@keel/http/response";
import { desc, eq } from "drizzle-orm";
import { type DrainContext, initLogger } from "evlog";
import { evlog } from "evlog/hono";
import { Hono } from "hono";
import { audit } from "@/lib/audit";
import type { AppEnv } from "@/lib/context";
import {
	seedOrganization,
	seedUser,
	skipNotice,
	testDbReady,
} from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("audit middleware"));
}

/**
 * Driven through a throwaway Hono app rather than the real one: `app.ts` mounts
 * this middleware globally, so what is under test is the middleware plus a
 * handler, not the route table. The stub that sets `actorId` and
 * `organizationId` stands in for `requireUser` and `requireOrg` — which is also
 * how a request with neither is staged, the state both nullable columns exist
 * for.
 *
 * What the real stack records, and who may read it back, is in
 * `audit.read.test.ts`.
 */
function buildApp(actorId?: string, organizationId?: string) {
	const app = new Hono<AppEnv>();
	app.use(evlog());
	app.use("*", audit);
	app.use(async (c, next) => {
		if (actorId) {
			c.set("actorId", actorId);
		}
		if (organizationId) {
			c.set("organizationId", organizationId);
		}
		await next();
	});

	app.post("/things", (c) => created(c, { made: true }));
	app.get("/things", (c) => ok(c, { read: true }));
	app.delete("/things/gone", () => {
		throw notFound("Thing");
	});
	app.onError((error, c) => failure(c, error));
	return app;
}

const recorded = (actorId: string) =>
	db
		.select()
		.from(auditLog)
		.where(eq(auditLog.actorId, actorId))
		.orderBy(desc(auditLog.createdAt));

describe.skipIf(!ready)("audit middleware", () => {
	it("records a mutation with its actor, tenant, status and request id", async () => {
		const [actorId, organizationId] = await Promise.all([
			seedUser(),
			seedOrganization(),
		]);
		const requestId = crypto.randomUUID();

		const response = await buildApp(actorId, organizationId).request(
			"/things",
			{
				headers: { "x-request-id": requestId },
				method: "POST",
			}
		);
		expect(response.status).toBe(201);

		const rows = await recorded(actorId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			actorId,
			method: "POST",
			organizationId,
			path: "/things",
			requestId,
			status: 201,
		});
	});

	it("records nothing for a read", async () => {
		const actorId = await seedUser();

		const response = await buildApp(actorId).request("/things");
		expect(response.status).toBe(200);

		expect(await recorded(actorId)).toHaveLength(0);
	});

	/**
	 * The reason this middleware sits above every guard and every validator.
	 * Hono's compose hands a thrown error to `app.onError` at the frame that threw,
	 * so `c.res` is already the translated envelope by the time this middleware
	 * resumes — a refused attempt is recorded with the status the client received,
	 * which is the half of the trail an investigation actually reaches for.
	 */
	it("records a refused request with the status the client received", async () => {
		const actorId = await seedUser();

		const response = await buildApp(actorId).request("/things/gone", {
			method: "DELETE",
		});
		expect(response.status).toBe(404);

		const rows = await recorded(actorId);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ method: "DELETE", status: 404 });
	});

	/**
	 * An unauthenticated mutation — a sign-in attempt, a password reset — is
	 * recorded with no actor and no tenant rather than dropped, because those are
	 * the rows the trail is most often read for. Selected by request id, since
	 * there is no actor to select by.
	 */
	it("records a request that never reached a guard, with neither actor nor tenant", async () => {
		const requestId = crypto.randomUUID();

		await buildApp().request("/things", {
			headers: { "x-request-id": requestId },
			method: "POST",
		});

		const rows = await db
			.select()
			.from(auditLog)
			.where(eq(auditLog.requestId, requestId));
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ actorId: null, organizationId: null });
	});

	describe("when the insert fails", () => {
		afterEach(() => {
			initLogger({ drain: () => Promise.resolve(), silent: true });
		});

		/**
		 * A real failure rather than a stub: `actor_id` references `user`, so an
		 * actor who does not exist makes the INSERT throw where Postgres decides it
		 * throws. The client's write already happened, so the response must be
		 * untouched — and the lost line must be loud, because a hole in an audit
		 * trail is undetectable afterwards by construction.
		 */
		it("leaves the response untouched and reports the lost line", async () => {
			const events: DrainContext[] = [];
			initLogger({
				drain: (context) => {
					events.push(context);
				},
				silent: true,
			});

			const missingActor = crypto.randomUUID();
			const response = await buildApp(missingActor).request("/things", {
				method: "POST",
			});

			expect(response.status).toBe(201);
			expect(await response.json()).toEqual({ data: { made: true } });
			expect(await recorded(missingActor)).toHaveLength(0);

			expect(events).toHaveLength(1);
			expect(events[0]?.event.level).toBe("error");
			expect(events[0]?.event.auditLog).toEqual({ written: false });
			expect(JSON.stringify(events[0]?.event.error)).toContain("audit_log");
		});
	});
});
