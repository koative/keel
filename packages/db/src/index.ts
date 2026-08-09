import { env } from "@keel/env/server";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";

import * as schema from "./schema";

/**
 * The pool is constructed explicitly rather than letting Drizzle build one from a
 * connection string, for two reasons.
 *
 * The defaults are wrong under load: node-postgres allows an unbounded pool and
 * waits forever for a connection, so a slow query storm turns into exhausted
 * database slots and requests that hang instead of failing. And an implicit pool
 * cannot be closed — `closePool` is what lets the server drain on SIGTERM instead
 * of dropping in-flight work.
 */
const pool = new Pool({
	connectionString: env.DATABASE_URL,
	// Fail fast rather than queueing forever behind a saturated pool. The request
	// surfaces as a 500 with a requestId, which is diagnosable; a hung request is not.
	connectionTimeoutMillis: 5000,
	// The matching hazard for writes: a transaction left open holds its locks and
	// blocks every writer to those rows until something notices.
	idle_in_transaction_session_timeout: env.STATEMENT_TIMEOUT_MS,
	idleTimeoutMillis: 30_000,
	// Postgres' own max_connections is the real ceiling; leave room for migrations,
	// psql sessions and a second instance during a rolling deploy.
	max: env.DATABASE_POOL_MAX,
	// A connection that has been alive for hours behind a proxy or failover is a
	// liability; recycling bounds how stale one can get.
	maxLifetimeSeconds: 1800,
	// A query with no ceiling holds its pooled connection for as long as Postgres
	// is willing to run it, so `max` runaway queries take the whole pool down and
	// every other request then fails on connectionTimeoutMillis — one bad plan
	// presenting as total unavailability. Enforced server-side, so it also covers
	// a client that stops waiting.
	statement_timeout: env.STATEMENT_TIMEOUT_MS,
});

// An idle-client error is emitted outside any request, so without a listener
// node-postgres crashes the process on a network blip.
pool.on("error", (error) => {
	process.stderr.write(`[db] idle client error: ${error.message}\n`);
});

export const db = drizzle(pool, { schema });

/** Drains the pool. Called once, from the server's shutdown path. */
export async function closePool(): Promise<void> {
	await pool.end();
}
