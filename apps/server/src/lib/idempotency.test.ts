import { describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { idempotencyKey } from "@keel/db/schema/idempotency";
import { errorSchema } from "@keel/http/envelope";
import { created, failure } from "@keel/http/response";
import type { ErrorCode } from "@keel/http/status";
import { eq } from "drizzle-orm";
import { evlog } from "evlog/hono";
import { Hono } from "hono";
import type { AppEnv } from "@/lib/context";
import { idempotent } from "@/lib/idempotency";
import { insert, sweepExpiredKeys } from "@/lib/idempotency.repository";
import {
	seedOrganization,
	seedUser,
	skipNotice,
	testDbReady,
} from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("idempotency"));
}

/**
 * Driven through a throwaway Hono app rather than the real one: the middleware
 * is mounted by whoever needs it, so the thing under test is the middleware plus
 * a handler, not the route table. The stub that sets `actorId` and
 * `organizationId` stands in for `requireUser` and `requireOrg`, which is the
 * only reason this can run without a session; each app seeds its own user and
 * organization.
 */
async function buildApp(actorId?: string, organizationId?: string) {
	const owner = actorId ?? (await seedUser());
	const tenant = organizationId ?? (await seedOrganization());
	const calls = { count: 0 };
	const app = new Hono<AppEnv>();
	app.use(evlog());
	app.use(async (c, next) => {
		c.set("actorId", owner);
		c.set("organizationId", tenant);
		await next();
	});
	app.use(idempotent);

	app.post("/things", async (c) => {
		calls.count += 1;
		const body = await c.req.json<{ boom?: boolean; name: string }>();
		if (body.boom) {
			throw new Error("handler exploded");
		}
		return created(c, { attempt: calls.count, echoed: body.name });
	});
	app.post("/others", (c) => created(c, { where: "others" }));
	app.onError((error, c) => failure(c, error));
	return { actorId: owner, app, calls, organizationId: tenant };
}

function post(app: Hono<AppEnv>, path: string, body: unknown, key?: string) {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (key !== undefined) {
		headers.set("Idempotency-Key", key);
	}
	return app.request(path, {
		body: JSON.stringify(body),
		headers,
		method: "POST",
	});
}

const storedFor = (actorId: string) =>
	db.select().from(idempotencyKey).where(eq(idempotencyKey.actorId, actorId));

// The wire code a server failure carries through the real onError is the key
// name of the 500 status in @keel/http's single table (response.ts maps the
// status to its own key name). Typed as ErrorCode so a rename fails this test.
const INTERNAL_CODE: ErrorCode = "INTERNAL_SERVER_ERROR";

describe.skipIf(!ready)("idempotency middleware", () => {
	it("passes a request without the header straight through", async () => {
		const { app, calls, actorId } = await buildApp();
		const response = await post(app, "/things", { name: "plain" });

		expect(response.status).toBe(201);
		expect(calls.count).toBe(1);
		expect(await storedFor(actorId)).toHaveLength(0);
	});

	// The handler reads the body with c.req.json() after the middleware read it
	// with c.req.text(); a broken body cache shows up here as a 500.
	it("replays the first reply byte for byte on a repeat", async () => {
		const { app, calls } = await buildApp();
		const key = crypto.randomUUID();
		const first = await post(app, "/things", { name: "once" }, key);
		const second = await post(app, "/things", { name: "once" }, key);

		expect(calls.count).toBe(1);
		expect(first.headers.get("Idempotency-Replayed")).toBeNull();
		expect(second.headers.get("Idempotency-Replayed")).toBe("true");
		expect(second.status).toBe(first.status);
		expect(await second.text()).toBe(await first.text());
	});

	it("rejects the same key with a different body as a 409", async () => {
		const { app, calls } = await buildApp();
		const key = crypto.randomUUID();
		await post(app, "/things", { name: "first" }, key);
		const response = await post(app, "/things", { name: "second" }, key);

		expect(response.status).toBe(409);
		expect(calls.count).toBe(1);
	});

	it("rejects the same key on a different path as a 409", async () => {
		const { app, calls } = await buildApp();
		const key = crypto.randomUUID();
		await post(app, "/things", { name: "first" }, key);
		const response = await post(app, "/others", { name: "first" }, key);

		expect(response.status).toBe(409);
		expect(calls.count).toBe(1);
	});

	it("stores nothing for a failure so the retry reaches the handler", async () => {
		const { app, calls, actorId } = await buildApp();
		const key = crypto.randomUUID();
		const first = await post(app, "/things", { boom: true, name: "x" }, key);
		expect(first.status).toBe(500);
		// The thrown message stays masked through the real onError: the client
		// sees the server-failure code, a correlatable id, and none of the text.
		const firstBody = errorSchema.parse(await first.json());
		expect(firstBody.error.code).toBe(INTERNAL_CODE);
		expect(firstBody.error.requestId.length).toBeGreaterThan(0);
		expect(firstBody.error.message).not.toContain("handler exploded");
		expect(await storedFor(actorId)).toHaveLength(0);
		const retry = await post(app, "/things", { boom: true, name: "x" }, key);
		expect(retry.status).toBe(500);
		expect(calls.count).toBe(2);
	});

	it("rejects an empty or over-long key as a 400", async () => {
		const { app, calls } = await buildApp();
		const empty = await post(app, "/things", { name: "x" }, "   ");
		const long = await post(app, "/things", { name: "x" }, "k".repeat(256));

		expect(empty.status).toBe(400);
		expect(long.status).toBe(400);
		expect(calls.count).toBe(0);
	});

	// An expired row is invisible to the client but still occupies the unique
	// slot, so it has to be cleared on the way past rather than reported as a
	// conflict — hence the deliberately mismatched hash.
	it("treats an expired record as absent and runs the handler again", async () => {
		const { app, calls, actorId, organizationId } = await buildApp();
		const key = crypto.randomUUID();
		await insert({
			actorId,
			expiresAt: new Date(Date.now() - 1000),
			key,
			method: "POST",
			organizationId,
			path: "/things",
			requestHash: "stale",
			response: { body: '{"data":{"attempt":0}}' },
			status: 201,
		});

		const response = await post(app, "/things", { name: "fresh" }, key);
		const rows = await storedFor(actorId);

		expect(response.status).toBe(201);
		expect(calls.count).toBe(1);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.requestHash).not.toBe("stale");
	});

	it("sweeps only the rows past their expiry", async () => {
		const { actorId, organizationId } = await buildApp();
		const base = {
			actorId,
			method: "POST",
			organizationId,
			path: "/things",
			requestHash: "hash",
			response: { body: "{}" },
			status: 201,
		};
		await insert({
			...base,
			expiresAt: new Date(Date.now() - 1000),
			key: "expired",
		});
		await insert({
			...base,
			expiresAt: new Date(Date.now() + 60_000),
			key: "live",
		});

		const removed = await sweepExpiredKeys();
		const rows = await storedFor(actorId);

		expect(removed).toBeGreaterThanOrEqual(1);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.key).toBe("live");
	});
});
