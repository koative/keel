import { z } from "zod";

/**
 * The prompt to generate from, bounded at 32000 characters — roughly eight
 * thousand tokens, large enough for a document-length prompt and small enough
 * that the job row that stores it stays a few tens of kilobytes. The payload
 * is persisted verbatim in Postgres and the worker pays for whatever this
 * admits, so the bound is the persisted payload's bound.
 */
const PROMPT_MAX = 32_000;

export const generateSchema = z.object({
	/**
	 * Opt-in collapse key, mirroring the queue's contract: pass one when the
	 * work is idempotent by nature ("summarise this document"), none when the
	 * user asked for another answer — the queue collapses a repeat of a keyed
	 * job that is still in flight, and it never invents a key of its own.
	 * Omitting one costs nothing until a retry: the same prompt enqueued again
	 * runs the work again instead of joining it. A name like
	 * `ai:<organizationId>:<prompt-hash>` follows the `domain:owner:what`
	 * style the mail kinds use.
	 */
	dedupeKey: z.string().min(1, "dedupeKey cannot be empty").optional(),
	prompt: z
		.string()
		.min(1, "A prompt needs at least one character")
		.max(PROMPT_MAX, "Prompts are at most 32000 characters"),
});

export type GenerateRequest = z.output<typeof generateSchema>;
