import { relations } from "drizzle-orm";
import {
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";

export const project = pgTable(
	"project",
	{
		createdAt: timestamp("created_at").defaultNow().notNull(),
		description: text("description"),
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		name: text("name").notNull(),
		ownerId: text("owner_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		// Slugs are unique per owner, not globally: two tenants may both want
		// "billing". This is the constraint @keel/db/errors translates to a 409.
		uniqueIndex("project_owner_slug_idx").on(table.ownerId, table.slug),
		index("project_ownerId_idx").on(table.ownerId),
	]
);

export const projectRelations = relations(project, ({ one }) => ({
	owner: one(user, {
		fields: [project.ownerId],
		references: [user.id],
	}),
}));
