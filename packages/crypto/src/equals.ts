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
 * The length check up front is deliberate and not a hole: `timingSafeEqual`
 * throws on mismatched lengths, and the length of a signature or a digest is
 * fixed and public anyway. What must not leak is the content.
 */
export function safeEquals(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);

	if (left.byteLength !== right.byteLength) {
		return false;
	}

	return timingSafeEqual(left, right);
}
