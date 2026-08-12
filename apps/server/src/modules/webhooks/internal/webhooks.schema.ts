import { z } from "zod";

/**
 * The providers this receiver knows, and the two reference grammars they stand
 * for. Each grammar is documented in `webhooks.handlers.ts`, which is the one
 * place that knows them: `webhook.ts` stays provider-agnostic and only sees
 * bytes.
 *
 * - `generic` — a provider that stamps and signs a timestamp, transported in
 *   its own header (the Slack/Svix shape) with the prefix spelling Stripe uses.
 * - `bare` — a provider that signs the body alone and sends no timestamp (the
 *   GitHub shape, genericised).
 *
 * A real provider integration maps its wire format onto one of these two
 * grammars; adding a third grammar is a one-file change in the handler.
 */
export const webhookProviderSchema = z.object({
	provider: z.enum(["generic", "bare"]),
});

export type WebhookProvider = z.infer<typeof webhookProviderSchema>["provider"];

/**
 * The optional timestamp input a timestamped provider carries outside its
 * signature header. The signature header itself is deliberately NOT validated
 * here: it must reach `verifySignature` verbatim, and that function's contract
 * is to refuse a missing, empty or malformed value rather than throw.
 *
 * Unix seconds, decimal, no sign. The handler derives the signed prefix from
 * this same value, which is what makes the timestamp authenticated rather than
 * advisory: relabelling a stale capture moves the prefix and the digest stops
 * matching.
 */
export const webhookHeadersSchema = z.object({
	"x-webhook-timestamp": z
		.string()
		.regex(/^\d{1,10}$/, "Unix seconds, decimal digits")
		.optional(),
});

export type WebhookHeaders = z.infer<typeof webhookHeadersSchema>;
