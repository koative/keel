import { hostname } from "node:os";
import { generate } from "@keel/ai/generate";
import { closePool } from "@keel/db";
import { env } from "@keel/env/server";
import { sendMail } from "@keel/mail/send";
import { z } from "zod";
import { aiModel } from "@/lib/ai";
import { hasUsageForJob, recordUsage } from "@/lib/ai.repository";
import { type JobRegistry, runOnce } from "@/lib/jobs";
import { resolveMailConfig } from "@/lib/mail";

/**
 * Background worker entrypoint: `bun dist/worker.mjs`.
 *
 * A separate process from the server on purpose. Polling inside the API would
 * make every web replica also a worker — so the two scale together whether or
 * not that is what the load needs — and would put arbitrary job code on the same
 * connection pool the request path depends on.
 */

/**
 * A job payload is `unknown` and stays that way until something checks it: the
 * row was written by whichever release was deployed at the time and rows outlive
 * deploys, so the shape is a wire contract with the past, not a local type.
 */
const mailMessage = z.object({
	html: z.string(),
	subject: z.string(),
	text: z.string(),
	to: z.email(),
});

const aiGeneration = z.object({
	/**
	 * Who is billed. A job carries no request context — the session that created
	 * this row is gone by the time a worker claims it — so the tenant has to be
	 * in the payload or the ledger cannot be written at all.
	 */
	organizationId: z.string().min(1),
	prompt: z.string().min(1),
});

// Resolved once, at startup, so a deployment that asked for `resend` without a
// key fails to boot rather than discovering it on the first sign-up.
const mailConfig = resolveMailConfig();

/**
 * Every job kind this worker can run.
 *
 * `mail.send` and `ai.generate` are what a starter ships: delivery is the one
 * piece of background work every consumer needs, and a model call is the one
 * that cannot fit in a request. Add others the same way —
 * `registry.set("report.build", buildReport)` — or assign a registry a module
 * owns.
 */
export const registry: JobRegistry = new Map();

registry.set("mail.send", async (payload, jobId) => {
	// The job id, not a fresh value: it is the one identifier stable across
	// retries, so a redelivery of an attempt that actually reached the provider
	// is rejected as a duplicate instead of mailing a user twice.
	await sendMail(mailConfig, mailMessage.parse(payload), jobId);
});

registry.set("ai.generate", async (payload, jobId) => {
	const request = aiGeneration.parse(payload);

	// The guard that stops a retry from buying the same completion twice, and the
	// reason `ai_usage.job_id` is unique. `idempotency.ts` solves this shape for
	// HTTP by replaying a stored response; there is no response to replay here,
	// so the ledger row itself is the marker that says the call already happened.
	//
	// What this buys: every failure after the ledger commits is free. That is the
	// likely one — the handler still has to return and the queue still has to
	// mark the job `complete`, and a process killed or a connection lost in that
	// window is what sends a finished job back to `pending`.
	//
	// What it does not buy: the window between the provider charging and this row
	// committing, roughly one round trip wide. A crash there loses the record and
	// the retry pays again. Closing it needs an idempotency key the provider
	// honours, which text-generation APIs do not offer — and writing the row
	// before the call instead would only trade a double charge for a job that
	// silently produces no answer, plus a ledger recording charges that may never
	// have happened. So: at-most-once billing after the ledger commits,
	// at-least-once before it.
	if (await hasUsageForJob(jobId)) {
		return;
	}

	const generation = await generate(aiModel(), { prompt: request.prompt });

	await recordUsage({
		inputTokens: generation.usage.inputTokens,
		jobId,
		model: generation.model,
		organizationId: request.organizationId,
		outputTokens: generation.usage.outputTokens,
	});

	// The completion is written out and then dropped, because a starter has
	// nowhere honest to put it: what a generated answer belongs to is a domain
	// question, and inventing a table for a resource that does not exist yet is
	// the abstraction this repo is against. This line is the seam — replace it
	// with the write that stores the answer against whatever asked for it.
	process.stdout.write(
		`[ai.generate] ${jobId} ${generation.model} in=${generation.usage.inputTokens} out=${generation.usage.outputTokens}\n${generation.text}\n`
	);
});

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
