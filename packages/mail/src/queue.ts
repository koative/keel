import { enqueue } from "@keel/db/jobs";

import type { MailMessage } from "./message";

/**
 * The kind the worker registers a handler for. Kept here rather than at the
 * call sites so the producer and the consumer cannot drift apart silently — a
 * mistyped kind enqueues a row no handler will ever claim.
 */
const KIND = "mail.send";

/**
 * Hands a rendered message to the queue. The worker sends it.
 *
 * Nothing sends inside a request. A provider that takes four seconds would make
 * sign-up take four seconds, and a provider that is down would turn a successful
 * registration into a 500 with the account already created.
 *
 * `dedupeKey` is required, not optional, because the endpoints that produce mail
 * here are all ones a user can hit repeatedly on purpose: "resend verification"
 * pressed three times is three requests, and the right outcome is one email.
 * While a mail for the same key is still pending, a second enqueue collapses
 * into it; once that one is claimed the key is free again, so a genuine resend
 * an hour later still works. Callers pick a key that names the message — the
 * recipient and what it is for — not one that names the attempt.
 */
export async function enqueueMail(
	message: MailMessage,
	dedupeKey: string
): Promise<void> {
	await enqueue({ dedupeKey, kind: KIND, payload: message });
}
