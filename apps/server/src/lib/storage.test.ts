import { describe, expect, it } from "bun:test";
import { resolveStorage, type StorageEnv } from "./storage";

/** Credentials and bucket, which every provider needs and none can derive. */
const BASE: StorageEnv = {
	STORAGE_ACCESS_KEY_ID: "key",
	STORAGE_BUCKET: "keel-files",
	STORAGE_SECRET_ACCESS_KEY: "secret",
};

/** The guard is identified by the variables it names, which is its whole job. */
const BUCKET_KEY = /STORAGE_BUCKET/;

function messageFrom(source: StorageEnv): string {
	try {
		resolveStorage(source);
	} catch (error) {
		const { message } = error as Error;
		return message;
	}

	throw new Error("resolveStorage was expected to refuse this configuration.");
}

describe("resolveStorage without credentials", () => {
	it("names every missing key when nothing is configured", () => {
		// The report has to be complete: revealing four missing values one restart
		// at a time turns one mistake into four.
		const message = messageFrom({});

		expect(message).toContain("STORAGE_PROVIDER");
		expect(message).toContain("STORAGE_BUCKET");
		expect(message).toContain("STORAGE_ACCESS_KEY_ID");
		expect(message).toContain("STORAGE_SECRET_ACCESS_KEY");
	});

	it("names only the key that is missing", () => {
		const message = messageFrom({
			...BASE,
			STORAGE_PROVIDER: "r2",
			STORAGE_SECRET_ACCESS_KEY: undefined,
		});

		expect(message).toContain("STORAGE_SECRET_ACCESS_KEY");
		expect(message).not.toContain("STORAGE_BUCKET");
	});

	it("treats an empty value as absent", () => {
		// `emptyStringAsUndefined` covers this for the process environment, but a
		// deployment that writes `STORAGE_BUCKET=` must not slip past the guard.
		expect(() =>
			resolveStorage({ ...BASE, STORAGE_BUCKET: "", STORAGE_PROVIDER: "minio" })
		).toThrow(BUCKET_KEY);
	});
});

describe("resolveStorage per provider", () => {
	it("wires r2 to the account host with the bucket in the path", () => {
		const url = new URL(
			resolveStorage({
				...BASE,
				STORAGE_ACCOUNT_ID: "8f2a1c0d",
				STORAGE_PROVIDER: "r2",
			}).createDownloadUrl("org_abc/a.png", { expiresInSeconds: 60 })
		);

		expect(url.host).toBe("8f2a1c0d.r2.cloudflarestorage.com");
		expect(url.pathname).toBe("/keel-files/org_abc/a.png");
	});

	it("wires s3 to the bucket subdomain with the key alone in the path", () => {
		const url = new URL(
			resolveStorage({
				...BASE,
				STORAGE_PROVIDER: "s3",
				STORAGE_REGION: "eu-west-1",
			}).createDownloadUrl("org_abc/a.png", { expiresInSeconds: 60 })
		);

		expect(url.host).toBe("keel-files.s3.eu-west-1.amazonaws.com");
		expect(url.pathname).toBe("/org_abc/a.png");
	});

	it("wires custom to the endpoint and style the deployment states", () => {
		const url = new URL(
			resolveStorage({
				...BASE,
				STORAGE_ENDPOINT: "https://s3.eu-central-1.wasabisys.com",
				STORAGE_FORCE_PATH_STYLE: true,
				STORAGE_PROVIDER: "custom",
			}).createDownloadUrl("org_abc/a.png", { expiresInSeconds: 60 })
		);

		expect(url.host).toBe("s3.eu-central-1.wasabisys.com");
		expect(url.pathname).toBe("/keel-files/org_abc/a.png");
	});
});

describe("resolveStorage provider inputs", () => {
	it("names the region an s3 bucket needs", () => {
		expect(messageFrom({ ...BASE, STORAGE_PROVIDER: "s3" })).toContain(
			"STORAGE_REGION"
		);
	});

	it("names the account id an r2 bucket needs", () => {
		expect(messageFrom({ ...BASE, STORAGE_PROVIDER: "r2" })).toContain(
			"STORAGE_ACCOUNT_ID"
		);
	});

	it("names the endpoint a self-hosted bucket needs", () => {
		expect(messageFrom({ ...BASE, STORAGE_PROVIDER: "minio" })).toContain(
			"STORAGE_ENDPOINT"
		);
	});

	it("names both facts a custom endpoint needs", () => {
		const message = messageFrom({ ...BASE, STORAGE_PROVIDER: "custom" });

		expect(message).toContain("STORAGE_ENDPOINT");
		expect(message).toContain("STORAGE_FORCE_PATH_STYLE");
	});

	it("refuses an endpoint the provider would ignore", () => {
		// The trap this guard exists for: an operator sets the regional endpoint by
		// hand, r2 derives its own from the account id, and the request 403s with
		// credentials that were correct the whole time.
		const message = messageFrom({
			...BASE,
			STORAGE_ACCOUNT_ID: "8f2a1c0d",
			STORAGE_ENDPOINT: "https://8f2a1c0d.r2.cloudflarestorage.com",
			STORAGE_PROVIDER: "r2",
		});

		expect(message).toContain("STORAGE_ENDPOINT");
		expect(message).toContain("would ignore it");
	});

	it("refuses an addressing style the provider would ignore", () => {
		const message = messageFrom({
			...BASE,
			STORAGE_FORCE_PATH_STYLE: false,
			STORAGE_PROVIDER: "s3",
			STORAGE_REGION: "eu-west-1",
		});

		expect(message).toContain("STORAGE_FORCE_PATH_STYLE");
	});

	it("refuses a region a self-hosted endpoint would ignore", () => {
		const message = messageFrom({
			...BASE,
			STORAGE_ENDPOINT: "http://minio.internal:9000",
			STORAGE_PROVIDER: "minio",
			STORAGE_REGION: "us-east-1",
		});

		expect(message).toContain("STORAGE_REGION");
	});
});
