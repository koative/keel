/**
 * Signature verification for inbound provider webhooks.
 *
 * The receiver order is fixed, and getting it wrong is the usual way a webhook
 * endpoint fails in production:
 *
 * 1. Verify the signature over the raw request bytes. Nothing else happens
 *    first — an unsigned request must not be able to reach a parser, a query
 *    or a log line that an operator will later read as fact.
 * 2. Persist the raw payload exactly as received.
 * 3. Enqueue a job (`enqueue` in `./jobs`) referencing that payload.
 * 4. Return 200.
 *
 * Parsing and every piece of real work belong to the worker, not to the request
 * path. Providers allow a few seconds before they call the delivery failed and
 * retry it; an LLM call, an outbound API call or a multi-row write does not
 * reliably fit in that window. Doing the work inline means a slow dependency
 * turns one event into a retry, the retry into a second execution, and a
 * degraded dependency into a duplicate storm arriving exactly when the system
 * is least able to absorb it. Returning 200 the moment the event is durable
 * decouples our processing time from the provider's patience, and makes the
 * retry semantics ours to choose: the job row carries the attempt count.
 *
 * Deliberately provider-agnostic. Every provider spells the header differently;
 * the route knows its own header name, this module only knows bytes.
 */

import { createHmac } from "node:crypto";
import { safeEquals } from "@keel/crypto/equals";

/** Several providers prefix the digest with its algorithm; many send it bare. */
const ALGORITHM_PREFIX = "sha256=";

/**
 * SHA-256 is 32 bytes, so a hex digest is exactly 64 characters. Anything else
 * cannot be a digest we would have produced, and rejecting it here is what
 * makes a truncated or padded value fail on shape rather than on comparison.
 */
const HEX_DIGEST = /^[0-9a-f]{64}$/i;

export interface SignatureInput {
	/** The provider's signature header, as read off the request. */
	header: string | null | undefined;
	rawBody: ArrayBuffer;
	secret: string;
}

/**
 * Takes an `ArrayBuffer` — the exact bytes received — and never a parsed body.
 *
 * The provider computed its HMAC over the bytes it sent. A body that has been
 * parsed and re-stringified is a different byte sequence for the same value:
 * `JSON.stringify` emits keys in insertion order rather than the sender's,
 * drops the sender's whitespace and re-formats numbers (`1.0` becomes `1`,
 * `1e3` becomes `1000`). Any one of those changes the digest, so a receiver
 * built on a parsed body does not verify some events and fail others — it
 * rejects every single one, including the provider's own test delivery, which
 * is why the mistake usually survives until it is live.
 *
 * In Hono the raw bytes come from `await c.req.arrayBuffer()`.
 *
 * `./idempotency.ts` holds the exact bytes for the same class of reason. It
 * hashes `await c.req.text()` rather than the decoded body, because a stored
 * reply is only a valid replay for a byte-identical request; and the reply it
 * stores is kept as a string under `response.body` rather than as the decoded
 * envelope, because jsonb normalises object key order and a decode/re-encode
 * round trip would not hand back byte-for-byte the original answer. Same rule:
 * once bytes are the thing being compared, only bytes may be kept.
 *
 * Returns `false` for a missing, empty or malformed header rather than
 * throwing. A webhook endpoint that 500s on a garbage signature confirms to an
 * attacker that their probe reached application code, and it converts the
 * provider's ordinary retry behaviour into an error storm in our own alerting.
 */
export function verifySignature({
	header,
	rawBody,
	secret,
}: SignatureInput): boolean {
	if (!header) {
		return false;
	}

	const trimmed = header.trim();
	const supplied = trimmed.startsWith(ALGORITHM_PREFIX)
		? trimmed.slice(ALGORITHM_PREFIX.length)
		: trimmed;

	if (!HEX_DIGEST.test(supplied)) {
		return false;
	}

	// `Buffer.from(ArrayBuffer)` is a view over the same memory, so the body is
	// hashed without a second copy of it.
	const expected = createHmac("sha256", secret)
		.update(Buffer.from(rawBody))
		.digest("hex");

	// Hex has two spellings and `digest("hex")` only produces the lower one.
	// Normalising accepts a provider that upper-cases without weakening the
	// comparison, which the shape check above has already length-bounded.
	return safeEquals(supplied.toLowerCase(), expected);
}
