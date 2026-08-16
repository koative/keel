import { projectFields, projectWritableFields } from "@keel/contracts/project";
import { z } from "zod";
import { type Cursor, decodeCursor } from "@/lib/cursor";

/**
 * The internal surface. Shaped for the frontend that ships with this repo, and
 * free to change in the same commit as the component that reads it — no version,
 * no deprecation window.
 *
 * Field shapes come from `@keel/contracts`, which derives them from the Drizzle
 * table, so dropping or renaming a column stops this file from compiling instead
 * of silently serving a field that no longer exists. Lengths and formats are
 * added here because they are API policy, not database truth: the columns are
 * plain `text`.
 */

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;

export const createProjectSchema = projectWritableFields.extend({
	description: z.string().max(2000).nullable().default(null),
	name: z.string().min(1).max(120),
	slug: z
		.string()
		.min(1)
		.max(60)
		.regex(SLUG, "Use letters, numbers and single hyphens"),
});

// `description` has a default, so the accepted body and the parsed value differ.
export type CreateProjectInput = z.input<typeof createProjectSchema>;
export type CreateProjectOutput = z.output<typeof createProjectSchema>;

export const projectIdSchema = z.object({
	id: z.uuid(),
});

/**
 * Paging is validated, not merely parsed. `limit` is capped so one client cannot
 * ask for the whole table, and a cursor that did not come from us is rejected
 * here — decoding in the handler instead would turn a client typo into a 500.
 */
export const projectPageSchema = z.object({
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

export type ProjectPageQuery = z.output<typeof projectPageSchema>;

/**
 * Everything the frontend has, including fields a customer has no business seeing.
 *
 * The alias is not decoration, and deleting it as a one-line derivation is how this
 * was learned: `ProjectResponse` must infer from a symbol declared *here*. Inferring
 * straight from the imported `projectFields` makes `tsdown` emit a bare
 * `import "@keel/contracts/project"` at the head of `types/app.d.mts`, which pulls
 * drizzle-orm's declarations into a bundle compiled with `types: []` and fails
 * `tools/check-app-types.ts` with 87 errors from inside a dependency. A local binding
 * keeps the bundle self-contained, which is the property that check exists to hold.
 */
export const projectSchema = projectFields;

export type ProjectResponse = z.infer<typeof projectSchema>;
