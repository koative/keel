import { relations } from "drizzle-orm";
import {
	index,
	pgTable,
	text,
	timestamp,
	uniqueIndex,
} from "drizzle-orm/pg-core";
import { user } from "./auth";
import { organization } from "./organization";

export const project = pgTable(
	"project",
	{
		createdAt: timestamp("created_at").defaultNow().notNull(),
		// Nullable and `set null` rather than `cascade`: removing a member must not
		// take the organization's work with them. This is display and audit data,
		// not the tenancy key — that is `organizationId`.
		createdBy: text("created_by").references(() => user.id, {
			onDelete: "set null",
		}),
		description: text("description"),
		id: text("id")
			.primaryKey()
			.$defaultFn(() => crypto.randomUUID()),
		name: text("name").notNull(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		slug: text("slug").notNull(),
		updatedAt: timestamp("updated_at")
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
	},
	(table) => [
		// Slugs are unique per organization, not globally: two tenants may both want
		// "billing". This is the constraint @keel/db/errors translates to a 409.
		uniqueIndex("project_organization_slug_idx").on(
			table.organizationId,
			table.slug
		),
		index("project_organizationId_idx").on(table.organizationId),
	]
);

export const projectRelations = relations(project, ({ one }) => ({
	creator: one(user, {
		fields: [project.createdBy],
		references: [user.id],
	}),
	organization: one(organization, {
		fields: [project.organizationId],
		references: [organization.id],
	}),
}));
