import { describe, expect, it } from "bun:test";
import { createStorage } from "./client";
import {
	providerRequirements,
	resolveProviderEndpoint,
	type StorageProvider,
} from "./providers";

const BUCKET = "keel-files";
const KEY = "org_abc/avatars/me.png";

/**
 * One row per provider, each host copied from the documentation cited beside the
 * template in `providers.ts`. A wrong host fails as a 403, so this table is the
 * only thing standing between a preset and an afternoon of debugging credentials
 * that were correct all along.
 */
const EXPECTED: Array<{
	forcePathStyle: boolean;
	/** What a presigned URL for KEY ends up addressing. */
	host: string;
	input: { accountId?: string; endpoint?: string; region?: string };
	pathname: string;
	provider: StorageProvider;
}> = [
	{
		forcePathStyle: false,
		host: `${BUCKET}.s3.eu-west-1.amazonaws.com`,
		input: { region: "eu-west-1" },
		pathname: `/${KEY}`,
		provider: "s3",
	},
	{
		forcePathStyle: true,
		host: "8f2a1c0d.r2.cloudflarestorage.com",
		input: { accountId: "8f2a1c0d" },
		pathname: `/${BUCKET}/${KEY}`,
		provider: "r2",
	},
	{
		forcePathStyle: true,
		host: "s3.us-west-004.backblazeb2.com",
		input: { region: "us-west-004" },
		pathname: `/${BUCKET}/${KEY}`,
		provider: "b2",
	},
	{
		forcePathStyle: false,
		host: `${BUCKET}.nyc3.digitaloceanspaces.com`,
		input: { region: "nyc3" },
		pathname: `/${KEY}`,
		provider: "spaces",
	},
	{
		forcePathStyle: true,
		host: "minio.internal:9000",
		input: { endpoint: "http://minio.internal:9000" },
		pathname: `/${BUCKET}/${KEY}`,
		provider: "minio",
	},
];

describe("provider presets", () => {
	for (const row of EXPECTED) {
		it(`resolves ${row.provider} to its documented endpoint`, () => {
			expect(
				resolveProviderEndpoint(row.provider, { bucket: BUCKET, ...row.input })
			).toEqual({
				endpoint: `${row.provider === "minio" ? "http" : "https"}://${row.host}`,
				forcePathStyle: row.forcePathStyle,
			});
		});

		it(`signs a ${row.provider} URL against that endpoint`, () => {
			// The endpoint string is an intermediate value; what matters is the URL
			// the provider actually receives, so assert on that instead.
			const { endpoint, forcePathStyle } = resolveProviderEndpoint(
				row.provider,
				{ bucket: BUCKET, ...row.input }
			);
			const url = new URL(
				createStorage({
					accessKeyId: "key",
					bucket: BUCKET,
					endpoint,
					forcePathStyle,
					secretAccessKey: "secret",
				}).createDownloadUrl(KEY, { expiresInSeconds: 60 })
			);

			expect(url.host).toBe(row.host);
			expect(url.pathname).toBe(row.pathname);
		});
	}

	it("takes both facts from the deployment for custom", () => {
		expect(
			resolveProviderEndpoint("custom", {
				bucket: BUCKET,
				endpoint: "https://s3.eu-central-1.wasabisys.com",
				forcePathStyle: true,
			})
		).toEqual({
			endpoint: "https://s3.eu-central-1.wasabisys.com",
			forcePathStyle: true,
		});
	});

	it("keeps path style off for custom when the deployment says so", () => {
		expect(
			resolveProviderEndpoint("custom", {
				bucket: BUCKET,
				endpoint: `https://${BUCKET}.s3.eu-central-1.wasabisys.com`,
				forcePathStyle: false,
			}).forcePathStyle
		).toBe(false);
	});
});

describe("providerRequirements", () => {
	it("asks a hosted preset only for what its host template contains", () => {
		expect(providerRequirements("s3")).toEqual(["region"]);
		expect(providerRequirements("b2")).toEqual(["region"]);
		expect(providerRequirements("spaces")).toEqual(["region"]);
		expect(providerRequirements("r2")).toEqual(["accountId"]);
	});

	it("asks a self-hosted preset for the endpoint alone", () => {
		// MinIO's hostname is wherever it was deployed, but its addressing style is
		// not a choice, so asking for it would be asking for a mistake.
		expect(providerRequirements("minio")).toEqual(["endpoint"]);
	});

	it("asks custom for both facts", () => {
		expect(providerRequirements("custom")).toEqual([
			"endpoint",
			"forcePathStyle",
		]);
	});
});

/** Each guard is identified by the input it names, which is its whole job. */
const NEEDS_ACCOUNT_ID = /needs accountId/;
const NEEDS_BOTH = /needs endpoint, forcePathStyle/;
const NEEDS_ENDPOINT = /needs endpoint/;
const NEEDS_REGION = /needs region/;

describe("missing inputs", () => {
	it("names the region a hosted preset needs", () => {
		expect(() => resolveProviderEndpoint("s3", { bucket: BUCKET })).toThrow(
			NEEDS_REGION
		);
	});

	it("names the account id R2 needs", () => {
		// Without this the host would be `https://undefined.r2.cloudflarestorage.com`,
		// which resolves and then fails as a signature error.
		expect(() => resolveProviderEndpoint("r2", { bucket: BUCKET })).toThrow(
			NEEDS_ACCOUNT_ID
		);
	});

	it("names the endpoint a self-hosted preset needs", () => {
		expect(() => resolveProviderEndpoint("minio", { bucket: BUCKET })).toThrow(
			NEEDS_ENDPOINT
		);
	});

	it("names both facts custom needs", () => {
		expect(() => resolveProviderEndpoint("custom", { bucket: BUCKET })).toThrow(
			NEEDS_BOTH
		);
	});
});
