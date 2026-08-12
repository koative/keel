import { db } from "@keel/db";
import { user } from "@keel/db/schema/auth";
import { eq } from "drizzle-orm";

import { app } from "@/app";

export interface Envelope<T> {
	data: T;
}

export interface ErrorEnvelope {
	error: {
		code: string;
		fix?: string;
		link?: string;
		message: string;
		requestId: string;
		why?: string;
	};
}

export interface TestClient {
	/** Reads a response body at a declared type. */
	body: <T>(response: Response) => Promise<T>;
	cookie: string;
	post: (path: string, payload: unknown) => Promise<Response>;
	request: (path: string, init?: RequestInit) => Promise<Response>;
}

/**
 * A cookie-carrying client over `app.request` — the whole stack, no socket.
 *
 * `body` is the one place a response is given a type. The cast lives here rather
 * than at every call site because the assertions in the tests are what actually
 * validate the shape; spreading `as` through the suite would hide that.
 */
export function createClient(): TestClient {
	const client: TestClient = {
		async body<T>(response: Response): Promise<T> {
			return (await response.json()) as T;
		},
		cookie: "",
		post(path, payload) {
			return client.request(path, {
				body: JSON.stringify(payload),
				headers: { "Content-Type": "application/json" },
				method: "POST",
			});
		},
		async request(path, init = {}) {
			return await app.request(path, {
				...init,
				headers: { ...init.headers, Cookie: client.cookie },
			});
		},
	};

	return client;
}

/**
 * Signs a fresh user up through Better Auth, proves the address the way the
 * verification mail's link would, and returns the cookie a browser gets from the
 * resulting sign-in, with no organization attached. Route tests use the real
 * flow rather than a stubbed session, so the guard they exercise is the one that
 * runs in production.
 *
 * This is the state a user is in between signing up and onboarding: authenticated
 * but with no active organization, which every tenant-scoped route must answer
 * with a 403 rather than a 401 or an empty list.
 */
export async function signUpWithoutOrganization(): Promise<string> {
	const email = `${crypto.randomUUID()}@keel.test`;
	const password = "correct-horse-battery-staple";
	const signUp = await app.request("/api/auth/sign-up/email", {
		body: JSON.stringify({
			email,
			name: "Test Owner",
			password,
		}),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});

	if (!signUp.ok) {
		throw new Error(
			`sign-up failed (status ${signUp.status}): ${await signUp.text()}`
		);
	}

	/**
	 * `requireEmailVerification` refuses to issue a session for an address that
	 * has not been proven, so the sign-up above no longer returns a cookie. The
	 * proof is the verification mail's link, which a test cannot click — standing
	 * in for it is marking the address verified in the database. The session then
	 * comes from the real sign-in route, so the flow a browser runs after the
	 * link is the one the guards below exercise.
	 */
	await db.update(user).set({ emailVerified: true }).where(eq(user.email, email));

	const response = await app.request("/api/auth/sign-in/email", {
		body: JSON.stringify({ email, password }),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});

	const setCookie = response.headers.get("set-cookie");
	if (!setCookie) {
		throw new Error(
			`sign-in returned no cookie (status ${response.status}): ${await response.text()}`
		);
	}

	return setCookie.split(";")[0] ?? "";
}

/**
 * The same, onboarded: a signed-up user who owns one organization and has it
 * active. This is what a tenant-scoped route test wants.
 *
 * `organization/create` sets the active organization on the existing session row,
 * so the cookie already held stays valid and simply starts resolving to a tenant.
 * Two calls therefore give two users in two different organizations, which is
 * what the cross-tenant tests need.
 */
export async function signUp(): Promise<string> {
	const cookie = await signUpWithoutOrganization();
	const created = await app.request("/api/auth/organization/create", {
		// The slug column is unique across the whole table and nothing reads it
		// back, so a UUID is the cheapest value that cannot collide between suites.
		body: JSON.stringify({ name: "Test Org", slug: crypto.randomUUID() }),
		headers: { "Content-Type": "application/json", Cookie: cookie },
		method: "POST",
	});

	if (!created.ok) {
		throw new Error(
			`organization/create failed (status ${created.status}): ${await created.text()}`
		);
	}

	return cookie;
}
