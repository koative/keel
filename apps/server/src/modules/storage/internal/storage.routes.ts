import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireOrg, requireUser } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
import { rateLimit } from "@/lib/rate-limit";
import { rejectInvalid } from "@/lib/validate";
import { downloadUrl, uploadUrl } from "./storage.handlers";
import { downloadUrlQuerySchema, uploadUrlQuerySchema } from "./storage.schema";

/**
 * `/api/storage` — presigned upload and download URLs, the whole surface the
 * storage layer exposes.
 *
 * The bytes never pass through the API: a client gets back a URL that is signed
 * for exactly one key and one method, and talks to the bucket directly, so a
 * large file occupies neither a worker nor a pooled connection on its way up or
 * down. This is the internal, unversioned surface — a `/v1` storage contract is
 * a decision for whoever freezes one, not something this module presumes.
 *
 * The guard chain matches the other internal surfaces: `requireUser` first, so
 * an anonymous caller gets the 401 that tells it to sign in; `rateLimit`
 * between the two, keyed on the actor it resolved; `requireOrg` last, so a
 * signed-in member with no active organization gets the 403 the SPA routes to
 * onboarding — and the tenant the keys are prefixed with comes from the session,
 * never from the request.
 */
export const internalStorageRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.use(rateLimit)
	.use(requireOrg)
	.get(
		"/upload-url",
		zValidator("query", uploadUrlQuerySchema, rejectInvalid),
		uploadUrl
	)
	.get(
		"/download-url",
		zValidator("query", downloadUrlQuerySchema, rejectInvalid),
		downloadUrl
	);
