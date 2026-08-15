import { db } from "@keel/db";
import * as authSchema from "@keel/db/schema/auth";
import * as organizationSchema from "@keel/db/schema/organization";
import { env } from "@keel/env/server";
import { enqueueMail } from "@keel/mail/queue";
import {
	invitationEmail,
	passwordResetEmail,
	verificationEmail,
} from "@keel/mail/templates";
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
			 * access through a `Request` — and it does not wait to be told which
			 * header: `getIp` falls back to `DEFAULT_IP_HEADERS`, which is
			 * `["x-forwarded-for"]`, whenever `ipAddressHeaders` is absent. So an
			 * unset header is not the coarse-but-unforgeable bucket it reads like.
			 * On a directly reachable deployment a caller that sends a single-value
			 * `X-Forwarded-For` is keyed on it, and a caller that sends a different
			 * one per request has no credential limit at all. Only a caller sending
			 * no forwarding header, or one with two or more entries, lands in the
			 * shared `no-trusted-ip` bucket. Outside production the question is moot:
			 * `getIp` ends at `isTest() || isDevelopment()` and returns 127.0.0.1.
			 *
			 * Naming the header is not enough, and this was measured rather than
			 * assumed. `getIPFromHeader` returns null unless the header holds exactly
			 * ONE address, so behind anything that appends — Traefik, nginx's
			 * `proxy_add_x_forwarded_for`, a CDN, any second hop — the value has two
			 * entries and resolution falls back to the shared bucket. Only
			 * `trustedProxies` changes that: with it, Better Auth walks the list from
			 * the right, skips every address inside a trusted range, and takes the
			 * first one that is not. That is the only order that resists spoofing,
			 * because a client controls what it prepends and nothing more.
			 *
			 * Both are optional here because only a deployment knows what sits in
			 * front of it — but a production deployment has to answer.
			 * `resolveClientIpPosture` in `apps/server/src/lib/client-ip.ts` refuses
			 * to start the API on `NODE_ENV=production` without a header, and refuses
			 * a header without a proxy list in any environment.
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
			/**
			 * Sign-in is refused until the address has been proven, and that is
			 * what makes the password-reset path safe: an account whose address was
			 * never verified cannot be taken over through its inbox, because its
			 * inbox was never shown to belong to it. With this on, the reset link
			 * can only ever reach the person who proved the address — a stranger
			 * who guessed a password has no mail to intercept, and an invitation
			 * matched by address lands in the right hands or nowhere.
			 */
			requireEmailVerification: true,
			/**
			 * Enqueues and returns. Better Auth already wraps this call in
			 * `runInBackgroundOrAwait`, precisely because a mailer is slow and the
			 * response should not wait on it — so a durable queue is what that
			 * wrapper was reaching for, not a workaround for it. The difference is
			 * what happens when the provider is down: a backgrounded send is lost
			 * with the request, a queued one is retried.
			 *
			 * The template is rendered here and the finished message is what travels.
			 * `url` carries a one-time token minted inside this request and derivable
			 * from nothing else, so nothing downstream could rebuild the message.
			 */
			sendResetPassword: async ({ url, user }) => {
				// Keyed on the address, not the token: "forgot password" clicked three
				// times is three tokens and should still be one email. The key is held
				// until the send has finished, so a burst collapses into one message
				// while an honest retry once that one has gone out sends again.
				await enqueueMail(
					passwordResetEmail({ to: user.email, url }),
					`mail:password-reset:${user.email}`
				);
			},
		},
		emailVerification: {
			/**
			 * On by default because the alternative is an account whose address has
			 * never been proven: password reset then mails a stranger, and every
			 * invitation matched by address reaches the wrong inbox.
			 */
			sendOnSignUp: true,
			sendVerificationEmail: async ({ url, user }) => {
				/**
				 * Better Auth mints the link against this API, which is right — the
				 * endpoint that redeems the token lives here. What it cannot know is
				 * where to send the browser afterwards, so it leaves `callbackURL` at
				 * the `/` it defaults to when the caller sends none, and
				 * `/verify-email` redirects to that value verbatim once the address is
				 * proven. On this origin `/` is a JSON 404, so the one link every new
				 * account has to open landed nowhere.
				 *
				 * Only the landing page is rewritten, against CORS_ORIGIN the way the
				 * invitation link below is built: the token stays inside the URL Better
				 * Auth minted rather than being re-derived here. CORS_ORIGIN is a
				 * trusted origin, which is what `/verify-email`'s own callback check
				 * requires.
				 *
				 * Sign-in rather than the dashboard, because verifying does not create
				 * a session — anything behind the auth guard would bounce right back.
				 */
				const link = new URL(url);
				link.searchParams.set(
					"callbackURL",
					new URL("/login", env.CORS_ORIGIN).toString()
				);

				await enqueueMail(
					verificationEmail({ to: user.email, url: link.toString() }),
					`mail:verification:${user.email}`
				);
			},
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
				 * 48 hours assumes the invitation lands in an inbox seconds after it is
				 * sent. It now can — but `MAIL_DRIVER=log` writes the message to the
				 * worker's stdout instead of sending it, so on a deployment that chose it
				 * an invitation still travels by hand: somebody copies the link off the
				 * members screen into a chat, and it waits for a human to read that chat.
				 * Two days is hostile to that, and an expired invitation is
				 * indistinguishable from a broken one.
				 *
				 * A deployment that configures a real driver can bring this back toward
				 * the plugin's 48 hours, and should: a longer window is a longer period
				 * in which a leaked link is still redeemable, and that cost is only
				 * worth paying while delivery is manual.
				 */
				invitationExpiresIn: 7 * 24 * 60 * 60,
				/**
				 * The plugin's default is not a number but no limit at all: when the
				 * option is undefined its check falls through to a literal `false`
				 * (`crud-org.mjs`), so nothing ever throws. `/organization/create`
				 * draws only the global 100-per-10s bucket, which leaves one
				 * authenticated caller free to write roughly ten organizations a
				 * second, each with a member row, indefinitely.
				 *
				 * A ceiling rather than a rate: a human hits this only by trying to,
				 * and raising it is one edit for a deployment that genuinely runs
				 * agencies with many tenants.
				 */
				organizationLimit: 10,
				/**
				 * Better Auth mints the invitation but builds no URL for it, so the
				 * link is assembled here against CORS_ORIGIN: the route that redeems
				 * it is a page in the SPA, not an endpoint on this API.
				 *
				 * Enqueues and returns, like the two hooks above. An invitation that
				 * failed to mail is worse than the others — the invited person has no
				 * account yet, so there is no "resend" they can reach for themselves —
				 * which makes the retry the queue provides the point.
				 */
				sendInvitationEmail: async (data) => {
					const url = new URL(
						`/accept-invitation/${data.id}`,
						env.CORS_ORIGIN
					).toString();

					// Keyed on the invitation, not the address: re-inviting cancels the
					// old invitation and mints a new id, and that new link is a
					// different message that must not collapse into the pending one.
					await enqueueMail(
						invitationEmail({
							inviter: data.inviter.user.name || data.inviter.user.email,
							organization: data.organization.name,
							to: data.email,
							url,
						}),
						`mail:invitation:${data.id}`
					);
				},
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
			 * Off under test: `getIp` returns 127.0.0.1 for every request when
			 * NODE_ENV is `test`, so every test user in every run would draw from one
			 * `127.0.0.1|<path>` budget and a second `bun test` inside the window
			 * would start returning 429.
			 */
			enabled: env.NODE_ENV !== "test",
			max: 100,
			storage: "database",
			window: 10,
		},
		secret: env.BETTER_AUTH_SECRET,
		/**
		 * One day, sliding — a decision instead of the inherited seven-day default.
		 *
		 * `expiresIn` (seconds) is the session's maximum lifetime: without further
		 * refresh a session dies 24 hours after it was last extended, so a stolen
		 * cookie is a one-day liability rather than a seven-day one.
		 *
		 * `updateAge` (seconds) is the sliding threshold, not a second lifetime:
		 * Better Auth refreshes the session — extending it to a full `expiresIn`
		 * from now — once it is `updateAge` old and the user is active. It must be
		 * strictly smaller than `expiresIn`; at equality the refresh condition
		 * (`expiresAt - expiresIn + updateAge <= now`, from the installed 1.6.25
		 * `session.mjs`) holds only at the instant of expiry, which the
		 * expired-session check already handles, so the session would never slide.
		 * One hour keeps a working session alive through a normal day — any session
		 * older than an hour is renewed by the next request — while capping the
		 * renewal write at once per session per hour.
		 *
		 * Deliberately a constant, not an env key — a lifetime knob that gets
		 * widened to stop complaints stops meaning anything.
		 */
		session: {
			expiresIn: 60 * 60 * 24,
			updateAge: 60 * 60,
		},
		trustedOrigins: [env.CORS_ORIGIN],
	});
}

export const auth = createAuth();
