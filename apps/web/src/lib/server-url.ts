/**
 * Resolves `VITE_SERVER_URL` to an absolute origin.
 *
 * A relative value is legitimate when the API is served from the same origin as
 * the app, which is how the Docker deployment and Vercel previews are wired.
 * Extracted so `auth-client.ts` and `api.ts` cannot drift into disagreeing about
 * where the server is.
 *
 * The relative form always carries at least one path segment: `serverUrlSchema`
 * in `@keel/env` rejects a bare `/`, so stripping a trailing slash below cannot
 * empty the value and leave callers building URLs against no base at all.
 *
 * Throws when a relative value has nothing to resolve against, rather than falling
 * back to `http://localhost:3000`. That fallback was reachable in exactly one
 * situation — a build with no window and no Vercel URL — and in that situation it
 * baked a developer's laptop into the bundle, where it presents as a browser
 * quietly failing to reach an API that is running.
 */
export function serverOrigin(url: string): string {
	const normalized = url.endsWith("/") ? url.slice(0, -1) : url;

	if (!normalized.startsWith("/")) {
		return normalized;
	}

	if (typeof window !== "undefined") {
		return `${window.location.origin}${normalized}`;
	}

	const processEnv = (
		globalThis as { process?: { env?: Record<string, string | undefined> } }
	).process?.env;
	const vercelUrl =
		processEnv?.VERCEL_ENV === "production"
			? (processEnv?.VERCEL_PROJECT_PRODUCTION_URL ?? processEnv?.VERCEL_URL)
			: (processEnv?.VERCEL_URL ?? processEnv?.VERCEL_PROJECT_PRODUCTION_URL);

	if (vercelUrl) {
		const origin = vercelUrl.startsWith("http")
			? vercelUrl
			: `https://${vercelUrl}`;
		return `${origin}${normalized}`;
	}

	throw new Error(
		`VITE_SERVER_URL is relative ("${normalized}") and there is no origin to resolve it against: no window, and no Vercel deployment URL in the environment. Give this build an absolute VITE_SERVER_URL.`
	);
}
