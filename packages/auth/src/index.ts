import { db } from "@keel/db";
import * as authSchema from "@keel/db/schema/auth";
import * as organizationSchema from "@keel/db/schema/organization";
import { env } from "@keel/env/server";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";

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
			 * Naming the header is not enough, and this was measured rather than
			 * assumed. `getIPFromHeader` returns null unless the header holds exactly
			 * ONE address, so behind anything that appends — Traefik, nginx's
			 * `proxy_add_x_forwarded_for`, a CDN, any second hop — the value has two
			 * entries and resolution silently falls back to the shared bucket. Only
			 * `trustedProxies` changes that: with it, Better Auth walks the list from
			 * the right, skips every address inside a trusted range, and takes the
			 * first one that is not. That is the only order that resists spoofing,
			 * because a client controls what it prepends and nothing more.
			 *
			 * Both stay unset by default: trusting a forwarding header on an app that
			 * is directly reachable lets any caller invent its own identity and skip
			 * the limit entirely. Only a deployment knows what sits in front of it.
			 */
			...(env.TRUSTED_IP_HEADER
				? {
						ipAddress: {
							ipAddressHeaders: [env.TRUSTED_IP_HEADER],
							...(env.TRUSTED_PROXIES
								? { trustedProxies: env.TRUSTED_PROXIES }
								: {}),
						},
					}
				: {}),
		},
		baseURL: env.BETTER_AUTH_URL,
		database: drizzleAdapter(db, {
			provider: "pg",
			// Both namespaces, not `@keel/db/schema`: the adapter resolves models by
			// key, so handing it the whole schema index would also expose `project`,
			// `job` and `idempotencyKey` as models Better Auth believes it owns.
			// These two modules are exactly the tables it does own.
			schema: { ...authSchema, ...organizationSchema },
		}),
		/**
		 * Seeds `activeOrganizationId` on every new session from the user's earliest
		 * membership.
		 *
		 * Better Auth leaves the field null until the client calls `setActive()`.
		 * Every tenant-scoped route in this app is behind `requireOrg`, which 403s on
		 * a null value, so without this hook a correct sign-in lands in a state where
		 * the entire API is forbidden until the SPA makes an extra round trip — and
		 * every route's first request after a sign-in is a wasted one.
		 *
		 * Better Auth's own adapter rather than Drizzle: the hook runs inside Better
		 * Auth's model namespace, so `"member"` here resolves through whatever
		 * `modelName` mapping is configured, and a rename made in plugin options
		 * cannot desynchronise from this lookup.
		 */
		databaseHooks: {
			session: {
				create: {
					before: async (session, ctx) => {
						/**
						 * The sort is load-bearing, not cosmetic. `limit: 1` without an
						 * ORDER BY lets Postgres return whichever row it reaches first,
						 * which is a function of physical layout and changes as the table
						 * is written to. A user who belongs to two organizations would
						 * then be dropped into a different one on different sign-ins,
						 * silently, and the bug reproduces only on those accounts. Do not
						 * remove it. `member_userId_idx` in @keel/db covers this read.
						 */
						const memberships = await ctx?.context.adapter.findMany<{
							organizationId: string;
						}>({
							limit: 1,
							model: "member",
							sortBy: { direction: "asc", field: "createdAt" },
							where: [{ field: "userId", value: session.userId }],
						});

						const organizationId = memberships?.[0]?.organizationId;
						if (!organizationId) {
							// A user with no membership yet — mid sign-up, or an account whose
							// only organization was deleted. Leave the field null and let
							// `requireOrg` route them to onboarding.
							return;
						}

						return {
							data: { ...session, activeOrganizationId: organizationId },
						};
					},
				},
			},
		},
		emailAndPassword: {
			enabled: true,
		},
		plugins: [
			organization({
				/**
				 * Left at the default `false`, re-inviting an address leaves every
				 * earlier invitation live. Two consequences, and the second is the
				 * serious one: the members page shows the same person queued three
				 * times, and every link that was ever pasted anywhere still redeems.
				 * You cannot un-paste a link — cancelling the invitation is the only
				 * revocation there is, and this is what makes re-inviting perform it.
				 */
				cancelPendingInvitationsOnReInvite: true,
				/**
				 * Seven days, against the plugin's 48-hour default.
				 *
				 * 48 hours assumes an invitation email lands in an inbox seconds after
				 * it is sent. There is no mailer in keel, so an invitation travels out
				 * of band: somebody copies the link and pastes it into a chat, and it
				 * waits for a human to read that chat. Two days is hostile to that, and
				 * an expired invitation is indistinguishable from a broken one.
				 *
				 * This should come back down toward the default once a mailer exists —
				 * a longer window is a longer period in which a leaked link is still
				 * redeemable, and that cost is only worth paying while delivery is
				 * manual.
				 */
				invitationExpiresIn: 7 * 24 * 60 * 60,
			}),
		],
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
