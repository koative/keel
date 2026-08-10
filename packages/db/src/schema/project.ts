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
		// Millisecond precision, not the Postgres default of microseconds. The page
		// cursor is an ISO-8601 string, which carries exactly three fractional
		// digits, so anything finer is precision the sort key can never round-trip —
		// and truncating it back down in the query is what would cost this column its
		// index. A JS `Date` cannot hold microseconds either, so nothing is lost.
		createdAt: timestamp("created_at", { precision: 3, withTimezone: true })
			.defaultNow()
			.notNull(),
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
		// Matched to `createdAt`: two timestamp columns on one table at different
		// precisions is a difference nobody expects and everybody eventually trips on.
		updatedAt: timestamp("updated_at", { precision: 3, withTimezone: true })
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
		// The keyset page in `projects.repository`, in index order: the tenant
		// equality first, then the sort key exactly as the ORDER BY spells it. This
		// is what lets the seek start the scan at the cursor and stop at the limit,
		// instead of reading the organization's whole project set and top-N sorting
		// it on every page.
		//
		// `nullsFirst()` is load-bearing and easy to lose. Drizzle's `.desc()` on an
		// index column emits `DESC NULLS LAST`, while `desc()` in an `orderBy`
		// emits a bare `DESC` — which Postgres reads as NULLS FIRST. The two
		// orderings then disagree, so the index cannot supply the ordering and the
		// planner sorts anyway: measured at 17ms and a top-N heapsort, against
		// 0.05ms and an index scan once they match. Both columns are NOT NULL, so
		// this changes nothing about the data and everything about the plan.
		index("project_organization_created_idx").on(
			table.organizationId,
			table.createdAt.desc().nullsFirst(),
			table.id.desc().nullsFirst()
		),
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
