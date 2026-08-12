import { env } from "@keel/env/server";
import { payloadTooLarge } from "@keel/http/errors";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";

/**
 * `default-src 'none'` is the correct policy for a JSON API: nothing in a response
 * should ever be loaded or executed, so the strictest possible policy costs
 * nothing and is what an audit expects to find.
 *
 * The one HTML surface is `/reference`, which needs its own policy below.
 */
export const apiSecurityHeaders = secureHeaders({
	contentSecurityPolicy: {
		defaultSrc: ["'none'"],
		frameAncestors: ["'none'"],
	},
	// Enforced by the reverse proxy in front of this in production; declaring it
	// here means a direct-to-container deployment is not silently unprotected.
	strictTransportSecurity: "max-age=31536000; includeSubDomains",
	xFrameOptions: "DENY",
});

/**
 * Scalar renders client-side from jsDelivr, so the reference page cannot run under
 * `default-src 'none'`. The allowance is written out here rather than loosened
 * globally, so exactly one route carries it.
 */
export const referenceSecurityHeaders = secureHeaders({
	contentSecurityPolicy: {
		connectSrc: ["'self'"],
		defaultSrc: ["'none'"],
		fontSrc: ["'self'", "https://cdn.jsdelivr.net", "data:"],
		imgSrc: ["'self'", "https://cdn.jsdelivr.net", "data:"],
		scriptSrc: ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
		styleSrc: ["'self'", "https://cdn.jsdelivr.net", "'unsafe-inline'"],
	},
	strictTransportSecurity: "max-age=31536000; includeSubDomains",
	xFrameOptions: "DENY",
});

/**
 * An unbounded request body is a trivial way to exhaust memory. The limit is a
 * validated env key so a deployment that genuinely accepts uploads can raise it
 * without editing code.
 *
 * The rejection is written by hand rather than left to the middleware's default,
 * so an oversized body comes back in the same envelope as every other failure.
 */
export const requestBodyLimit = bodyLimit({
	maxSize: env.BODY_LIMIT_BYTES,
	onError: () => {
		throw payloadTooLarge(env.BODY_LIMIT_BYTES);
	},
});
