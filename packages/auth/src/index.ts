import { db } from "@keel/db";
import * as schema from "@keel/db/schema/auth";
import { env } from "@keel/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";

const isProduction = env.NODE_ENV === "production";

/**
 * Rate limits, in requests per window (seconds).
 *
 * The default is a ceiling for the whole auth surface. Credential endpoints get
 * a far tighter one because they are the only ones an attacker can profit from
 * hammering: each request is a password guess, an account-existence probe, or a
 * free outbound email. A human signing in needs two or three attempts, so 10 per
 * minute is generous for a user and useless for a script.
 */
const CREDENTIAL_RULE = { max: 10, window: 60 };

export function createAuth() {
	return betterAuth({
		advanced: {
			defaultCookieAttributes: {
				httpOnly: true,
				/**
				 * `sameSite: "none"` is what a cross-origin dev setup needs — the web
				 * app runs on :3001 and this server on :3000, so the browser treats
				 * every request as third-party and drops a `lax` cookie.
				 *
				 * It is also the value that disables the cookie layer's own CSRF
				 * protection: the session then travels on any site's request. In
				 * production the two origins are expected to be same-site, so `lax`
				 * costs nothing and restores that defence. A deployment that genuinely
				 * needs a cross-site session must widen this consciously and pair it
				 * with a CSRF token.
				 */
				sameSite: isProduction ? "lax" : "none",
				// Chrome refuses `SameSite=None` without `Secure`, and localhost counts
				// as a secure context, so this stays true everywhere.
				secure: true,
			},
			/**
			 * Better Auth resolves the client IP from headers only — it has no socket
			 * access through a `Request` — so with nothing configured every caller
			 * shares one rate-limit bucket per path. That inverts the limiter: a
			 * single aggressive client locks every user out of `/sign-in`, turning a
			 * defence into a denial-of-service lever.
			 *
			 * Left unset by default because trusting `x-forwarded-for` on an app that
			 * is directly reachable lets any caller spoof its own identity and bypass
			 * the limit entirely. Only a deployment that knows a proxy rewrites the
			 * header can safely name it, so the deployment names it. The server warns
			 * at startup when it is unset.
			 */
			...(env.TRUSTED_IP_HEADER
				? { ipAddress: { ipAddressHeaders: [env.TRUSTED_IP_HEADER] } }
				: {}),
		},
		baseURL: env.BETTER_AUTH_URL,
		database: drizzleAdapter(db, {
			provider: "pg",
			schema,
		}),
		emailAndPassword: {
			enabled: true,
		},
		plugins: [],
		/**
		 * Enabled unconditionally rather than left to the `enabled: isProduction`
		 * default: a limit that only exists in production is a limit nobody has
		 * ever seen work, and the first time it is exercised is during an attack.
		 *
		 * `storage: "database"` because memory does not survive a restart and is
		 * per-process — two replicas behind a load balancer would each grant the
		 * full budget. It requires the `rateLimit` table in @keel/db.
		 */
		rateLimit: {
			customRules: {
				"/forget-password": CREDENTIAL_RULE,
				"/sign-in/email": CREDENTIAL_RULE,
				"/sign-up/email": CREDENTIAL_RULE,
			},
			/**
			 * Off under test: the bucket key falls back to a single shared per-path
			 * value when there is no client IP, and `app.request()` has no socket, so
			 * every test user in every run would draw from one budget and a second
			 * `bun test` inside the window would start returning 429.
			 */
			enabled: env.NODE_ENV !== "test",
			max: 100,
			storage: "database",
			window: 10,
		},
		secret: env.BETTER_AUTH_SECRET,
		trustedOrigins: [env.CORS_ORIGIN],
	});
}

export const auth = createAuth();
