import { describe, expect, it } from "bun:test";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { env } from "@keel/env/server";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { app } from "@/app";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("lib/auth verification"));
}

const MailPayload = z.object({ html: z.string() });

/** The template puts the link in the one anchor the message carries. */
const HREF = /href="([^"]+)"/;

/**
 * A fresh account whose address is still unproven — the state every sign-up
 * leaves behind. `test-http`'s helpers mark the address verified on their way
 * past this gate, so they cannot stand in for it here: that state is what is
 * being asserted, not scaffolding around it.
 */
async function signUpUnverified() {
	const email = `${crypto.randomUUID()}@keel.test`;
	const password = "correct-horse-battery-staple";
	const created = await app.request("/api/auth/sign-up/email", {
		body: JSON.stringify({ email, name: "Test Owner", password }),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});

	if (!created.ok) {
		throw new Error(
			`sign-up failed (status ${created.status}): ${await created.text()}`
		);
	}

	return { email, password };
}

/** The link out of the verification mail sign-up queued — what a user clicks. */
async function verificationLink(email: string): Promise<string> {
	const [queued] = await db
		.select({ payload: job.payload })
		.from(job)
		.where(eq(job.dedupeKey, `mail:verification:${email}`));
	const { html } = MailPayload.parse(queued?.payload);
	const href = html.match(HREF)?.[1];

	if (href === undefined) {
		throw new Error("the verification mail carried no link");
	}

	// The template escapes for HTML; a browser unescapes before it requests.
	return href.replaceAll("&amp;", "&");
}

/**
 * The email-verification gate, through the mounted handler rather than the
 * option that turns it on. Two things have to hold and neither is visible from
 * `packages/auth`: an account cannot get a session before its address is proven,
 * and the mail that proves it leads back into the SPA.
 */
describe.skipIf(!ready)("email verification", () => {
	it("refuses to sign in an address that has not been proven", async () => {
		const { email, password } = await signUpUnverified();

		const response = await app.request("/api/auth/sign-in/email", {
			body: JSON.stringify({ email, password }),
			headers: { "Content-Type": "application/json" },
			method: "POST",
		});

		expect(response.status).toBe(403);
		expect(await response.json()).toMatchObject({
			code: "EMAIL_NOT_VERIFIED",
		});
		// A refusal that still handed out a session would be no refusal at all.
		expect(response.headers.get("set-cookie")).toBeNull();
	});

	/**
	 * Gating sign-in makes this link the only way into a new account, so where it
	 * lands is part of the gate. Better Auth builds it against this API and
	 * defaults its callback to `/`, which here answers a JSON 404.
	 */
	it("mails a link that lands on the SPA once the address is proven", async () => {
		const { email } = await signUpUnverified();

		const landing = await app.request(await verificationLink(email), {
			method: "GET",
			redirect: "manual",
		});

		expect(landing.status).toBe(302);
		expect(landing.headers.get("location")).toBe(
			new URL("/login", env.CORS_ORIGIN).toString()
		);
	});
});
