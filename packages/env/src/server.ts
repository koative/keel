import "dotenv/config";
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";

/**
 * The MAIL_FROM default, exported because it is not just a default: it is the
 * one sender value that cannot deliver to a stranger. `resolveMailConfig` in the
 * server rejects it on the `resend` driver, and that check has to compare
 * against this binding rather than a copy of the literal — two copies drift, and
 * the drift would silently disarm the guard.
 */
export const SANDBOX_MAIL_FROM = "Keel <onboarding@resend.dev>";

/**
 * Validated at import, so a missing or malformed value fails at startup naming the
 * key — rather than surfacing as `undefined` three layers into a request.
 */
export const env = createEnv({
	emptyStringAsUndefined: true,
	runtimeEnv: process.env,
	server: {
		/**
		 * An OpenRouter API key, `sk-or-…`. Optional because AI is opt-in: a
		 * deployment that never enqueues an `ai.generate` job needs no account.
		 * The first such job fails naming this variable if it is unset.
		 */
		AI_API_KEY: z.string().optional(),
		/**
		 * Which model answers. Any OpenRouter model id is valid — `provider/model`,
		 * as listed on openrouter.ai/models — so switching vendors is a variable,
		 * not a deploy.
		 *
		 * Defaults to `openai/gpt-4o-mini`, chosen for being cheap rather than for
		 * being good: a starter's default should make an accidental loop cost
		 * cents. Name a stronger one when the work justifies it.
		 */
		AI_MODEL: z.string().min(1).default("openai/gpt-4o-mini"),
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
		/**
		 * How transactional mail leaves the process.
		 *
		 * `log` prints the whole message to stdout and sends nothing, which is the
		 * default so that a clone of this repo can sign up, verify an address and
		 * accept an invitation with no provider account. A deployment that wants
		 * mail delivered has to say `resend` and supply RESEND_API_KEY.
		 */
		MAIL_DRIVER: z.enum(["log", "resend"]).default("log"),
		/**
		 * The From address on every message.
		 *
		 * Resend only accepts a sender on a domain verified for the account, so
		 * this cannot be an arbitrary address in production — `onboarding@resend.dev`
		 * is the sandbox sender every account starts with, and it can only be
		 * delivered to the account owner. The display-name form `Acme <hi@acme.com>`
		 * is accepted; a bare address is too.
		 */
		MAIL_FROM: z.string().min(1).default(SANDBOX_MAIL_FROM),
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
		/** Required when MAIL_DRIVER is `resend`. A Resend API key, `re_…`. */
		RESEND_API_KEY: z.string().optional(),
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
		 * The bucket. Every key here is optional, including the provider: nothing in
		 * this starter stores a file yet, so a deployment that never uploads one
		 * needs none of them, and demanding a bucket to boot would be a tax on
		 * everyone else. `resolveStorage()` is the guard instead — it throws naming
		 * whichever of these is missing, the first time storage is asked for, the
		 * same way `resolveMailConfig` does for `RESEND_API_KEY`.
		 */
		STORAGE_ACCESS_KEY_ID: z.string().min(1).optional(),
		/** Cloudflare account id. Required by, and only by, `STORAGE_PROVIDER=r2`. */
		STORAGE_ACCOUNT_ID: z.string().min(1).optional(),
		STORAGE_BUCKET: z.string().min(1).optional(),
		/**
		 * Bucket endpoint root, no key path. Required by `minio` and `custom`, which
		 * have no fixed hostname; every other provider derives it, and setting it
		 * there is an error rather than an override.
		 */
		STORAGE_ENDPOINT: z.url().optional(),
		/**
		 * Put the bucket in the URL path rather than in the hostname. Required by,
		 * and only by, `custom` — every named provider already knows its answer.
		 *
		 * No default, because there is no answer that is right for both: MinIO and
		 * R2 serve every bucket from one hostname and need it, AWS and Spaces put
		 * the bucket in the host and reject it. The two forms sign differently, so a
		 * wrong value is a 403 on every request rather than a redirect.
		 */
		STORAGE_FORCE_PATH_STYLE: z.stringbool().optional(),
		/**
		 * Which S3-compatible service holds the bucket. Selects a preset that knows
		 * that provider's endpoint shape and addressing style, both copied from its
		 * documentation — the two things everyone gets wrong once.
		 *
		 * `custom` is the escape hatch for anything not listed, and takes a raw
		 * `STORAGE_ENDPOINT` and `STORAGE_FORCE_PATH_STYLE`.
		 */
		STORAGE_PROVIDER: z
			.enum(["b2", "custom", "minio", "r2", "s3", "spaces"])
			.optional(),
		/** Provider region, e.g. `eu-west-1`, `us-west-004`, `nyc3`. Not used by r2. */
		STORAGE_REGION: z.string().min(1).optional(),
		STORAGE_SECRET_ACCESS_KEY: z.string().min(1).optional(),
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
