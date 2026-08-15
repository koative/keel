import { generate } from "@keel/ai/generate";
import { env } from "@keel/env/server";
import { sendMail } from "@keel/mail/send";
import { z } from "zod";
import { aiModel } from "@/lib/ai";
import { hasUsageForJob, recordUsage } from "@/lib/ai.repository";
import type { JobRegistry } from "@/lib/jobs";
import { resolveMailConfig } from "@/lib/mail";
import { webhookProcess } from "@/modules/webhooks";

/**
 * What the worker can run, separated from the process that runs it.
 *
 * `worker.ts` starts a poll loop at module scope, so importing it starts a
 * worker — which left this map unreachable from a test, and a registration that
 * no test can reach is one that can be silently lost. It was: `webhook.process`
 * spent a release nested inside the `ai.generate` handler, registered only as a
 * side effect of an AI job running. Same split as `app.ts` and `index.ts`: the
 * wiring is importable, the entrypoint is not.
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

// Resolved once, at import, so a deployment that asked for `resend` without a
// key fails to boot rather than discovering it on the first sign-up.
const mailConfig = resolveMailConfig();

/**
 * Every job kind this worker can run.
 *
 * `mail.send`, `ai.generate` and `webhook.process` are what a starter ships:
 * delivery is the one piece of background work every consumer needs, a model
 * call is the one that cannot fit in a request, and a webhook delivery is the
 * one that arrives from outside. Add others the same way —
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
});

// The webhooks module owns both halves: the receiver enqueues a delivery that
// verified and persisted, this handler marks it processed. Idempotent by design
// — the queue may run it twice, and the second run is a no-op.
registry.set("webhook.process", webhookProcess);
