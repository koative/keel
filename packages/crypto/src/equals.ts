import { timingSafeEqual } from "node:crypto";

/**
 * Compares two strings without leaking where they stopped matching.
 *
 * `===` is wrong for anything an attacker can submit repeatedly — a webhook
 * signature, an API key, a one-time token. It short-circuits on the first
 * differing byte, so the time it takes to return false is a measurement of how
 * many leading bytes were right. Enough retries turn that into the secret, one
 * byte at a time. `timingSafeEqual` reads both buffers in full regardless.
 *
 * The length check up front is a disclosure, not a free pass: `timingSafeEqual`
 * throws on mismatched lengths, so something has to give, and what gives is the
 * byte length of the expected value. That is only acceptable where the length is
 * fixed and public — a digest, or a token of documented width. `webhook.ts`
 * qualifies: it rejects anything but 64 hex characters before it calls here. A
 * secret whose length its holder chose — an API key — has to be hashed to a
 * fixed width first, or this tells an attacker how long it is. What must never
 * leak is the content.
 */
export function safeEquals(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);

	if (left.byteLength !== right.byteLength) {
		return false;
	}

	return timingSafeEqual(left, right);
}
