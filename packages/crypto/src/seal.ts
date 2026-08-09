import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";

/**
 * Every stored value carries its own format tag.
 *
 * A rotation or an algorithm change is then detectable per row: the reader sees
 * `v2.` on the rows already migrated and `v1.` on the rest, and can open both
 * while a background pass rewrites them. A single deployment-wide flag would
 * force a flag-day migration instead — every row rewritten inside one window,
 * with no way to read what has not been converted yet.
 */
const VERSION = "v1";

/** AES-256. */
const KEY_BYTES = 32;

/**
 * 96 bits is the nonce length GCM is specified around: it feeds the counter
 * block directly. Any other size has to be hashed down through an extra GHASH
 * pass first, which costs time and buys nothing.
 */
const IV_BYTES = 12;

/** Full-length GCM tag. Truncating one weakens forgery resistance. */
const TAG_BYTES = 16;

/** `v1`, IV, tag, ciphertext. */
const PART_COUNT = 4;

export interface Cipher {
	open: (sealed: string) => string;
	seal: (plaintext: string) => string;
}

/** Narrows the split envelope so the three payload parts are known present. */
function isEnvelope(
	parts: string[]
): parts is [string, string, string, string] {
	return parts.length === PART_COUNT && parts[0] === VERSION;
}

/**
 * Builds an AES-256-GCM cipher over `base64Key`, producing and reading values
 * of the form `v1.<iv>.<tag>.<ciphertext>`, each part base64url.
 *
 * The key is passed in rather than read from the environment so this package
 * stays pure and testable; the caller owns where the key comes from.
 */
export function createCipher(base64Key: string): Cipher {
	const key = Buffer.from(base64Key, "base64");

	// Asserted here, not on first use: a deployment with a mistyped key must fail
	// at startup, rather than after it has already accepted writes it cannot read.
	if (key.byteLength !== KEY_BYTES) {
		throw new Error(
			`Encryption key must be base64 of exactly ${KEY_BYTES} bytes, got ${key.byteLength}. Generate one with: openssl rand -base64 ${KEY_BYTES}`
		);
	}

	return {
		open(sealed: string): string {
			const parts = sealed.split(".");

			if (!isEnvelope(parts)) {
				throw new Error(
					`Sealed value is not a ${VERSION} envelope: expected ${PART_COUNT} dot-separated parts beginning with "${VERSION}".`
				);
			}

			const [, encodedIv, encodedTag, encodedCiphertext] = parts;
			const iv = Buffer.from(encodedIv, "base64url");
			const tag = Buffer.from(encodedTag, "base64url");

			// Checked before createDecipheriv so a corrupted row reports what is wrong
			// with it, instead of surfacing as an opaque OpenSSL failure.
			if (iv.byteLength !== IV_BYTES) {
				throw new Error(
					`Sealed value has a ${iv.byteLength}-byte IV, expected ${IV_BYTES}.`
				);
			}

			if (tag.byteLength !== TAG_BYTES) {
				throw new Error(
					`Sealed value has a ${tag.byteLength}-byte auth tag, expected ${TAG_BYTES}.`
				);
			}

			const decipher = createDecipheriv(ALGORITHM, key, iv);
			decipher.setAuthTag(tag);

			return (
				decipher.update(
					Buffer.from(encodedCiphertext, "base64url"),
					undefined,
					"utf8"
				) + decipher.final("utf8")
			);
		},

		seal(plaintext: string): string {
			const iv = randomBytes(IV_BYTES);
			const cipher = createCipheriv(ALGORITHM, key, iv);
			const ciphertext = Buffer.concat([
				cipher.update(plaintext, "utf8"),
				cipher.final(),
			]);

			return [
				VERSION,
				iv.toString("base64url"),
				cipher.getAuthTag().toString("base64url"),
				ciphertext.toString("base64url"),
			].join(".");
		},
	};
}
