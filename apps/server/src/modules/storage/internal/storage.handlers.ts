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
 * The bucket this deployment named, resolved on first use and kept.
 *
 * `resolveStorage` re-runs the whole provider and environment guard chain and
 * builds a new `S3Client` for a value that cannot change while the process
 * lives, so calling it per request allocated a client to sign one URL and threw
 * it away — the mail resolver is hoisted to startup for exactly this reason.
 * Lazily rather than at import, because a deployment that configured no bucket
 * must still boot and answer 503 here instead of failing to start.
 *
 * Only a resolution is remembered, never a refusal: an unconfigured deployment
 * pays the guard again per request, which is the one case where paying buys
 * something — the operator gets the log line every time somebody tries.
 */
let resolved: Storage | undefined;

/**
 * `resolveStorage` refuses a call rather than returning something half-wired: on
 * a deployment with no bucket it throws naming the `STORAGE_*` keys that are
 * unset. That report belongs in the request's wide event, where the operator who
 * can act on it reads it, and nowhere in the response: this 503 is readable by
 * any signed-in member of any organization, and the list of keys a deployment
 * has left unset is the same class of detail `failure` masks a 500 for. The
 * caller is told the one thing it can act on — a dependency this deployment
 * never named, so retry rather than escalate.
 */
function storageOf(c: Context<AppEnv>): Storage {
	if (resolved) {
		return resolved;
	}

	try {
		resolved = resolveStorage();
	} catch (error) {
		c.get("log").error(error as Error);
		throw serviceUnavailable(
			"Object storage is not configured for this deployment"
		);
	}

	return resolved;
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
	const url = storageOf(c).createUploadUrl(tenantKey(c, key), {
		contentType,
		expiresInSeconds,
	});

	return ok(c, { uploadUrl: url });
}

export function downloadUrl(c: DownloadContext) {
	const { expiresInSeconds, key } = c.req.valid("query");
	const url = storageOf(c).createDownloadUrl(tenantKey(c, key), {
		expiresInSeconds,
	});

	return ok(c, { downloadUrl: url });
}
