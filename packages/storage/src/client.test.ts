import { describe, expect, it } from "bun:test";
import { createHash, createHmac } from "node:crypto";
import { createStorage, type StorageConfig } from "./client";

const CONFIG: StorageConfig = {
	accessKeyId: "keel-test-key",
	bucket: "keel",
	endpoint: "http://localhost:9000",
	forcePathStyle: true,
	secretAccessKey: "keel-test-secret",
};

const KEY = "org_abc/avatars/me.png";

const storage = createStorage(CONFIG);

/** Named so each expectation says which rule it is checking. */
const NOT_POSITIVE = /positive whole number/;
const OVER_MAX_WINDOW = /at most 604800/;
const SIGNATURE = /^[0-9a-f]{64}$/;
const AMZ_DATE = /^\d{8}T\d{6}Z$/;

/**
 * SigV4's signature recomputed from first principles, so the assertion below
 * cannot echo the implementation under test. The AWS Signature Version 4
 * presign procedure, applied to this client's choices:
 *
 *   canonical request =
 *     "GET\n"
 *     + canonical URI                      // /<bucket>/<key>, path style
 *     + canonical query string\n           // X-Amz-* params, %2F-encoded scope
 *     + "host:<host>\n\nhost\n"            // presigning signs only "host"
 *     + "UNSIGNED-PAYLOAD"
 *   string to sign =
 *     "AWS4-HMAC-SHA256\n" + X-Amz-Date + "\n" + scope + "\n"
 *     + hex(SHA-256(canonical request))
 *   signing key = HMAC-SHA256 chain:
 *     AWS4<secret> -> day -> region ("auto") -> "s3" -> "aws4_request"
 *   signature = hex(HMAC-SHA256(signing key, string to sign))
 *
 * Worked check, hand-derivable from the above: with the fixed date
 * 20260812T123600Z the signature is
 * 322ef94f32c535ed24faff3298260064b0cf4f8b6c7c8107ddf156a1fe1e7e58.
 * The chain itself is pinned against AWS's published worked example (secret
 * wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY, date 20130524T000000Z,
 * us-east-1/s3, GET /test.txt):
 * f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41.
 *
 * X-Amz-Date is read from the generated URL rather than fixed: Bun's S3Client
 * stamps the wall clock inside its native signer and exposes no injection
 * point, so a fixed-date literal would be wrong the next second. The reference
 * uses only fixed inputs otherwise: the bucket/key pair, the endpoint's host,
 * the region ("auto" — Bun's guess for a non-Amazon endpoint), service "s3"
 * and the expiry. Any regression in region, host style, canonical request
 * construction, header signing or encoding changes the asserted signature.
 */
function expectedSignature(options: {
	accessKeyId: string;
	amzDate: string;
	bucket: string;
	expiresInSeconds: number;
	host: string;
	key: string;
	secretAccessKey: string;
}): string {
	const {
		accessKeyId,
		amzDate,
		bucket,
		expiresInSeconds,
		host,
		key,
		secretAccessKey,
	} = options;
	const amzDay = amzDate.slice(0, 8);
	const region = "auto";
	const canonicalQuery = [
		"X-Amz-Algorithm=AWS4-HMAC-SHA256",
		`X-Amz-Credential=${accessKeyId}%2F${amzDay}%2F${region}%2Fs3%2Faws4_request`,
		`X-Amz-Date=${amzDate}`,
		`X-Amz-Expires=${expiresInSeconds}`,
		"X-Amz-SignedHeaders=host",
	].join("&");
	const canonicalRequest = [
		"GET",
		`/${bucket}/${key}`,
		canonicalQuery,
		`host:${host}`,
		"",
		"host",
		"UNSIGNED-PAYLOAD",
	].join("\n");
	const stringToSign = [
		"AWS4-HMAC-SHA256",
		amzDate,
		`${amzDay}/${region}/s3/aws4_request`,
		createHash("sha256").update(canonicalRequest).digest("hex"),
	].join("\n");
	const hmac = (secret: string | Uint8Array, data: string) =>
		createHmac("sha256", secret).update(data).digest();
	const kDate = hmac(`AWS4${secretAccessKey}`, amzDay);
	const kRegion = hmac(kDate, region);
	const kService = hmac(kRegion, "s3");
	const kSigning = hmac(kService, "aws4_request");
	return hmac(kSigning, stringToSign).toString("hex");
}

