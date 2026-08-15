import { hostname } from "node:os";
import { generate } from "@keel/ai/generate";
import { closePool } from "@keel/db";
import { env } from "@keel/env/server";
import { sendMail } from "@keel/mail/send";
import { z } from "zod";
import { aiModel } from "@/lib/ai";
import { hasUsageForJob, recordUsage } from "@/lib/ai.repository";
import { type JobRegistry, runOnce, shouldPollImmediately } from "@/lib/jobs";
import { resolveMailConfig } from "@/lib/mail";
import { webhookProcess } from "@/modules/webhooks";

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

	// The seam stays a seam, but stdout is the wrong sink for user data: in
	// production this lands in container logs, aggregated and readable far
	// beyond the database. Development keeps the echo — capped, because the
	// completion is unbounded — and production records only the durable
	// summary the usage ledger already holds.
	if (env.NODE_ENV !== "production") {
		process.stdout.write(
			`[ai.generate] ${jobId} ${generation.model} in=${generation.usage.inputTokens} out=${generation.usage.outputTokens}\n${generation.text.slice(0, 4000)}\n`
		);
	}
	// The webhooks module owns both halves: the receiver enqueues a delivery
	// that verified and persisted, this handler marks it processed. Idempotent
	// by design — the queue may run it twice, and the second run is a no-op.
	registry.set("webhook.process", webhookProcess);
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

		if (!shouldPollImmediately(processed, env.WORKER_BATCH_SIZE)) {
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

	// Only the clean path flushes: the deadline and drain-failure exits exist
	// because the process must leave now, and awaiting a flush there would
	// defeat the deadline's purpose.
	await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
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
