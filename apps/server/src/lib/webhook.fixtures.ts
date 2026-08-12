import { createHmac } from "node:crypto";
import type { SignatureInput } from "./webhook";

/**
 * A provider, faked.
 *
 * Shared because there are two suites over `webhook.ts`: `webhook.test.ts`
 * covers what the digest is computed over, `webhook.replay.test.ts` covers how
 * old a delivery may be. Both need a delivery that is internally consistent —
 * digest, bytes and prefix agreeing — so that a test which moves exactly one
 * field knows the verdict came from that field and nothing else.
 *
 * Nothing here hard-codes a digest. A committed digest literal cannot be
 * re-derived by the next reader, and a test that asserts against one is pinning
 * the output of whatever code produced it rather than the rule it claims to
 * cover.
 */

/** The key the receiver holds. */
export const SECRET = "a-shared-webhook-secret";

/** The bytes as delivered — note the keys are not in alphabetical order. */
export const DELIVERED = '{"type":"thing.created","id":"evt_1","amount":1.0}';

/**
 * Built by hand rather than via `.buffer`, so the value under test is an
 * `ArrayBuffer` of exactly the payload's bytes with no view offset in play.
 */
export function bytes(payload: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(payload);
	const buffer = new ArrayBuffer(encoded.byteLength);
	new Uint8Array(buffer).set(encoded);
	return buffer;
}

/**
 * A Stripe-shaped provider's prefix: the delivery instant in Unix seconds and a
 * separator, hashed in front of the body because the provider transports the
 * timestamp beside the payload rather than inside it.
 *
 * The spelling belongs to the provider, which is the whole point of the prefix
 * being a caller-supplied string: this fixture stands in for one provider's
 * grammar, and `webhook.ts` never learns it.
 */
export function signedPrefix(at: Date): string {
	return `${Math.floor(at.getTime() / 1000)}.`;
}

export interface DeliveryOptions {
	/** The instant the provider stamps and signs. Defaults to now. */
	at?: Date;
	payload?: string;
	/** The key the provider signs with. Defaults to the one the receiver holds. */
	secret?: string;
}

/**
 * A whole delivery as a provider would put it on the wire.
 *
 * `signedAt` and `signedPrefix` are derived from the same instant, which is the
 * invariant a real receiver has to maintain by hand: the instant it acts on must
 * be parsed from the bytes it puts in the prefix. A fixture that let the two
 * drift would let a suite pass while proving nothing.
 *
 * `options.secret` is the *signer's* key while the returned `secret` is always
 * the receiver's, because "signed with somebody else's key" is a case worth
 * expressing in one argument.
 */
export function delivery(options: DeliveryOptions = {}): SignatureInput & {
	header: string;
} {
	const at = options.at ?? new Date();
	const payload = options.payload ?? DELIVERED;
	const prefix = signedPrefix(at);

	return {
		header: createHmac("sha256", options.secret ?? SECRET)
			.update(prefix, "utf8")
			.update(payload, "utf8")
			.digest("hex"),
		rawBody: bytes(payload),
		secret: SECRET,
		signedAt: at,
		signedPrefix: prefix,
	};
}
