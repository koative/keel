import { closePool } from "@keel/db";
import { initLogger } from "evlog";
import { resolveDrain } from "@/lib/observability";
import { app } from "./app";

// Process-wide and not idempotent: evlog's own docs warn that a second call
// without `drain` clears the drain for every copy of the package. This entry
// point is the only place allowed to call it, and it runs first so that a
// failure anywhere below is already observable when it happens.
initLogger({
	drain: resolveDrain(),
	env: { service: "keel-server" },
});

// No `port`: Bun resolves BUN_PORT, then PORT, then 3000 by itself, which is the
// same contract `export default { fetch }` had. Serving explicitly is what
// produces a handle to drain — a default export gives none, so SIGTERM dropped
// in-flight requests and left the pg pool open behind them.
const server = Bun.serve({ fetch: app.fetch });

process.stdout.write(
	`[server] listening on ${server.url.href} (port ${server.port})\n`
);

/**
 * How long the drain may take before the process is killed regardless.
 *
 * A deploy that waits forever on one stuck request is worse than a deploy that
 * drops it: the orchestrator's own kill timer fires either way, and this one at
 * least exits with a code that says which of the two happened.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;

let shuttingDown = false;

/** Never rejects: the failure paths exit rather than propagate. */
async function shutdown(signal: string): Promise<void> {
	// A second Ctrl-C, or an orchestrator escalating SIGTERM, must not restart the
	// sequence and call `pool.end()` twice.
	if (shuttingDown) {
		return;
	}
	shuttingDown = true;

	process.stdout.write(`[server] ${signal} received, draining\n`);

	const deadline = setTimeout(() => {
		process.stderr.write(
			`[server] still draining after ${SHUTDOWN_DEADLINE_MS}ms, exiting anyway\n`
		);
		process.exit(1);
	}, SHUTDOWN_DEADLINE_MS);

	try {
		// `false` stops accepting connections while letting in-flight requests
		// finish. The pool closes only afterwards: a handler still holding a
		// connection would otherwise fail at the least recoverable moment.
		await server.stop(false);
		await closePool();
	} catch (error) {
		process.stderr.write(`[server] drain failed: ${String(error)}\n`);
		process.exit(1);
	}

	clearTimeout(deadline);
	process.stdout.write("[server] drained\n");
	process.exit(0);
}

// SIGTERM is what an orchestrator sends; SIGINT is Ctrl-C. Both take the same
// path so that a local run exercises the production shutdown.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		shutdown(signal).catch(() => process.exit(1));
	});
}
