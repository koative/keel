import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySignature } from "./webhook";

const SECRET = "a-shared-webhook-secret";

/**
 * Built by hand rather than via `.buffer`, so the value under test is an
 * `ArrayBuffer` of exactly the payload's bytes with no view offset in play.
 */
function bytes(payload: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(payload);
	const buffer = new ArrayBuffer(encoded.byteLength);
	new Uint8Array(buffer).set(encoded);
	return buffer;
}

/** What a provider would send: the digest of the bytes it put on the wire. */
function sign(payload: string, secret = SECRET): string {
	return createHmac("sha256", secret).update(payload, "utf8").digest("hex");
}

/** The bytes as delivered — note the keys are not in alphabetical order. */
const DELIVERED = '{"type":"thing.created","id":"evt_1","amount":1.0}';

describe("verifySignature", () => {
	it("verifies a digest computed over the exact received bytes", () => {
		expect(
			verifySignature({
				header: sign(DELIVERED),
				rawBody: bytes(DELIVERED),
				secret: SECRET,
			})
		).toBe(true);
	});

	/**
	 * The reason the function takes raw bytes, and the case that decides whether
	 * a receiver works at all. The two payloads are the same value with the keys
	 * in a different order; a receiver that verified a parsed body would be
	 * verifying whichever order its own serialiser happens to emit, and would
	 * therefore reject every event the provider ever sent — not merely some.
	 */
	it("rejects the same value with its keys in a different order", () => {
		const reordered = '{"amount":1.0,"id":"evt_1","type":"thing.created"}';

		expect(JSON.parse(reordered)).toEqual(JSON.parse(DELIVERED));
		expect(
			verifySignature({
				header: sign(DELIVERED),
				rawBody: bytes(reordered),
				secret: SECRET,
			})
		).toBe(false);
	});

	// The same hazard from the other direction: a parse/serialise round trip
	// reformats numbers, so `1.0` comes back as `1` and the digest moves even
	// though nothing about the event changed.
	it("rejects a parse and re-stringify round trip", () => {
		const roundTripped = JSON.stringify(JSON.parse(DELIVERED));

		expect(roundTripped).not.toBe(DELIVERED);
		expect(
			verifySignature({
				header: sign(DELIVERED),
				rawBody: bytes(roundTripped),
				secret: SECRET,
			})
		).toBe(false);
	});

	it("accepts a digest carrying the algorithm prefix", () => {
		expect(
			verifySignature({
				header: `sha256=${sign(DELIVERED)}`,
				rawBody: bytes(DELIVERED),
				secret: SECRET,
			})
		).toBe(true);
	});

	it("accepts an upper-cased digest", () => {
		expect(
			verifySignature({
				header: sign(DELIVERED).toUpperCase(),
				rawBody: bytes(DELIVERED),
				secret: SECRET,
			})
		).toBe(true);
	});

	it("rejects a tampered body", () => {
		expect(
			verifySignature({
				header: sign(DELIVERED),
				rawBody: bytes(DELIVERED.replace('"amount":1.0', '"amount":9001')),
				secret: SECRET,
			})
		).toBe(false);
	});

	it("rejects a digest signed with a different secret", () => {
		expect(
			verifySignature({
				header: sign(DELIVERED, "someone-elses-secret"),
				rawBody: bytes(DELIVERED),
				secret: SECRET,
			})
		).toBe(false);
	});

	it("rejects a correct digest of the wrong length", () => {
		const digest = sign(DELIVERED);

		for (const malformed of [digest.slice(0, 63), `${digest}00`]) {
			expect(
				verifySignature({
					header: malformed,
					rawBody: bytes(DELIVERED),
					secret: SECRET,
				})
			).toBe(false);
		}
	});

	/**
	 * Every one of these has to come back `false`. A throw would reach
	 * `app.onError` as a 500, which tells whoever sent the garbage that they
	 * reached application code, and turns provider retries into an error storm.
	 * These cases fail on a throw as surely as on a `true`.
	 */
	it.each([
		["null", null],
		["undefined", undefined],
		["empty", ""],
		["whitespace", "   "],
		["the prefix alone", "sha256="],
		["not hex", "sha256=not-a-digest"],
		["a different algorithm", `sha512=${sign(DELIVERED)}`],
		["base64 rather than hex", Buffer.from(sign(DELIVERED)).toString("base64")],
	])("returns false for a %s header", (_name, header) => {
		expect(
			verifySignature({ header, rawBody: bytes(DELIVERED), secret: SECRET })
		).toBe(false);
	});
});
