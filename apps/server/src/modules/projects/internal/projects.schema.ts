import { projectFields, projectWritableFields } from "@keel/contracts/project";
import { z } from "zod";

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

/** Everything the frontend has, including fields a customer has no business seeing. */
export const projectSchema = projectFields;

export type ProjectResponse = z.infer<typeof projectSchema>;
