import { describe, expect, it } from "bun:test";
import { app } from "@/app";
import { skipNotice, testDbReady } from "../../test-db";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("lib/auth verification"));
}

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

/**
 * The email-verification gate, through the mounted handler rather than the
 * option that turns it on — `requireEmailVerification` is one boolean in
 * `packages/auth` and nothing else in the repo observes it.
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
});
