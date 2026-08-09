import { hostname } from "node:os";
import { closePool } from "@keel/db";
import { env } from "@keel/env/server";
import { type JobRegistry, runOnce } from "@/lib/jobs";

/**
 * Background worker entrypoint: `bun dist/worker.mjs`.
 *
 * A separate process from the server on purpose. Polling inside the API would
 * make every web replica also a worker — so the two scale together whether or
 * not that is what the load needs — and would put arbitrary job code on the same
 * connection pool the request path depends on.
 */

/**
 * Every job kind this worker can run.
 *
 * Exported and empty: a starter has no jobs of its own, and any example shipped
 * here would be an example every consumer has to find and delete. Add entries —
 * `registry.set("email.send", sendEmail)` — or assign a registry a module owns.
 */
export const registry: JobRegistry = new Map();

/**
 * How long the drain may take before the process is killed regardless.
 *
 * Same reasoning as the server's: an orchestrator's own kill timer fires either
 * way, and a shutdown that hangs forever on one stuck handler loses the same
 * work as one that gives up — minus the exit code that says which happened.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;

// hostname:pid rather than a uuid: this string is written to `locked_by`, and
// the point of reading that column is to go and look at the process holding the
// row. A uuid identifies it uniquely and tells you nothing about where it is.
const workerId = `${hostname()}:${process.pid}`;

let accepting = true;
let interruptSleep: (() => void) | null = null;

/** Resolves early when the shutdown path interrupts it. */
function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	const timer = setTimeout(resolve, ms);
	interruptSleep = () => {
		clearTimeout(timer);
		resolve();
	};
	return promise;
}

async function loop(): Promise<void> {
	while (accepting) {
		let processed = 0;

		try {
			// biome-ignore lint/performance/noAwaitInLoops: this is the poll cycle itself, unbounded and serial by definition — the next pass exists only because this one finished, and its count decides whether to sleep.
			processed = await runOnce(registry, workerId, env.WORKER_BATCH_SIZE);
		} catch (error) {
			// A throw out of runOnce is the queue itself being unreachable, not a
			// job failing — a handler's error is already recorded on its row. Log
			// and keep polling: that rides out a failover, where exiting would turn
			// a few seconds of unavailability into a restart loop.
			process.stderr.write(`[worker] poll failed: ${String(error)}\n`);
		}

		// A full batch means more work was already due when it was claimed, so poll
		// again immediately instead of idling with a backlog.
		if (processed < env.WORKER_BATCH_SIZE) {
			await sleep(env.WORKER_POLL_MS);
		}
	}
}

/** Never rejects: the failure paths exit rather than propagate. */
async function shutdown(signal: string): Promise<void> {
	// A second Ctrl-C, or an orchestrator escalating SIGTERM, must not restart
	// the sequence and call `pool.end()` twice.
	if (!accepting) {
		return;
	}
	accepting = false;
	interruptSleep?.();

	process.stdout.write(`[worker] ${signal} received, draining\n`);

	const deadline = setTimeout(() => {
		process.stderr.write(
			`[worker] still draining after ${SHUTDOWN_DEADLINE_MS}ms, exiting anyway\n`
		);
		process.exit(1);
	}, SHUTDOWN_DEADLINE_MS);

	try {
		// The batch in flight finishes first: abandoning it would leave its jobs
		// in `running` with no worker left to complete or fail them. The pool
		// closes only afterwards, for the same reason the server closes it last.
		await finished;
		await closePool();
	} catch (error) {
		process.stderr.write(`[worker] drain failed: ${String(error)}\n`);
		process.exit(1);
	}

	clearTimeout(deadline);
	process.stdout.write("[worker] drained\n");
	process.exit(0);
}

process.stdout.write(
	`[worker] ${workerId} polling every ${env.WORKER_POLL_MS}ms, batch ${env.WORKER_BATCH_SIZE}\n`
);

const finished = loop();

// Handled here as well as in `shutdown`, so a rejection with no signal pending
// exits loudly instead of leaving a process that is alive but no longer polling.
finished.catch((error) => {
	process.stderr.write(`[worker] loop stopped: ${String(error)}\n`);
	process.exit(1);
});

// SIGTERM is what an orchestrator sends; SIGINT is Ctrl-C. Both take the same
// path so that a local run exercises the production shutdown.
for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		shutdown(signal).catch(() => process.exit(1));
	});
}
