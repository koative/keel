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
 * endpoint's value, but as a correlation handle only: no route reads the `job`
 * table, so a client cannot watch the row settle over HTTP and has to trust the
 * worker. It is what an operator matches against the worker's output, and what a
 * status route would key on if one is ever added. `created: false` with a null
 * id means the `dedupeKey` named work already in flight, so this request joined
 * it rather than queueing again — which is the second charge that does not
 * happen.
 *
 * The stored key is the caller's prefixed with its tenant, because `job` is not
 * tenant-scoped: one global partial unique index on `dedupe_key` arbitrates the
 * whole table, so a raw client string would let one organization collapse
 * another's generation into a job it cannot read or even learn the id of.
 * Prefixed, a caller can only ever collide with itself.
 */
export async function generate(c: GenerateContext) {
	const { dedupeKey, prompt } = c.req.valid("json");
	const organizationId = c.get("organizationId");
	const { created, id } = await enqueueGeneration({
		dedupeKey: dedupeKey && `ai:${organizationId}:${dedupeKey}`,
		organizationId,
		prompt,
	});

	return ok(c, { created, jobId: id });
}
