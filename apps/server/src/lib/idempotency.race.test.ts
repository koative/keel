import { describe, expect, it } from "bun:test";
import { created, failure } from "@keel/http/response";
import { evlog } from "evlog/hono";
import { Hono } from "hono";
import type { AppEnv } from "@/lib/context";
import { idempotent } from "@/lib/idempotency";
import { claim } from "@/lib/idempotency.repository";
import {
	seedOrganization,
	seedUser,
	skipNotice,
	testDbReady,
} from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("idempotency race"));
}

/**
 * The two behaviours the org-scoped, claim-first middleware exists for, kept
 * apart from idempotency.test.ts so neither file outgrows the 200-line cap:
 * the concurrent same-key race and the organization switch. Same throwaway-app
 * shape as the other suite; `hold` gates the handler so the race test can pin
 * one request while a second is refused.
 */
async function buildApp(
	options: {
		actorId?: string;
		hold?: () => Promise<void>;
		organizationId?: string;
	} = {}
) {
	const owner = options.actorId ?? (await seedUser());
	const tenant = options.organizationId ?? (await seedOrganization());
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
		await options.hold?.();
		return created(c, { attempt: calls.count });
	});
	app.onError((error, c) => failure(c, error));
	return { app, calls };
}

function post(app: Hono<AppEnv>, body: unknown, key?: string) {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (key !== undefined) {
		headers.set("Idempotency-Key", key);
	}
	return app.request("/things", {
		body: JSON.stringify(body),
		headers,
		method: "POST",
	});
}

describe.skipIf(!ready)("idempotency race and tenant scope", () => {
	// The claim is inserted before the handler runs, so a request that finds the
	// key already claimed — status 0, the placeholder for "in flight" — must be
	// refused without reaching the handler. The gate makes the race
	// deterministic: the second request is only issued once the first provably
	// holds the claim, and the first cannot answer until it is released.
	it("runs the handler once when two same-key requests race", async () => {
		const key = crypto.randomUUID();
		const { promise: gate, resolve: release } = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		const { app, calls } = await buildApp({
			hold: () => {
				entered.resolve();
				return gate;
			},
		});

		const first = post(app, { name: "race" }, key);
		await entered.promise;
		const second = await post(app, { name: "race" }, key);
		release();

		expect((await first).status).toBe(201);
		expect(second.status).toBe(409);
		expect(calls.count).toBe(1);
	});

	// The claim insert is the arbiter of the race: a second claim for the same
	// key comes back empty, which is the signal the middleware turns into the
	// loser's 409 before its handler runs.
	it("gives the claim to exactly one caller", async () => {
		const actorId = await seedUser();
		const organizationId = await seedOrganization();
		const record = {
			actorId,
			expiresAt: new Date(Date.now() + 60_000),
			key: crypto.randomUUID(),
			method: "POST",
			organizationId,
			path: "/things",
			requestHash: "hash",
		};

		expect(await claim(record)).toBeDefined();
		expect(await claim(record)).toBeUndefined();
	});

	// The key space is (actorId, organizationId, key): a switch of organizations
	// lands in a fresh namespace, so B's request runs fresh instead of replaying
	// the reply org A stored under the same key.
	it("does not replay another organization's reply for the same key", async () => {
		const actorId = await seedUser();
		const orgA = await seedOrganization();
		const orgB = await seedOrganization();
		const appA = await buildApp({ actorId, organizationId: orgA });
		const appB = await buildApp({ actorId, organizationId: orgB });
		const key = crypto.randomUUID();

		expect((await post(appA.app, { name: "same" }, key)).status).toBe(201);
		const inB = await post(appB.app, { name: "same" }, key);

		expect(inB.status).toBe(201);
		expect(inB.headers.get("Idempotency-Replayed")).toBeNull();
		expect(appB.calls.count).toBe(1);
	});
});
