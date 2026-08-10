/**
 * Which S3-compatible service the bucket lives on.
 *
 * This is not an adapter list — there is one client, because S3 is a protocol
 * and every one of these answers it. What actually differs between them is two
 * facts: the shape of the endpoint host, and whether the bucket goes in the path
 * or in the hostname. Both are easy to get wrong, and getting either wrong fails
 * as `SignatureDoesNotMatch` or a 403, which reads like a credentials problem and
 * costs an afternoon. So they are written down once, here, from each provider's
 * own documentation.
 */
export type StorageProvider =
	| "b2"
	| "custom"
	| "minio"
	| "r2"
	| "s3"
	| "spaces";

export type ProviderInputKey =
	| "accountId"
	| "endpoint"
	| "forcePathStyle"
	| "region";

export interface ProviderInput {
	/** Cloudflare account id. R2 puts it in the host. */
	accountId?: string | undefined;
	bucket: string;
	/** Only for `custom` and `minio`; every other preset derives it. */
	endpoint?: string | undefined;
	/** Only for `custom`; every other preset knows its own answer. */
	forcePathStyle?: boolean | undefined;
	region?: string | undefined;
}

export interface ProviderEndpoint {
	endpoint: string;
	forcePathStyle: boolean;
}

interface ProviderPreset {
	/**
	 * Host template, `{placeholder}` per input. Undefined means the deployment
	 * supplies the endpoint, because the service has no fixed hostname.
	 */
	endpoint?: string;
	/** Undefined means the deployment states it, which only `custom` does. */
	forcePathStyle?: boolean;
}

/**
 * Every template below is copied from the provider's own documentation, checked
 * on 2026-08-10. A wrong host here would be worse than no table at all, so each
 * one carries the page it came from.
 */
const PROVIDERS: Record<StorageProvider, ProviderPreset> = {
	// https://www.backblaze.com/docs/cloud-storage-call-the-s3-compatible-api
	// "https://s3.<region>.backblazeb2.com", and that page documents the
	// path form `https://s3.us-east-005.backblazeb2.com/bucketname` explicitly.
	// The region carries a cluster number, e.g. `us-west-004`.
	b2: { endpoint: "https://s3.{region}.backblazeb2.com", forcePathStyle: true },

	// Anything else that speaks S3 — Wasabi, Scaleway, Hetzner, Ceph, a company
	// gateway. The endpoint and the addressing style both have to be stated,
	// because nothing here can derive them and guessing is what this table exists
	// to avoid.
	custom: {},

	// https://min.io — self-hosted, so the hostname is whatever it was deployed
	// on. Path style: MinIO serves every bucket from one host, which is also the
	// form Bun's own MinIO example uses (`endpoint: "http://localhost:9000"`).
	minio: { forcePathStyle: true },

	// https://developers.cloudflare.com/r2/api/s3/api/
	// "The API is available via the https://<ACCOUNT_ID>.r2.cloudflarestorage.com
	// endpoint." One host per account, so the bucket goes in the path. R2's region
	// is always `auto`, which is why no region is asked for.
	r2: {
		endpoint: "https://{accountId}.r2.cloudflarestorage.com",
		forcePathStyle: true,
	},

	// https://docs.aws.amazon.com/AmazonS3/latest/userguide/VirtualHosting.html
	// "https://{bucket-name}.s3.{region-code}.amazonaws.com/{key-name}". Path
	// style still works but AWS has announced its deprecation, so the virtual
	// hosted form is the one to ship.
	s3: {
		endpoint: "https://{bucket}.s3.{region}.amazonaws.com",
		forcePathStyle: false,
	},

	// https://docs.digitalocean.com/products/spaces/reference/s3-compatibility/
	// Every example there addresses an object as
	// `https://<bucket>.<region>.digitaloceanspaces.com/<key>`, and the SDK guide
	// says to set the path-style flag to false. Region is a datacenter, e.g. nyc3.
	spaces: {
		endpoint: "https://{bucket}.{region}.digitaloceanspaces.com",
		forcePathStyle: false,
	},
};

const PLACEHOLDER = /\{(\w+)\}/g;

/**
 * Which inputs the chosen preset cannot derive, so a caller can report all of
 * them at once before anything is built.
 *
 * Read out of the template rather than listed beside it: a second list would
 * drift from the template it describes, and the drift would show up as a host
 * containing the literal text `undefined`.
 */
export function providerRequirements(
	provider: StorageProvider
): ProviderInputKey[] {
	const preset = PROVIDERS[provider];
	const required: ProviderInputKey[] = [];

	if (preset.endpoint === undefined) {
		required.push("endpoint");
	} else {
		for (const [, name] of preset.endpoint.matchAll(PLACEHOLDER)) {
			// `bucket` is always supplied, so it is never something to ask for.
			if (name === "accountId" || name === "region") {
				required.push(name);
			}
		}
	}

	if (preset.forcePathStyle === undefined) {
		required.push("forcePathStyle");
	}

	return required;
}

/** The endpoint and addressing style the chosen provider needs. */
export function resolveProviderEndpoint(
	provider: StorageProvider,
	input: ProviderInput
): ProviderEndpoint {
	const preset = PROVIDERS[provider];
	const missing = providerRequirements(provider).filter(
		(key) => input[key] === undefined
	);

	if (missing.length > 0) {
		throw new Error(
			`Storage provider "${provider}" needs ${missing.join(", ")}.`
		);
	}

	const endpoint =
		preset.endpoint?.replace(PLACEHOLDER, (_, name: string) =>
			// `bucket` is always supplied and the rest were just checked, so every
			// placeholder has a value by the time this runs.
			String(input[name as keyof ProviderInput])
		) ?? String(input.endpoint);

	return {
		endpoint,
		forcePathStyle: preset.forcePathStyle ?? !!input.forcePathStyle,
	};
}
