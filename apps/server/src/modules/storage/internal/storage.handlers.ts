import { serviceUnavailable, validationFailed } from "@keel/http/errors";
import { ok } from "@keel/http/response";
import type { Storage } from "@keel/storage/client";
import { organizationKey } from "@keel/storage/keys";
import type { Context } from "hono";
import type { AppEnv } from "@/lib/context";
import { resolveStorage } from "@/lib/storage";
import type { DownloadUrlQuery, UploadUrlQuery } from "./storage.schema";

type UploadContext = Context<
	AppEnv,
	string,
	{ in: { query: UploadUrlQuery }; out: { query: UploadUrlQuery } }
>;
type DownloadContext = Context<
	AppEnv,
	string,
	{ in: { query: DownloadUrlQuery }; out: { query: DownloadUrlQuery } }
>;

/**
 * `resolveStorage` refuses a call rather than returning something half-wired:
 * on a deployment with no bucket it throws naming the `STORAGE_*` keys that are
 * unset. That refusal is surfaced as a 503 envelope carrying the same text an
 * operator would read in the logs — the request needs a dependency this
 * deployment never named, and nothing in our code is broken, so a 500 with a
 * generic body would hide exactly the message that fixes it.
 */
function storageOf(): Storage {
	try {
		return resolveStorage();
	} catch (error) {
		throw serviceUnavailable((error as Error).message);
	}
}

/**
 * Builds the object key from the session's tenant and the client-named path.
 * The prefix is the tenancy boundary: the URL is signed for exactly one key, so
 * a key that cannot escape the tenant prefix is a credential that cannot
 * either. The package's guard is the authority — the schema is its early mirror,
 * and anything that still slips through (a length only the assembled key
 * reveals) is refused here as a 422, not a 500.
 */
function tenantKey(c: Context<AppEnv>, key: string): string {
	try {
		return organizationKey(c.get("organizationId"), ...key.split("/"));
	} catch (error) {
		throw validationFailed((error as Error).message);
	}
}

export function uploadUrl(c: UploadContext) {
	const { contentType, expiresInSeconds, key } = c.req.valid("query");
	const url = storageOf().createUploadUrl(tenantKey(c, key), {
		contentType,
		expiresInSeconds,
	});

	return ok(c, { uploadUrl: url });
}

export function downloadUrl(c: DownloadContext) {
	const { expiresInSeconds, key } = c.req.valid("query");
	const url = storageOf().createDownloadUrl(tenantKey(c, key), {
		expiresInSeconds,
	});

	return ok(c, { downloadUrl: url });
}
