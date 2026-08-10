import { enqueue } from "@keel/db/jobs";

/**
 * The kind the worker registers a handler for. Kept here rather than at the call
 * sites so the producer and the consumer cannot drift apart silently — a
 * mistyped kind enqueues a row no handler will ever claim.
 */
const KIND = "ai.generate";

export interface GenerationRequest {
	/**
	 * Optional, unlike mail's, and the caller has to think about it.
	 *
	 * Collapsing two identical AI calls saves real money, which argues for always
	 * setting one. But an LLM call is also the thing a user most legitimately
	 * repeats — "try that again" is a feature, not a double submit — and a key
	 * derived from the prompt would silently swallow it. So: a key when the work
	 * is idempotent by nature (summarise this document), none when the user asked
	 * for another answer.
	 */
	dedupeKey?: string;
	/**
	 * Which tenant is billed. Carried in the payload because a job has no request
	 * context: by the time the worker claims this row the session that created it
	 * is long gone, and the ledger cannot be written without it.
	 */
	organizationId: string;
	prompt: string;
}

/**
 * Hands a prompt to the queue. The worker calls the model.
 *
 * Nothing generates inside a request. A completion takes seconds, sometimes
 * tens of them, which does not fit in a request budget — and a provider that is
 * down would turn the user's action into a 504 after it had already succeeded
 * everywhere else. Streaming a response to a browser is the exception, and it is
 * a UI concern the AI SDK handles in a few lines; it is deliberately not this.
 */
export async function enqueueGeneration(
	request: GenerationRequest
): Promise<void> {
	await enqueue({
		dedupeKey: request.dedupeKey,
		kind: KIND,
		payload: {
			organizationId: request.organizationId,
			prompt: request.prompt,
		},
	});
}
