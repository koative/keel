import { zValidator } from "@hono/zod-validator";
import { Hono } from "hono";
import { requireUser } from "@/lib/auth";
import type { AppEnv } from "@/lib/context";
import { rejectInvalid } from "@/lib/validate";
import { create, get, list } from "./projects.v1.handlers";
import { createProjectV1Schema, projectIdV1Schema } from "./projects.v1.schema";

/**
 * `/v1/projects` — the customer-facing contract.
 *
 * Deliberately fewer endpoints than `internal/`: there is no DELETE here yet,
 * because publishing one commits us to its semantics forever. Adding an endpoint
 * later is additive and safe; removing one is not.
 */
export const publicProjectRoutesV1 = new Hono<AppEnv>()
	.use(requireUser)
	.get("/", list)
	.post("/", zValidator("json", createProjectV1Schema, rejectInvalid), create)
	.get("/:id", zValidator("param", projectIdV1Schema, rejectInvalid), get);
