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
		 * The header a trusted proxy uses to report the real client IP, e.g.
		 * `x-forwarded-for` or `cf-connecting-ip`.
		 *
		 * Unset by default and deliberately so. Naming a header on an app that is
		 * directly reachable lets any caller forge it and slip the rate limiter;
		 * leaving it unset means every caller shares one bucket per path, which is
		 * coarse but not forgeable. Only the deployment knows which is true, so the
		 * deployment decides — and the server says so at startup when it is unset.
		 */
		TRUSTED_IP_HEADER: z.string().min(1).optional(),
	},
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