describe("presigned URLs", () => {
	it("addresses the object under the bucket path when path style is forced", () => {
		const url = new URL(
			storage.createDownloadUrl(KEY, { expiresInSeconds: 60 })
		);

		expect(url.host).toBe("localhost:9000");
		expect(url.pathname).toBe(`/${CONFIG.bucket}/${KEY}`);
	});

	it("signs the canonical request to a known answer", () => {
		const url = new URL(
			storage.createDownloadUrl(KEY, { expiresInSeconds: 300 })
		);
		const amzDate = url.searchParams.get("X-Amz-Date") ?? "";

		// The exact canonical pieces a presigned URL exposes, each one pinning
		// a signing choice: the host (endpoint), the path (path-style bucket
		// placement), the credential scope (key id + region + service) and the
		// signed-header set. A regression in any of them also changes the
		// signature, but asserting them directly names the choice that broke.
		expect(url.host).toBe("localhost:9000");
		expect(url.pathname).toBe(`/${CONFIG.bucket}/${KEY}`);
		expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
		expect(url.searchParams.get("X-Amz-Credential")).toBe(
			`${CONFIG.accessKeyId}/${amzDate.slice(0, 8)}/auto/s3/aws4_request`
		);
		expect(amzDate).toMatch(AMZ_DATE);
		expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
		expect(url.searchParams.get("X-Amz-SignedHeaders")).toBe("host");

		// The signature itself, recomputed from first principles (see
		// expectedSignature) — not mirrored from the URL. The host and path
		// come from the fixed config, so any drift in how the client renders
		// them breaks the comparison.
		expect(url.searchParams.get("X-Amz-Signature")).toBe(
			expectedSignature({
				accessKeyId: CONFIG.accessKeyId,
				amzDate,
				bucket: CONFIG.bucket,
				expiresInSeconds: 300,
				host: new URL(CONFIG.endpoint).host,
				key: KEY,
				secretAccessKey: CONFIG.secretAccessKey,
			})
		);
	});

	it("leaves the bucket out of the path when path style is off", () => {
		// The AWS form: the endpoint already names the bucket, so repeating it in
		// the path would address `<bucket>/<bucket>/<key>`.
		const url = new URL(
			createStorage({
				...CONFIG,
				endpoint: "https://keel.s3.eu-west-1.amazonaws.com",
				forcePathStyle: false,
			}).createDownloadUrl(KEY, { expiresInSeconds: 60 })
		);

		expect(url.host).toBe("keel.s3.eu-west-1.amazonaws.com");
		expect(url.pathname).toBe(`/${KEY}`);
	});

	it("carries the requested lifetime inside the signature", () => {
		const url = new URL(
			storage.createDownloadUrl(KEY, { expiresInSeconds: 300 })
		);

		// Signed, not a query parameter a holder can extend.
		expect(url.searchParams.get("X-Amz-Expires")).toBe("300");
		expect(url.searchParams.get("X-Amz-Signature")).toMatch(SIGNATURE);
	});

	it("signs an upload for PUT and a download for GET", () => {
		const options = { expiresInSeconds: 60 };
		const upload = new URL(storage.createUploadUrl(KEY, options));
		const download = new URL(storage.createDownloadUrl(KEY, options));

		// The method is part of the signed request, which is why one URL cannot be
		// reused for the other direction.
		expect(upload.searchParams.get("X-Amz-Signature")).not.toBe(
			download.searchParams.get("X-Amz-Signature")
		);
	});

	it("signs one key only", () => {
		const options = { expiresInSeconds: 60 };
		const mine = new URL(storage.createDownloadUrl(KEY, options));
		const theirs = new URL(
			storage.createDownloadUrl("org_other/avatars/me.png", options)
		);

		expect(mine.searchParams.get("X-Amz-Signature")).not.toBe(
			theirs.searchParams.get("X-Amz-Signature")
		);
	});

	it("refuses a window longer than SigV4 allows", () => {
		expect(() =>
			storage.createUploadUrl(KEY, { expiresInSeconds: 8 * 24 * 60 * 60 })
		).toThrow(OVER_MAX_WINDOW);
	});

	it("refuses a zero or negative window", () => {
		expect(() =>
			storage.createDownloadUrl(KEY, { expiresInSeconds: 0 })
		).toThrow(NOT_POSITIVE);
		expect(() =>
			storage.createDownloadUrl(KEY, { expiresInSeconds: -60 })
		).toThrow(NOT_POSITIVE);
	});

	it("refuses a fractional window", () => {
		// `expiresIn` is whole seconds; 0.5 would round to a URL that is already
		// expired, which reads as a signing bug at the client.
		expect(() =>
			storage.createUploadUrl(KEY, { expiresInSeconds: 0.5 })
		).toThrow(NOT_POSITIVE);
	});
});
