import { describe, expect, it } from "bun:test";
import { env } from "@keel/env/server";
import { skipNotice, testDbReady } from "../../test-db";
import { checkReadiness } from "./health";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("lib/health"));
}

describe("checkReadiness", () => {
	it("reports not-ready when the database is unreachable", async () => {
		const result = await checkReadiness(() =>
			Promise.reject(
				new Error(
					`connect ECONNREFUSED 127.0.0.1:5432 while opening ${env.DATABASE_URL}`
				)
			)
		);

		expect(result).toEqual({ ready: false, reason: "database unreachable" });
	});

	// /ready is unauthenticated by necessity — an orchestrator has no session — so
	// its body is public. A node-postgres failure quotes the whole DSN, password
	// included, which is why the reason is a fixed string rather than the message.
	it("never leaks the connection string into the reason", async () => {
		const result = await checkReadiness(() =>
			Promise.reject(new Error(env.DATABASE_URL))
		);

		if (result.ready) {
			throw new Error("expected the probe to fail");
		}

		expect(result.reason).not.toContain(env.DATABASE_URL);
		expect(result.reason).not.toContain("postgres");
		expect(result.reason).not.toContain("password");
	});

	// The budget is the whole reason this is not a bare `await db.execute(...)`:
	// a black-holed database must not be able to hold a rollout open.
	it("gives up rather than waiting on a probe that never settles", async () => {
		const started = Bun.nanoseconds();
		const result = await checkReadiness(
			() => Promise.withResolvers<never>().promise
		);
		const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

		expect(result).toEqual({
			ready: false,
			reason: "database probe timed out",
		});
		expect(elapsedMs).toBeLessThan(2500);
	});
});

// Exercises the real query against real Postgres, which is the only way to know
// the default probe is a statement the driver actually accepts.
describe.skipIf(!ready)("checkReadiness against Postgres", () => {
	it("reports ready", async () => {
		expect(await checkReadiness()).toEqual({ ready: true });
	});
});
