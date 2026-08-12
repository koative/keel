import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { verifySignature } from "./webhook";
import {
	bytes,
	DELIVERED,
	delivery,
	SECRET,
	signedPrefix,
} from "./webhook.fixtures";

describe("verifySignature", () => {
	it("verifies a digest computed over the exact received bytes", () => {
		expect(verifySignature(delivery())).toBe(true);
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
		expect(verifySignature({ ...delivery(), rawBody: bytes(reordered) })).toBe(
			false
		);
	});

	// The same hazard from the other direction: a parse/serialise round trip
	// reformats numbers, so `1.0` comes back as `1` and the digest moves even
	// though nothing about the event changed.
	it("rejects a parse and re-stringify round trip", () => {
		const roundTripped = JSON.stringify(JSON.parse(DELIVERED));

		expect(roundTripped).not.toBe(DELIVERED);
		expect(
			verifySignature({ ...delivery(), rawBody: bytes(roundTripped) })
		).toBe(false);
	});

	it("accepts a digest carrying the algorithm prefix", () => {
		const sent = delivery();

		expect(verifySignature({ ...sent, header: `sha256=${sent.header}` })).toBe(
			true
		);
	});

	it("accepts an upper-cased digest", () => {
		const sent = delivery();

		expect(
			verifySignature({ ...sent, header: sent.header.toUpperCase() })
		).toBe(true);
	});

	it("rejects a tampered body", () => {
		expect(
			verifySignature({
				...delivery(),
				rawBody: bytes(DELIVERED.replace('"amount":1.0', '"amount":9001')),
			})
		).toBe(false);
	});

	it("rejects a digest signed with a different secret", () => {
		expect(verifySignature(delivery({ secret: "someone-elses-secret" }))).toBe(
			false
		);
	});

	/**
	 * The prefix is the only place a provider's out-of-band material — a
	 * timestamp, a delivery id — can be brought under the signature. If it were
	 * left out of the digest, presenting different material with the same digest
	 * would cost nothing, and anything the receiver decided from that material
	 * would be attacker-chosen.
	 */
	it("covers the prefix, so moving it invalidates the digest", () => {
		const sent = delivery();

		expect(
			verifySignature({
				...sent,
				signedPrefix: signedPrefix(new Date("2020-01-01T00:00:00.000Z")),
			})
		).toBe(false);
	});

	// A provider that signs the body alone — GitHub is the common one — passes an
	// empty prefix, and hashing nothing in front of the body is a no-op, so that
	// provider's digest is unaffected by the prefix existing at all. The second
	// assertion is the same delivery with a non-empty prefix asserted against it,
	// which must fail: an empty prefix is a claim about the bytes, not a bypass.
	it("treats an empty prefix as the body alone", () => {
		const bodyOnly = createHmac("sha256", SECRET)
			.update(DELIVERED, "utf8")
			.digest("hex");

		expect(
			verifySignature({ ...delivery(), header: bodyOnly, signedPrefix: "" })
		).toBe(true);
		expect(verifySignature({ ...delivery(), header: bodyOnly })).toBe(false);
	});

	it("rejects a correct digest of the wrong length", () => {
		const sent = delivery();

		for (const malformed of [sent.header.slice(0, 63), `${sent.header}00`]) {
			expect(verifySignature({ ...sent, header: malformed })).toBe(false);
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
		["a different algorithm", `sha512=${delivery().header}`],
		[
			"base64 rather than hex",
			Buffer.from(delivery().header).toString("base64"),
		],
	])("returns false for a %s header", (_name, header) => {
		expect(verifySignature({ ...delivery(), header })).toBe(false);
	});
});
