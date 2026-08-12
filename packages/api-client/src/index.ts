import { hc } from "hono/client";
import type { AppType } from "server/app-type";

/**
 * The typed client for the internal API.
 *
 * `AppType` comes from a prebuilt declaration bundle rather than from the
 * server's source, so nothing here re-infers the route tree and nothing pulls
 * Drizzle or a database driver into a browser bundle. The only runtime dependency
 * is `hono/client`.
 *
 * This targets `/api`, the surface that moves with the frontend. A customer
 * integrating against `/v1` should generate from the OpenAPI document at `/doc`
 * instead — that is the surface with a version number on it.
 *
 * No client type is exported on purpose: the consumer creates the instance, so
 * the consumer is where the type should be named.
 */
export function createApiClient(
	baseUrl: string,
	options?: {
		headers?: Record<string, string>;
		/**
		 * Caller-supplied init is merged under `credentials: "include"`, which is
		 * load-bearing for session auth and cannot be overridden.
		 */
		init?: RequestInit;
	}
) {
	return hc<AppType>(baseUrl, {
		// The session lives in a cookie that Better Auth sets, so every call has to
		// carry it cross-origin. The spread order puts the caller's init under
		// credentials, so it can never drop the cookie.
		...options,
		init: { credentials: "include", ...options?.init },
	});
}
