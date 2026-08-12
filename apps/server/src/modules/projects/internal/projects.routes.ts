import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireOrg, requireUser } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
import { rateLimit } from "@/lib/rate-limit";
import { rejectInvalid } from "@/lib/validate";
import { create, get, list, remove } from "./projects.handlers";
import {
	createProjectSchema,
	projectIdSchema,
	projectPageSchema,
} from "./projects.schema";

/**
 * `/api/projects` — the surface the bundled frontend talks to.
 *
 * Unversioned and free to change: a rename here travels in the same commit as
 * the component that reads it. Nothing outside this repo is allowed to depend on
 * it, which is the whole reason `public/` exists separately.
 *
 * Routes are chained rather than declared statement by statement so the app type
 * carries every endpoint, which is what makes a typed client possible.
 *
 * `requireOrg` follows `requireUser` and never precedes it: it only asserts on
 * what the session already resolved, so a signed-in member with no active
 * organization gets a 403 the SPA can route to onboarding, while an anonymous
 * caller still gets the 401 that tells it to sign in.
 *
 * `rateLimit` goes between the two. It is keyed on the actor `requireUser`
 * resolved, and refusing before `requireOrg` means a caller already over budget
 * does not cost a membership query as well.
 */

// No PATCH or PUT on purpose: nothing in the web app edits a project yet, and
// an update endpoint is where validation and tenancy decisions start
// accumulating. Adding one later is additive and safe; removing one is not —
// the same deliberate scope the v1 surface explains for its absent DELETE.
export const internalProjectRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.use(rateLimit)
	.use(requireOrg)
	.get("/", zValidator("query", projectPageSchema, rejectInvalid), list)
	.post("/", zValidator("json", createProjectSchema, rejectInvalid), create)
	.get("/:id", zValidator("param", projectIdSchema, rejectInvalid), get)
	.delete("/:id", zValidator("param", projectIdSchema, rejectInvalid), remove);
