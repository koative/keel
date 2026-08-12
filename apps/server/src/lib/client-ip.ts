import { env } from "@keel/env/server";

/**
 * The three deployment inputs `resolveClientIpPosture` reads.
 *
 * Taken as a parameter rather than closed over for the same reason `MailEnv` is:
 * the guard is the only reason this function exists, and a guard nobody has seen
 * fire is not a guard. `TRUSTED_PROXIES` arrives already split and trimmed by the
 * schema's own transform.
 */
export interface ClientIpEnv {
	NODE_ENV: "development" | "production" | "test";
	TRUSTED_IP_HEADER?: string | undefined;
	TRUSTED_PROXIES?: string[] | undefined;
}

/**
 * Whether this deployment can tell two callers apart, stated as the line the
 * entry point prints — and refused when the answer is no.
 *
 * Better Auth keys its limiter on the client IP, because on `/sign-in/email`,
 * `/sign-up/email` and `/forget-password` there is no actor yet to key on. It
 * resolves that IP from headers only, and its `getIp` reads `x-forwarded-for`
 * whether or not anything is configured. That default is what makes silence
 * unsafe rather than merely coarse: unconfigured and directly reachable, a caller
 * sends its own `X-Forwarded-For` and gets a private bucket, and a caller that
 * varies it per request has no credential limit at all.
 *
 * Better Auth does warn — once, through `ctx.logger.warn`, on the first request
 * that could not be resolved. That is a line in a log during traffic, hours after
 * the deploy that caused it. This turns the same fact into a refusal to boot, at
 * the moment someone is watching.
 *
 * The API is the only process that answers this question: `worker.ts` never
 * imports `@keel/auth` and runs no limiter, and `migrate.ts` shares the same
 * environment but must never be blocked by a rate-limiting concern.
 */
export function resolveClientIpPosture(source: ClientIpEnv = env): string {
	if (!source.TRUSTED_IP_HEADER) {
		if (source.NODE_ENV === "production") {
			throw new Error(
				"NODE_ENV=production requires TRUSTED_IP_HEADER. Better Auth reads x-forwarded-for by default, so with no header named this deployment trusts whatever a caller sends: a client that supplies its own single-value X-Forwarded-For gets a private rate-limit bucket, and the 10-per-60s rule on /sign-in/email, /sign-up/email and /forget-password stops applying to it. Set TRUSTED_IP_HEADER to the header the proxy in front of this app rewrites (x-forwarded-for, cf-connecting-ip), together with TRUSTED_PROXIES."
			);
		}

		// Outside production `getIp` ends at `isTest() || isDevelopment()` and
		// returns 127.0.0.1, so a laptop boots with one shared bucket and no
		// pretence that the bucket is per-caller.
		return "client IP unresolved: Better Auth reads `x-forwarded-for` by default and falls back to 127.0.0.1 outside production";
	}

	if (!source.TRUSTED_PROXIES?.length) {
		throw new Error(
			`TRUSTED_IP_HEADER=${source.TRUSTED_IP_HEADER} requires TRUSTED_PROXIES. With no proxy list Better Auth accepts the header at face value whenever it holds exactly one address, so a caller that sends its own ${source.TRUSTED_IP_HEADER} chooses its own rate-limit bucket. Set TRUSTED_PROXIES to every hop in front of this app, as IPs or CIDR ranges, e.g. 10.0.0.0/8,172.16.0.0/12.`
		);
	}

	return `client IP from \`${source.TRUSTED_IP_HEADER}\`, past ${source.TRUSTED_PROXIES.length} trusted range(s)`;
}
