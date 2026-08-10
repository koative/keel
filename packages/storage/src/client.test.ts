import { describe, expect, it } from "bun:test";
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

/** Signing is checked against a real MinIO; these are the choices we make. */
describe("presigned URLs", () => {
	it("addresses the object under the bucket path when path style is forced", () => {
		const url = new URL(
			storage.createDownloadUrl(KEY, { expiresInSeconds: 60 })
		);

		expect(url.host).toBe("localhost:9000");
		expect(url.pathname).toBe(`/${CONFIG.bucket}/${KEY}`);
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
