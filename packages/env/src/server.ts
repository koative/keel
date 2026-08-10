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
		 * How many non-mutating requests one actor may make per minute, and — because
		 * the bucket's capacity IS this number — the largest burst it may spend at
		 * once before it has to wait for the refill of `value / 60` tokens a second.
		 *
		 * Per ACTOR, not per IP. The limiter runs behind the session guard, so the
		 * key is an identity the caller cannot forge by changing networks, and one
		 * misbehaving script does not throttle every colleague sharing an office NAT
		 * address. Better Auth's own limiter still keys on IP for `/api/auth/*`,
		 * where there is no actor yet.
		 *
		 * Reads are budgeted separately from writes, and far more generously: a list
		 * endpoint costs a query, a write costs a query plus everything downstream of
		 * it. Raising either is a deployment decision — the number that fits depends
		 * on the database behind this app, so it is an env key and not a constant.
		 */
		RATE_LIMIT_READ_PER_MINUTE: z.coerce.number().int().positive().default(600),
		/**
		 * The same budget for `POST`, `PUT`, `PATCH` and `DELETE`, in its own bucket
		 * per actor: capacity, largest burst, and `value / 60` tokens a second.
		 *
		 * An order of magnitude below the read budget on purpose. A write is the
		 * expensive request and the one that leaves a row behind, so it is the one
		 * worth bounding tightly; a client that legitimately needs more is doing
		 * bulk work and should be given an endpoint that takes a batch.
		 */
		RATE_LIMIT_WRITE_PER_MINUTE: z.coerce.number().int().positive().default(60),
		/**
		 * Base64 of 32 random bytes — `openssl rand -base64 32`. Keys the
		 * AES-256-GCM cipher in `@keel/crypto/seal` that encrypts third-party
		 * secrets at rest.
		 *
		 * Optional because a deployment that stores no such secrets needs none;
		 * the code path that reads it fails loudly when it is missing rather than
		 * writing plaintext.
		 *
		 * Rotating it makes every existing `v1.` row unreadable. That is what the
		 * version prefix is for: a rotation ships a new version tag alongside the
		 * old key so both can be read while the rows are rewritten.
		 */
		SECRETS_ENCRYPTION_KEY: z.string().optional(),
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
		/**
		 * How many jobs one worker claims per poll.
		 *
		 * A batch is processed one job at a time, so this is a ceiling on how long
		 * a worker can go without noticing a shutdown signal — not a concurrency
		 * setting. Add workers to go faster.
		 */
		WORKER_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(10),
		/**
		 * Idle wait between polls, in ms. This is the queue's worst-case latency
		 * for a job that becomes due just after a poll found nothing.
		 *
		 * Every worker issues one query per interval whether or not there is work,
		 * so lowering it buys latency at the cost of a constant load that scales
		 * with the number of replicas.
		 */
		WORKER_POLL_MS: z.coerce.number().int().min(50).default(1000),
	},
	skipValidation: !!process.env.SKIP_ENV_VALIDATION,
});
