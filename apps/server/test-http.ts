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
 * Signs a fresh user up through Better Auth and returns the cookie a browser
 * would send back. Route tests use the real flow rather than a stubbed session,
 * so the guard they exercise is the one that runs in production.
 */
export async function signUp(): Promise<string> {
	const email = `${crypto.randomUUID()}@keel.test`;
	const response = await app.request("/api/auth/sign-up/email", {
		body: JSON.stringify({
			email,
			name: "Test Owner",
			password: "correct-horse-battery-staple",
		}),
		headers: { "Content-Type": "application/json" },
		method: "POST",
	});

	const setCookie = response.headers.get("set-cookie");
	if (!setCookie) {
		throw new Error(
			`sign-up returned no cookie (status ${response.status}): ${await response.text()}`
		);
	}

	return setCookie.split(";")[0] ?? "";
}
