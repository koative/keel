import { enqueueGeneration } from "@keel/ai/queue";
import { ok } from "@keel/http/response";
import type { Context } from "hono";
import type { AppEnv } from "@/lib/context";
import type { GenerateRequest } from "./ai.schema";

type GenerateContext = Context<
	AppEnv,
	string,
	{ in: { json: GenerateRequest }; out: { json: GenerateRequest } }
>;

/**
 * Enqueues a generation and returns the job the worker will pick up.
 *
 * Nothing generates here — the whole point of the queue is that a completion,
 * which takes seconds, does not fit in a request budget. The job id is the
 * endpoint's value: a client can watch the row settle, or simply trust the
 * worker. `created: false` with a null id means the `dedupeKey` named work
 * already in flight, so this request joined it rather than queueing again —
 * which is the second charge that does not happen.
 */
export async function generate(c: GenerateContext) {
	const { dedupeKey, prompt } = c.req.valid("json");
	const { created, id } = await enqueueGeneration({
		dedupeKey,
		organizationId: c.get("organizationId"),
		prompt,
	});

	return ok(c, { created, jobId: id });
}
