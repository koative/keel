import { describe, expect, it } from "bun:test";
import { created, failure } from "@keel/http/response";
import { evlog } from "evlog/hono";
import { Hono } from "hono";
import type { AppEnv } from "@/lib/context";
import { idempotent } from "@/lib/idempotency";

/**
 * `identity` is what a guard has already put on the context by the time
 * `idempotent` runs: `{}` is the middleware mounted above `requireUser`, and
 * `{ actorId }` is it mounted between the two guards, which is the other half of
 * the same clause.
 */
function buildMisorderedApp(identity: { actorId?: string }) {
	const calls = { count: 0 };
	const app = new Hono<AppEnv>();
	app.use(evlog());
	app.use(async (c, next) => {
		if (identity.actorId) {
			c.set("actorId", identity.actorId);
		}
		await next();
	});
	app.use(idempotent);
	app.post("/things", (c) => {
		calls.count += 1;
		return created(c, { where: "things" });
	});
	app.onError((error, c) => failure(c, error));
	return { app, calls };
}

function post(app: Hono<AppEnv>, key?: string) {
	const headers = new Headers({ "Content-Type": "application/json" });
	if (key !== undefined) {
		headers.set("Idempotency-Key", key);
	}
	return app.request("/things", {
		body: JSON.stringify({ name: "x" }),
		headers,
		method: "POST",
	});
}

/**
 * The middleware's one wiring fact, asserted the way `security.test.ts` asserts
 * where `requestBodyLimit` sits: what is under test is the order, not the
 * behaviour `idempotency.test.ts` already covers.
 *
 * Its own file rather than a describe in that suite, because this one carries no
 * `testDbReady()` gate and seeds nothing. The guard has to refuse before the
 * repository is reached, so it runs whether or not Postgres is up — the day it
 * needs a database is the day the guard runs too late.
 */
describe("idempotency middleware mounted above its guards", () => {
	/*
	 * Neither request carries an `Idempotency-Key`, and that is what makes this a
	 * pin rather than a test that passes either way. With a key, a middleware
	 * mounted too high still reaches `claim`, and Postgres refuses the insert
	 * with `null value in column "actor_id"` — the same 500 this asserts, from
	 * the table's `not null` and not from the guard. Without a key nothing
	 * downstream is touched, so only the guard can produce a refusal.
	 */
	it("refuses when the identity its key space is scoped to is absent", async () => {
		const above = buildMisorderedApp({});
		const unscoped = await post(above.app);
		const body = (await unscoped.json()) as { error: { code: string } };

		// The actor-but-no-tenant half of the same clause: mounted after
		// `requireUser` and still above `requireOrg`.
		const between = buildMisorderedApp({ actorId: crypto.randomUUID() });
		const untenanted = await post(between.app);

		// A 500, not a 4xx: nothing the caller sent is wrong.
		expect(unscoped.status).toBe(500);
		expect(body.error.code).toBe("INTERNAL_SERVER_ERROR");
		expect(untenanted.status).toBe(500);
		// And neither request reached the handler whose reply would have been
		// stored under a key every other client shares.
		expect(above.calls.count).toBe(0);
		expect(between.calls.count).toBe(0);
	});
});
