import { z } from "zod";
import { type Cursor, decodeCursor } from "@/lib/cursor";

/**
 * The v1 customer contract. FROZEN.
 *
 * Removing a field, tightening a constraint or renaming anything here breaks
 * integrations that update on their own schedule. Additive changes are allowed;
 * anything else needs a v2 alongside this file. `projects.v1.contract.test.ts`
 * snapshots the JSON Schema so a careless edit fails the build instead of a
 * customer's pipeline.
 *
 * Note what is absent versus `internal/projects.schema.ts`: no `ownerId` (an
 * internal identifier), no `updatedAt` (an implementation detail we are not
 * promising to maintain). Exposing both to the frontend and freezing neither is
 * the point of keeping two schemas.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const projectV1Schema = z
	.object({
		created_at: z.iso.datetime(),
		id: z.uuid(),
		name: z.string(),
		slug: z.string(),
	})
	.meta({ id: "ProjectV1" });

export type ProjectV1 = z.infer<typeof projectV1Schema>;

export const projectIdV1Schema = z.object({
	id: z.uuid(),
});

// The envelope every response uses. Declared here so a route definition names a
// schema rather than assembling one inline.
export const projectV1Envelope = z.object({ data: projectV1Schema });

/**
 * `meta` was added after v1 shipped. Adding a member is additive — a client that
 * ignores it is unaffected — which is the only kind of change this file allows.
 * It landed before the first paged response rather than after, because a client
 * that has already read an unpaged list would otherwise start silently losing
 * rows the day a limit appeared.
 */
export const projectListV1Schema = z
	.object({
		data: z.array(projectV1Schema),
		meta: z.object({ nextCursor: z.string().nullable() }),
	})
	.meta({ id: "ProjectListV1" });

/**
 * Published query parameters. `cursor` is opaque and validated by decoding it:
 * a token we did not issue is a 422 from the validator, never a 500 downstream.
 */
export const projectPageV1Schema = z.object({
	cursor: z
		.string()
		.transform(decodeCursor)
		.refine(
			(cursor: Cursor | null) => cursor !== null,
			"Not a cursor from a previous page"
		)
		.optional(),
	limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type ProjectPageV1Query = z.output<typeof projectPageV1Schema>;

/** Narrower than the internal input on purpose: no description, stricter slug. */
export const createProjectV1Schema = z
	.object({
		name: z.string().min(1).max(120),
		slug: z
			.string()
			.min(1)
			.max(60)
			.regex(SLUG, "Lowercase letters, numbers and single hyphens"),
	})
	.meta({ id: "CreateProjectV1" });

export type CreateProjectV1 = z.infer<typeof createProjectV1Schema>;
