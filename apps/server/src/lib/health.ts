import { db } from "@keel/db";
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
 * `probe` defaults to the cheapest statement that proves a connection is usable
 * end to end. Tests inject their own; nothing in the application passes one.
 */
export async function checkReadiness(
	probe: () => Promise<unknown> = () => db.execute(sql`select 1`)
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
	} catch {
		// The rejection value is deliberately not bound. A node-postgres failure
		// carries the host, port, user, password and database it could not reach,
		// and this string is served to an unauthenticated caller.
		return {
			ready: false,
			reason: expired ? "database probe timed out" : "database unreachable",
		};
	} finally {
		clearTimeout(timer);
	}
}
