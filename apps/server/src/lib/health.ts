import { db } from "@keel/db";
import { hasSqlState, UNDEFINED_TABLE } from "@keel/db/errors";
import { sql } from "drizzle-orm";

interface DatabaseNotReady {
	ready: false;
	reason: string;
}

interface DatabaseReady {
	ready: true;
}

/**
 * The result of a readiness probe. Discriminated so a caller cannot render a
 * reason it never checked for, or forget to.
 */
export type Readiness = DatabaseNotReady | DatabaseReady;

/**
 * A probe that outlives this is treated as a failure. An orchestrator retries on
 * its own schedule; a probe that blocks instead of answering turns one sick
 * dependency into a stuck rollout.
 */
const PROBE_BUDGET_MS = 2000;

/**
 * Answers whether this process can serve traffic.
 *
 * The budget is enforced client-side rather than with a session `statement_timeout`
 * because that is not the failure being defended against: `select 1` cannot be
 * slow once it reaches Postgres, and Drizzle checks out a pooled connection per
 * call, so a GUC set outside a transaction would not even apply to the next one.
 * What actually hangs is acquiring a connection — a saturated pool or a black-holed
 * network — and only a client-side deadline bounds that.
 *
 * `probe` defaults to the cheapest statement that proves both that a connection is
 * usable end to end and that the schema has been applied. `select 1` proved only
 * the former, and a container pointed at an empty database answered "ready" while
 * every real request returned 500 — the same lie as a healthcheck on a route that
 * cannot fail, one level subtler. `limit 0` touches no rows, so the cost is a parse
 * and a plan; the relation still has to exist for either to succeed.
 *
 * Tests inject their own; nothing in the application passes one.
 */
export async function checkReadiness(
	probe: () => Promise<unknown> = () =>
		db.execute(sql`select 1 from "user" limit 0`)
): Promise<Readiness> {
	const deadline = Promise.withResolvers<never>();
	let expired = false;

	const timer = setTimeout(() => {
		expired = true;
		deadline.reject(new Error("readiness probe exceeded its budget"));
	}, PROBE_BUDGET_MS);

	try {
		await Promise.race([probe(), deadline.promise]);
		return { ready: true };
	} catch (error) {
		// Only the SQLSTATE is read. A node-postgres failure carries the host, port,
		// user, password and database it could not reach, and this string is served
		// to an unauthenticated caller.
		if (hasSqlState(error, UNDEFINED_TABLE)) {
			return { ready: false, reason: "database schema not applied" };
		}

		return {
			ready: false,
			reason: expired ? "database probe timed out" : "database unreachable",
		};
	} finally {
		clearTimeout(timer);
	}
}
