import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireUser } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
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
 */
export const internalProjectRoutes = new Hono<AppEnv>()
	.use(requireUser)
	.get("/", zValidator("query", projectPageSchema, rejectInvalid), list)
	.post("/", zValidator("json", createProjectSchema, rejectInvalid), create)
	.get("/:id", zValidator("param", projectIdSchema, rejectInvalid), get)
	.delete("/:id", zValidator("param", projectIdSchema, rejectInvalid), remove);
