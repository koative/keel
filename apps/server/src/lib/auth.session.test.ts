import { afterEach, describe, expect, it, setSystemTime } from "bun:test";
import { db } from "@keel/db";
import { session, user } from "@keel/db/schema/auth";
import { eq } from "drizzle-orm";
import { app } from "@/app";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("session cookie cache"));
}

/** `session.cookieCache.maxAge` in @keel/auth, in seconds. */
const WINDOW_SECONDS = 60;

/**
 * Wide enough to absorb the sub-second gap between reading the clock here and
 * Better Auth signing the cache cookie, narrow enough that the two probes below
 * pin the window to a minute rather than to the 300-second default.
 */
const MARGIN_SECONDS = 5;

const PASSWORD = "correct-horse-battery-staple";

/**
 * A cookie jar, because this is the one suite that cares about the SECOND cookie.
 * `test-http.ts`'s client keeps the session token alone — which is what every
 * other suite wants, since it forces each request to resolve the session against
 * the database — while the cache lives in `better-auth.session_data`.
 */
function jar() {
	const cookies: Record<string, string> = {};
	return {
		header: () =>
			Object.entries(cookies)
				.map(([name, value]) => `${name}=${value}`)
				.join("; "),
		store: (response: Response) => {
			for (const raw of response.headers.getSetCookie()) {
				const pair = raw.split(";")[0] ?? "";
				const separator = pair.indexOf("=");
				if (separator > 0) {
					cookies[pair.slice(0, separator)] = pair.slice(separator + 1);
				}
			}
		},
	};
}

/**
 * A signed-in, onboarded browser: every cookie Better Auth issued, and the user
 * whose session can then be revoked.
 *
 * `set-active` follows `create` because it is what the SPA's onboarding does, and
 * here it is load-bearing: `create` updates the session row through the adapter
 * without re-signing the cache, while `set-active` goes through
 * `setSessionCookie` and refreshes it — so the cached copy carries the tenant
 * `requireOrg` is about to ask for.
 */
async function signIn() {
	const cookies = jar();
	const email = `${crypto.randomUUID()}@keel.test`;
	const json = { "Content-Type": "application/json" };

	const created = await app.request("/api/auth/sign-up/email", {
		body: JSON.stringify({ email, name: "Test Owner", password: PASSWORD }),
		headers: json,
		method: "POST",
	});
	if (!created.ok) {
		throw new Error(
			`sign-up failed (status ${created.status}): ${await created.text()}`
		);
	}

	// Standing in for the verification mail's link, exactly as `test-http.ts` does.
	await db
		.update(user)
		.set({ emailVerified: true })
		.where(eq(user.email, email));
	const [account] = await db
		.select({ id: user.id })
		.from(user)
		.where(eq(user.email, email));
	if (!account) {
		throw new Error("sign-up created no user row");
	}

	cookies.store(
		await app.request("/api/auth/sign-in/email", {
			body: JSON.stringify({ email, password: PASSWORD }),
			headers: json,
			method: "POST",
		})
	);

	const organization = await app.request("/api/auth/organization/create", {
		body: JSON.stringify({ name: "Test Org", slug: crypto.randomUUID() }),
		headers: { ...json, Cookie: cookies.header() },
		method: "POST",
	});
	const { id } = (await organization.json()) as { id: string };
	cookies.store(
		await app.request("/api/auth/organization/set-active", {
			body: JSON.stringify({ organizationId: id }),
			headers: { ...json, Cookie: cookies.header() },
			method: "POST",
		})
	);

	return { cookies, userId: account.id };
}

describe.skipIf(!ready)("session cookie cache", () => {
	afterEach(() => {
		setSystemTime();
	});

	/**
	 * One test for both halves of the tradeoff, because they are the same fact.
	 *
	 * A request that still answers 200 after the session row is gone is a request
	 * that never looked at the row — which is the saving the cache exists for, and
	 * the reason revocation is not instant. The window is what bounds the damage,
	 * so it is measured from both sides: honoured just inside it, refused just
	 * outside. 60 seconds is the number the account settings UI states where a user
	 * ends a session.
	 */
	it("honours a revoked session inside the window and refuses it after", async () => {
		const { cookies, userId } = await signIn();
		const signedInAt = Date.now();
		const read = () =>
			app.request("/api/projects", { headers: { Cookie: cookies.header() } });

		expect((await read()).status).toBe(200);

		// Revoked server-side, the way "end this session" does it.
		await db.delete(session).where(eq(session.userId, userId));

		expect((await read()).status).toBe(200);

		setSystemTime(
			new Date(signedInAt + (WINDOW_SECONDS - MARGIN_SECONDS) * 1000)
		);
		expect((await read()).status).toBe(200);

		setSystemTime(
			new Date(signedInAt + (WINDOW_SECONDS + MARGIN_SECONDS) * 1000)
		);
		expect((await read()).status).toBe(401);
	});
});
