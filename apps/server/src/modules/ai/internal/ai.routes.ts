import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireOrg, requireUser } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
import { rateLimit } from "@/lib/rate-limit";
import { rejectInvalid } from "@/lib/validate";
import { generate } from "./ai.handlers";
import { generateSchema } from "./ai.schema";

/**
 * `/api/ai` — the internal surface that makes the AI layer reachable.
 *
 * One route: enqueue a generation and get the job id back. The completion
 * itself happens in the worker, so a request here never waits on a model — and
 * the tenant that gets billed comes from the session, never from the request.
 *
 * The guard chain matches every other internal surface: `requireUser` first,
 * so an anonymous caller gets the 401 that tells it to sign in; `rateLimit`
 * between the two, keyed on the actor it resolved; `requireOrg` last, so a
 * signed-in member with no active organization gets the 403 the SPA routes to
 * onboarding.
 *
 * Unversioned and free to change, like all of `/api`: nothing outside this
 * repo may depend on it, and a `/v1` AI contract is a frozen-contract decision
 * nobody has made yet.
 */
export const internalAiRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.use(rateLimit)
	.use(requireOrg)
	.post(
		"/generate",
		zValidator("json", generateSchema, rejectInvalid),
		generate
	);
