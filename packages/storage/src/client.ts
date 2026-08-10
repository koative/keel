import { S3Client } from "bun";

/**
 * SigV4 puts the lifetime inside the signature as `X-Amz-Expires`, and the spec
 * caps it at seven days. A longer window is not a slower expiry, it is a URL the
 * provider rejects outright.
 */
const MAX_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/**
 * What one bucket needs. Taken as an argument, never read from the environment:
 * `process.env` belongs to `packages/env`, and `apps/server/src/lib/storage.ts`
 * is where the two meet.
 *
 * There is no `driver` here and no second implementation anywhere, because S3 is
 * a protocol rather than a product: MinIO, Cloudflare R2, Backblaze B2 and
 * Wasabi all answer it, so a `minio.ts` beside an `r2.ts` would be one client
 * pretending to be several.
 */
export interface StorageConfig {
	accessKeyId: string;
	bucket: string;
	endpoint: string;
	/**
	 * Put the bucket in the path — `<endpoint>/<bucket>/<key>` — instead of
	 * expecting `endpoint` to already name it. MinIO and Cloudflare R2 both serve
	 * one hostname for every bucket, so both need this; AWS S3 addresses a bucket
	 * as a subdomain, so an AWS deployment sets it false and points `endpoint` at
	 * `https://<bucket>.s3.<region>.amazonaws.com`.
	 *
	 * The two forms sign differently, so the wrong one is a 403 on every request
	 * rather than a redirect. There is no default: which one applies is a fact
	 * about the provider, and guessing it from the endpoint would be guessing.
	 */
	forcePathStyle: boolean;
	secretAccessKey: string;
}

export interface PresignOptions {
	/**
	 * Binds an upload URL to one `Content-Type`, which the client must then send.
	 * A browser that uploads a script as `image/png` is only a problem if the
	 * declared type is trusted later, so pin it at the point it is signed.
	 */
	contentType?: string;
	/**
	 * Required, with no default, on purpose.
	 *
	 * A presigned URL is a bearer credential for one object: anyone holding it
	 * can use it, and nothing can revoke it before it expires — deleting the
	 * signing key would break every other URL too. These URLs are also handled
	 * carelessly by everyone, ending up in access logs, browser history, support
	 * tickets and chat threads. The only control left is how long the window is,
	 * so the caller has to state it, in view of the flow it belongs to. Minutes
	 * for a form upload; a default of a day would have outlived the page.
	 */
	expiresInSeconds: number;
}

export interface WriteOptions {
	contentType?: string;
}

/**
 * Named for what a caller wants rather than for the protocol underneath: an
 * upload URL, a download URL, a read, a write, a delete, an existence check.
 * That is the whole surface a starter needs.
 *
 * Bytes never pass through the API. Uploads and downloads use the two presigned
 * URLs, so a 50 MB file does not occupy a worker, a pooled database connection
 * and the request body limit on its way to a bucket that was reachable directly.
 * `read` and `write` are for the server's own bytes — a generated PDF, a job
 * inspecting an upload — not for proxying a client's.
 */
export interface Storage {
	createDownloadUrl: (key: string, options: PresignOptions) => string;
	createUploadUrl: (key: string, options: PresignOptions) => string;
	delete: (key: string) => Promise<void>;
	exists: (key: string) => Promise<boolean>;
	read: (key: string) => Promise<Uint8Array>;
	write: (
		key: string,
		data: ArrayBuffer | Blob | string | Uint8Array,
		options?: WriteOptions
	) => Promise<void>;
}

function assertExpiry(expiresInSeconds: number): void {
	if (!Number.isInteger(expiresInSeconds) || expiresInSeconds < 1) {
		throw new Error(
			`expiresInSeconds must be a positive whole number of seconds, received ${expiresInSeconds}.`
		);
	}

	if (expiresInSeconds > MAX_EXPIRES_IN_SECONDS) {
		throw new Error(
			`expiresInSeconds must be at most ${MAX_EXPIRES_IN_SECONDS} (seven days), received ${expiresInSeconds}. SigV4 signs the lifetime, so a longer window is rejected by the provider rather than honoured.`
		);
	}
}

export function createStorage(config: StorageConfig): Storage {
	const client = new S3Client({
		accessKeyId: config.accessKeyId,
		bucket: config.bucket,
		endpoint: config.endpoint,
		secretAccessKey: config.secretAccessKey,
		// Bun's option is the inverse of ours. Ours is named after the setting
		// every S3-compatible service documents, which is the one a deployment
		// will be looking for.
		virtualHostedStyle: !config.forcePathStyle,
	});

	return {
		createDownloadUrl(key, options) {
			assertExpiry(options.expiresInSeconds);

			return client.presign(key, {
				expiresIn: options.expiresInSeconds,
				method: "GET",
			});
		},

		createUploadUrl(key, options) {
			assertExpiry(options.expiresInSeconds);

			return client.presign(key, {
				expiresIn: options.expiresInSeconds,
				method: "PUT",
				type: options.contentType,
			});
		},

		delete(key) {
			return client.delete(key);
		},

		exists(key) {
			return client.exists(key);
		},

		read(key) {
			return client.file(key).bytes();
		},

		async write(key, data, options) {
			await client.write(key, data, { type: options?.contentType });
		},
	};
}
