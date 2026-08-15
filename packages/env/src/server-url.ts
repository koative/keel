import { z } from "zod";

/**
 * What `VITE_SERVER_URL` may hold.
 *
 * Its own module, rather than an inline schema in `web.ts`, because importing
 * `web.ts` executes `createEnv` — which validates the whole client environment
 * and throws before a test can reach the rule it wants to check. The rule is
 * the thing worth testing, so it lives where it can be imported alone.
 *
 * Two shapes, because there are two deployments. An absolute origin is used as
 * given. A root-relative path is resolved against the page origin by
 * `serverOrigin` in `apps/web/src/lib/server-url.ts`, which is how the Docker
 * image and Vercel previews are wired — the API answers on the same origin as
 * the app, and hard-coding a host into a static bundle would make the build
 * environment-specific.
 *
 * `z.url()` alone rejected the second shape, so a deployment following the
 * documented wiring shipped an SPA that threw at module import. The resolver
 * that exists to handle the value never ran.
 *
 * Protocol-relative is rejected on purpose: `//evil.example` reads as
 * root-relative and is not — the browser resolves it to another origin. Schemes
 * other than http(s) are rejected for the same reason a fetch base has no
 * business being `javascript:` or `file:`.
 *
 * A relative value must carry at least one path segment. `serverOrigin` strips a
 * trailing slash, so a bare `/` would reduce to the empty string and every URL
 * built on it would throw at module import — the crash this schema exists to
 * prevent. `/` also has no meaning as an API base: it claims the whole origin.
 */
export const serverUrlSchema = z.string().refine(
	(value) => {
		if (value.startsWith("/")) {
			return value.length > 1 && !value.startsWith("//");
		}

		try {
			const parsed = new URL(value);
			return parsed.protocol === "http:" || parsed.protocol === "https:";
		} catch {
			return false;
		}
	},
	{
		message:
			"VITE_SERVER_URL must be an absolute http(s) origin (https://api.example.com) or a root-relative path resolved against the page origin (/api). See .env.example.",
	}
);
