import { env } from "@keel/env/server";
import type { DrainFn } from "evlog";
import { createFsDrain } from "evlog/fs";
import { createOTLPDrain } from "evlog/otlp";

/**
 * `k=v,k=v` into a header record.
 *
 * Only the first `=` separates: a bearer token or a base64 credential routinely
 * contains one, and splitting on every occurrence would truncate it.
 */
function parseHeaders(raw: string): Record<string, string> {
	const headers: Record<string, string> = {};

	for (const entry of raw.split(",")) {
		const pair = entry.trim();
		const separator = pair.indexOf("=");
		// Trimmed first so `< 1` rejects a blank entry and a leading `=` alike:
		// either would otherwise register a header with an empty name.
		if (separator < 1) {
			continue;
		}

		headers[pair.slice(0, separator).trimEnd()] = pair
			.slice(separator + 1)
			.trimStart();
	}

	return headers;
}

/**
 * The drain `initLogger` receives, selected by LOG_DRAIN.
 *
 * This replaces `env.NODE_ENV === "production" ? undefined : createFsDrain()`,
 * which had the polarity backwards: it discarded every wide event in exactly the
 * environment that needs them, and did so silently — a production deployment
 * with no observability at all looked identical to a healthy one. Which sink to
 * use is a deployment decision, so it is now an explicit deployment input.
 */
export function resolveDrain(): DrainFn | undefined {
	if (env.LOG_DRAIN === "none") {
		// The only setting that throws events away. It exists for CI, and for a
		// container whose stdout is already scraped by the platform. It has to be
		// asked for by name; nothing else in this function can produce it.
		return;
	}

	if (env.LOG_DRAIN === "otlp") {
		if (!env.OTLP_ENDPOINT) {
			// Failing at startup is the point. Defaulting to a no-op here would
			// recreate the silent-drainless-production bug this file exists to fix.
			throw new Error(
				"LOG_DRAIN=otlp requires OTLP_ENDPOINT. Set OTLP_ENDPOINT to the collector root, or set LOG_DRAIN to fs or none."
			);
		}

		return createOTLPDrain({
			endpoint: env.OTLP_ENDPOINT,
			headers: env.OTLP_HEADERS ? parseHeaders(env.OTLP_HEADERS) : undefined,
		});
	}

	return createFsDrain();
}
