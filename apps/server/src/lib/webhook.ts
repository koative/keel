/**
 * Signature verification for inbound provider webhooks.
 *
 * The receiver order is fixed, and getting it wrong is the usual way a webhook
 * endpoint fails in production:
 *
 * 1. Verify the signature over the raw request bytes, and refuse a delivery
 *    whose own timestamp is outside the replay window. Nothing else happens
 *    first — an unsigned request must not be able to reach a parser, a query
 *    or a log line that an operator will later read as fact, and a request that
 *    verified last week must not be able to reach any of them twice.
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

/**
 * How far a delivery's own timestamp may sit from now, in either direction.
 *
 * Five minutes, which is what Stripe's own libraries default to and what Slack
 * documents, and it is chosen from both ends. It has to be wide enough to
 * survive a provider's retry jitter, a few seconds of NTP drift on either host
 * and a queue that briefly falls behind — a minute is not, and a receiver that
 * intermittently 400s teaches its operator to stop reading the alert. It has to
 * be narrow enough that a captured request is a five-minute liability rather
 * than a permanent one.
 *
 * A constant and not a parameter, and certainly not an environment variable. A
 * parameter is a knob that gets widened at 02:00 to make a flaky integration
 * green, and the widened value then lives in a route file nobody reviews as a
 * security decision. An env key would additionally be this repository making a
 * deployment decision on somebody's behalf, which is the thing `packages/env`
 * was refactored to stop doing. If a provider ever genuinely needs more, that is
 * a deliberate edit here, with a comment, reviewed as what it is.
 */
const TOLERANCE_MS = 5 * 60 * 1000;

/**
 * What a receiver passes as `signedAt` when its provider transports no timestamp
 * at all — GitHub is the common one, signing the body and nothing else.
 *
 * A named value rather than an optional field or a `null`, because opting out of
 * a replay window must not be reachable by forgetting. This one has to be
 * imported and spelled out at the call site, so it appears in the diff, in the
 * review and in a grep for every receiver that has no window. Such a receiver
 * owes exactly-once by another route: see the contract on `verifySignature`.
 */
export const NO_TIMESTAMP = "no-timestamp";

/**
 * Whether the delivery claims an instant close enough to now.
 *
 * Symmetric, because clocks are wrong in both directions. A far-future stamp is
 * either a host whose clock is ahead — where honouring it would silently extend
 * every window that follows — or a capture held back until the honest window
 * closed. `Math.abs` costs nothing and the one-sided spelling admits every
 * future timestamp there will ever be.
 *
 * An unparseable instant arrives here as `NaN` and every comparison against
 * `NaN` is false, so it is refused by the arithmetic. That is the answer wanted,
 * and a branch written for it would only be a second way to get it wrong.
 */
function withinWindow(signedAt: Date | typeof NO_TIMESTAMP): boolean {
	if (signedAt === NO_TIMESTAMP) {
		return true;
	}

	return Math.abs(Date.now() - signedAt.getTime()) <= TOLERANCE_MS;
}

export interface SignatureInput {
	/** The provider's signature header, as read off the request. */
	header: string | null | undefined;
	rawBody: ArrayBuffer;
	secret: string;
	/**
	 * The instant the provider says it stamped this delivery, already parsed.
	 *
	 * A `Date` and not a raw header value, because providers disagree about
	 * everything except that they disagree: Stripe puts `t=` inside the signature
	 * header, Slack and Svix use a separate header, others use a body field, and
	 * the unit is sometimes seconds and sometimes milliseconds. Parsing that here
	 * would mean either guessing or learning one provider's grammar, and the
	 * route that already knows its own header name is the place that knows.
	 *
	 * The invariant the caller MUST hold: this instant is parsed from the same
	 * bytes it passes as `signedPrefix`. That is what makes the timestamp
	 * authenticated rather than advisory — relabelling a stale capture then moves
	 * the prefix, and the digest stops matching. A caller that reads the instant
	 * from one place and prefixes another has a window an attacker can slide.
	 */
	signedAt: Date | typeof NO_TIMESTAMP;
	/**
	 * Bytes the provider hashes in **front** of the body, verbatim as it spells
	 * them on the wire — Stripe's `${unixSeconds}.`, Slack's `v0:${unixSeconds}:`
	 * — and `""` for a provider that signs the body alone.
	 *
	 * This exists because the signed payload is not always the payload. A
	 * provider that transports material beside the body (a timestamp, a delivery
	 * id) brings it under the signature by hashing it in front, and a receiver
	 * that decides anything from that material must verify it the same way, or
	 * the material is attacker-chosen while the digest still checks out.
	 *
	 * A `string` and not a parsed structure, and required rather than defaulted,
	 * for the same reason the header name is not this module's business: the
	 * route knows its provider's grammar and this module knows bytes. A default
	 * of `""` would let a Stripe receiver silently verify the wrong payload.
	 */
	signedPrefix: string;
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
 *
 * ## What a receiver still owes, after this returns true
 *
 * The window bounds a replay; it does not make delivery exactly-once. Inside
 * five minutes a provider's own retry — and an attacker's replay — verifies,
 * correctly, because it is a genuine delivery of a genuine event. Deduplication
 * is therefore the receiver's job and it has two halves, both required:
 *
 * 1. **A unique index on the provider's event id**, on whatever table holds the
 *    raw payload. This is the durable guard, and it is the one that still works
 *    when `signedAt` is `NO_TIMESTAMP` and there is no window at all. Key it on
 *    the provider as well as the id: two providers can and do mint the same
 *    string.
 * 2. **`enqueue`'s `dedupeKey` set to that same event id**, namespaced —
 *    `webhook:<provider>:<eventId>` — so a burst of provider retries collapses
 *    into the one job that has not settled yet.
 *
 * The second is not a substitute for the first, and the reason is in the index
 * rather than in the code: `job_dedupeKey_unsettled_idx` is unique only
 * `WHERE status IN ('pending', 'running')` (`packages/db/src/schema/job.ts`). The
 * moment a job settles the key leaves the index and is usable again, which is
 * exactly the behaviour that makes it a debounce and a mutex — and exactly why
 * it cannot remember an event from ten minutes ago. A receiver that treats
 * `dedupeKey` as its replay guard is relying on a guard the queue handed back
 * when the job settled.
 *
 * The event id comes out of the payload, which means it is read after the
 * signature verified and never before. An id parsed from an unverified body is
 * an attacker-chosen primary key.
 */
export function verifySignature({
	header,
	rawBody,
	secret,
	signedAt,
	signedPrefix,
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
		.update(signedPrefix, "utf8")
		.update(Buffer.from(rawBody))
		.digest("hex");

	// Both verdicts are computed before either is looked at, and this is not
	// style. `&&` short-circuits, so `matches && withinWindow(...)` would make
	// the function's running time depend on whether the digest matched — the
	// coarse oracle `safeEquals` exists to deny — and `withinWindow(...) &&
	// safeEquals(...)` would make operand order a security property that no
	// assertion in the suite can catch. Two consts and one combine at the end
	// keeps the property local and visible. The cost when a delivery is stale is
	// one SHA-256 over a body the request body limit already bounds.
	//
	// Hex has two spellings and `digest("hex")` only produces the lower one.
	// Normalising accepts a provider that upper-cases without weakening the
	// comparison, which the shape check above has already length-bounded.
	const fresh = withinWindow(signedAt);
	const matches = safeEquals(supplied.toLowerCase(), expected);

	return fresh && matches;
}
