/**
 * Resolves `VITE_SERVER_URL` to an absolute origin.
 *
 * A relative value is legitimate when the API is served from the same origin as
 * the app, which is how the Docker deployment and Vercel previews are wired.
 * Extracted so `auth-client.ts` and `api.ts` cannot drift into disagreeing about
 * where the server is.
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

	return `http://localhost:3000${normalized}`;
}
