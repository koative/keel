import { describe, expect, it } from "bun:test";
import { randomBytes } from "node:crypto";
import { createCipher } from "./seal";

const KEY = randomBytes(32).toString("base64");
const OTHER_KEY = randomBytes(32).toString("base64");
const SECRET = "sk_live_51H8xQ2LkdIwHu7ix";

const EMPTY_KEY_MESSAGE = /got 0/;
const KEY_TOO_LONG_MESSAGE = /exactly 32 bytes, got 64/;
const KEY_TOO_SHORT_MESSAGE = /exactly 32 bytes, got 16/;
const NOT_V1_ENVELOPE_MESSAGE = /not a v1 envelope/;
const WRONG_IV_SIZE_MESSAGE = /3-byte IV, expected 12/;
const WRONG_TAG_SIZE_MESSAGE = /3-byte auth tag, expected 16/;

const cipher = createCipher(KEY);

/** Advances the first byte of one envelope part by one, keeping its length. */
function tamper(sealed: string, index: number): string {
	const parts = sealed.split(".");
	const part = parts[index];

	if (part === undefined) {
		throw new Error(`Envelope has no part at index ${index}.`);
	}

	const bytes = Buffer.from(part, "base64url");
	bytes[0] = (bytes.readUInt8(0) + 1) % 256;
	parts[index] = bytes.toString("base64url");

	return parts.join(".");
}

describe("createCipher", () => {
	it("rejects a key that is not 32 bytes, at construction", () => {
		expect(() => createCipher(randomBytes(16).toString("base64"))).toThrow(
			KEY_TOO_SHORT_MESSAGE
		);
		expect(() => createCipher(randomBytes(64).toString("base64"))).toThrow(
			KEY_TOO_LONG_MESSAGE
		);
		expect(() => createCipher("")).toThrow(EMPTY_KEY_MESSAGE);
	});
});

describe("seal", () => {
	it("returns the plaintext through a round trip", () => {
		expect(cipher.open(cipher.seal(SECRET))).toBe(SECRET);
	});

	it("round trips an empty string and multi-byte characters", () => {
		expect(cipher.open(cipher.seal(""))).toBe("");
		expect(cipher.open(cipher.seal("clé—🔐"))).toBe("clé—🔐");
	});

	it("does not leak the plaintext into the stored form", () => {
		const sealed = cipher.seal(SECRET);

		expect(sealed).not.toContain(SECRET);
		expect(sealed).toStartWith("v1.");
	});

	it("produces a different envelope every time, so equal secrets are not linkable", () => {
		expect(cipher.seal(SECRET)).not.toBe(cipher.seal(SECRET));
	});
});

describe("open", () => {
	it("rejects a tampered ciphertext", () => {
		expect(() => cipher.open(tamper(cipher.seal(SECRET), 3))).toThrow();
	});

	it("rejects a tampered auth tag", () => {
		expect(() => cipher.open(tamper(cipher.seal(SECRET), 2))).toThrow();
	});

	it("rejects a tampered IV", () => {
		expect(() => cipher.open(tamper(cipher.seal(SECRET), 1))).toThrow();
	});

	it("rejects an unknown version prefix", () => {
		const sealed = cipher.seal(SECRET).replace("v1.", "v2.");

		expect(() => cipher.open(sealed)).toThrow(NOT_V1_ENVELOPE_MESSAGE);
	});

	it("rejects a truncated envelope", () => {
		const [version, iv] = cipher.seal(SECRET).split(".");

		expect(() => cipher.open(`${version}.${iv}`)).toThrow(
			NOT_V1_ENVELOPE_MESSAGE
		);
		expect(() => cipher.open("")).toThrow(NOT_V1_ENVELOPE_MESSAGE);
	});

	it("names a wrong-sized IV or auth tag instead of failing opaquely", () => {
		const parts = cipher.seal(SECRET).split(".");

		expect(() =>
			cipher.open(["v1", "AAAA", parts[2], parts[3]].join("."))
		).toThrow(WRONG_IV_SIZE_MESSAGE);
		expect(() =>
			cipher.open(["v1", parts[1], "AAAA", parts[3]].join("."))
		).toThrow(WRONG_TAG_SIZE_MESSAGE);
	});

	it("rejects a value sealed under a different key", () => {
		const sealed = createCipher(OTHER_KEY).seal(SECRET);

		expect(() => cipher.open(sealed)).toThrow();
	});
});
