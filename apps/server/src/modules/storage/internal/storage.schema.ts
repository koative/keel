import { z } from "zod";

/**
 * One slash-separated segment of the key a client names, relative to its
 * organization's prefix.
 *
 * A mirror of the per-segment rules in `packages/storage/src/keys.ts`: the
 * guard there is the authority, and this schema exists so a key the guard could
 * never accept fails here — a 422 from the validator, before any handler code —
 * instead of surfacing as a throw the handler would have to catch.
 */
const SEGMENT = z
	.string()
	.min(1, "Storage key segments cannot be empty")
	.refine(
		(segment) => segment !== "." && segment !== "..",
		"Storage key segments cannot be relative path segments"
	)
	.refine(
		(segment) => !segment.includes("\\"),
		"Storage key segments cannot contain a backslash"
	)
	.refine(
		(segment) => !segment.includes("\0"),
		"Storage key segments cannot contain a NUL byte"
	);

/**
 * The object path the client names, without any tenant prefix: the prefix is
 * derived from the session, never from the request, which is the whole point of
 * it. Slash-separated segments, each one guard-shaped — no empty, dot,
 * backslash or NUL segment, so no value can widen the key it lands under.
 *
 * The byte ceiling mirrors the S3 limit the guard enforces on the assembled
 * key. A key short enough to fit under some prefixes but not this organization's
 * is the guard's call to make; the handler surfaces that refusal as a 422 too.
 */
export const storageKeySchema = z
	.string()
	.min(
		1,
		"A storage key needs at least one segment after the organization prefix"
	)
	.refine(
		(key) =>
			key.split("/").every((segment) => SEGMENT.safeParse(segment).success),
		"Use plain path segments: no empty, dot, backslash or NUL segments"
	)
	.max(1024, "Storage keys are at most 1024 bytes");

/**
 * What every presign request carries. `expiresInSeconds` is required on
 * purpose, mirroring the package: a presigned URL is a bearer credential for
 * one object and nothing can revoke it early, so the lifetime has to be stated
 * in view of the flow it belongs to — and the SigV4 ceiling of seven days is
 * the package's, asserted here so a longer window is a 422 rather than a throw.
 */
const presignQuery = {
	expiresInSeconds: z.coerce
		.number()
		.int("expiresInSeconds must be a whole number of seconds")
		.min(1, "expiresInSeconds must be at least 1")
		.max(
			7 * 24 * 60 * 60,
			"expiresInSeconds must be at most 604800 (seven days)"
		),
	key: storageKeySchema,
};

export const uploadUrlQuerySchema = z.object({
	...presignQuery,
	/**
	 * Pins the upload URL to one `Content-Type`, which the client must then
	 * send. Optional, exactly as the package's `PresignOptions` declares it:
	 * binding a type is a choice the caller makes, not a default this API invents.
	 */
	contentType: z.string().min(1, "contentType cannot be empty").optional(),
});

export const downloadUrlQuerySchema = z.object({ ...presignQuery });

export type UploadUrlQuery = z.output<typeof uploadUrlQuerySchema>;
export type DownloadUrlQuery = z.output<typeof downloadUrlQuerySchema>;
