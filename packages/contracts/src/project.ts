import { project } from "@keel/db/schema/project";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod";

/**
 * Zod mirrors of the `project` table, derived rather than retyped.
 *
 * The point is drift: rename a column or drop a NOT NULL and the derived schema
 * changes with it, so the internal API stops compiling instead of quietly
 * serving a field that no longer exists.
 *
 * Fields are `.pick()`ed on purpose rather than taken wholesale. Wholesale would
 * mean a new column appears on the internal API the moment it is added to the
 * table, which is how a column meant to stay server-side gets published by
 * accident. Picking keeps the drift check — a removed or renamed column is a type
 * error here — without the automatic exposure.
 *
 * Nothing in this package feeds the public v1 contract. A frozen contract that is
 * derived from a mutable schema is not frozen; see
 * `apps/server/src/modules/projects/public/projects.v1.schema.ts`.
 */

const row = createSelectSchema(project);
const writable = createInsertSchema(project);

/**
 * Timestamps are `Date` in a row and ISO strings on the wire, and `z.date()`
 * cannot be expressed in JSON Schema at all — `z.toJSONSchema` throws on it — so
 * an OpenAPI document cannot be generated from the raw row schema.
 */
const wireTimestamps = {
	createdAt: z.iso.datetime(),
	updatedAt: z.iso.datetime(),
};

/**
 * Every column the internal API may see, with timestamps in their wire form.
 *
 * `organizationId` is picked out deliberately. Every row in a response already
 * belongs to the caller's active organization — the guard put it there — so
 * repeating it on each item is noise the frontend would have to ignore. It is
 * absent, not forgotten. `createdBy` is here because "who added this" is
 * something a member list can render, unlike the tenancy key.
 */
export const projectFields = row
	.pick({
		createdAt: true,
		createdBy: true,
		description: true,
		id: true,
		name: true,
		slug: true,
		updatedAt: true,
	})
	.extend(wireTimestamps);

/** The columns a caller may set. Lengths and formats are API policy, so they are
 * applied by the module that publishes the endpoint, not here. */
export const projectWritableFields = writable.pick({
	description: true,
	name: true,
	slug: true,
});
