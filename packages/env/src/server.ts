import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * Validated at import, so a missing or malformed value fails at startup naming the
 * key — rather than surfacing as `undefined` three layers into a request.
 */
export const env = createEnv({
	emptyStringAsUndefined: true,
	runtimeEnv: process.env,
	server: {
		BETTER_AUTH_SECRET: z.string().min(32),
		BETTER_AUTH_URL: z.url(),

		/** Largest accepted request body, in bytes. */
		BODY_LIMIT_BYTES: z.coerce
			.number()
			.int()
			.min(1024)
			.default(1024 * 1024),
		CORS_ORIGIN: z.url(),

		/** Pool ceiling per process. Postgres' max_connections is the real limit. */
		DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
		DATABASE_URL: z.string().min(1),

		/**
		 * Where wide events go.
		 *
		 * `none` is the only setting that discards them, and it has to be chosen
		 * explicitly: a production deployment that silently drops every event looks
		 * identical to one with nothing to report.
		 */
		LOG_DRAIN: z.enum(["fs", "otlp", "none"]).default("fs"),
		NODE_ENV: z
			.enum(["development", "production", "test"])
			.default("development"),
		/** Required when LOG_DRAIN is `otlp`. An OTLP/HTTP collector root, no path. */
		OTLP_ENDPOINT: z.url().optional(),
		/** `key=value` pairs, comma separated. For a collector that wants a token. */
		OTLP_HEADERS: z.string().optional(),
		/**
		 * Ceiling for a single statement and for an idle open transaction, in ms.
		 *
		 * Bounds the blast radius of one bad plan: without it a runaway query keeps
		 * its pooled connection until Postgres gives up, so `DATABASE_POOL_MAX` of
		 * them exhaust the pool and every unrelated request fails behind it. Raise
		 * it for a deliberately long report, but raise it for that connection —
		 * not for the pool the request path shares.
		 */
		STATEMENT_TIMEOUT_MS: z.coerce.number().int().positive().default(15_000),
		/**
		 * The header a trusted proxy uses to report the real client IP, e.g.
		 * `x-forwarded-for` or `cf-connecting-ip`.
		 *
		 * Unset by default and deliberately so. Naming a header on an app that is
		 * directly reachable lets any caller forge it and slip the rate limiter;
		 * leaving it unset means every caller shares one bucket per path, which is
		 * coarse but not forgeable. Only the deployment knows which is true, so the
		 * deployment decides.
		 */
		TRUSTED_IP_HEADER: z.string().min(1).optional(),
		/**
		 * The addresses of the proxies in front of this app, as IPs or CIDR ranges,
		 * comma separated — e.g. `10.0.0.0/8,172.16.0.0/12`.
		 *
		 * Needed whenever the forwarding header can hold more than one address,
		 * which is the normal case: Traefik, nginx's `proxy_add_x_forwarded_for`
		 * and every CDN append rather than replace. Without this, Better Auth
		 * refuses to guess which entry is the client and falls back to the shared
		 * bucket, so `TRUSTED_IP_HEADER` alone silently does nothing there.
		 *
		 * List every hop. Better Auth scans from the right and returns the first
		 * address outside these ranges, so a hop left out of the list becomes the
		 * answer — and a range that is too wide lets a caller inside it choose.
		 */
		TRUSTED_PROXIES: z
			.string()
			.min(1)
			.optional()
			.transform((value) => value?.split(",").map((entry) => entry.trim())),
	},
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
