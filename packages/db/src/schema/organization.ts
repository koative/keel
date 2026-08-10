import { relations } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { user } from "./auth";

/**
 * The three tables Better Auth's `organization()` plugin requires.
 *
 * Not written by this application: Better Auth owns every row here, through
 * `/api/auth/organization/*`. Nothing in this repo inserts into `member` or
 * `invitation`, and the only reason the tables are declared in Drizzle at all is
 * that `drizzleAdapter` resolves models by schema key — a missing key is a
 * runtime failure inside the plugin, not a type error here.
 *
 * The shape mirrors the plugin's own definition (the `schema` object in
 * `better-auth/dist/plugins/organization/organization.mjs`) with teams and
 * dynamic access control left disabled, so `team`, `teamMember`,
 * `organizationRole` and `session.activeTeamId` are deliberately absent. Adding
 * either option means adding tables here in the same commit.
 *
 * Deviation from upstream, and the only one: `createdAt` carries `defaultNow()`.
 * The plugin always supplies the value, so the default never fires in practice;
 * it exists so a row inserted by a test fixture or a migration backfill cannot
 * violate the NOT NULL.
 */
export const organization = pgTable("organization", {
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	id: text("id").primaryKey(),
	logo: text("logo"),
	/**
	 * Upstream types this `string`, not `json`: the plugin serialises the object
	 * itself and hands the adapter a string. Storing it as `jsonb` would make
	 * Better Auth write a JSON-encoded string into a JSON column and read back
	 * double-encoded, so this stays `text`.
	 */
	metadata: text("metadata"),
	name: text("name").notNull(),
	// Upstream marks slug both `unique` and `index: true`; in Postgres the unique
	// constraint already provides the index, so there is no separate one.
	slug: text("slug").notNull().unique(),
});

export const member = pgTable(
	"member",
	{
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		id: text("id").primaryKey(),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		// Upstream default. Roles are plain strings rather than an enum because the
		// plugin's `roles` option lets a deployment define its own set, and a
		// Postgres enum would have to be migrated to match.
		role: text("role").default("member").notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [
		index("member_organizationId_idx").on(table.organizationId),
		/**
		 * The covering index for the session-create hook in @keel/auth, which reads
		 * the user's earliest membership on every sign-in to seed
		 * `session.activeOrganizationId`. That lookup is on the hot path of the one
		 * request a user always makes, and without this index it is a sequential
		 * scan of every membership in the installation.
		 */
		index("member_userId_idx").on(table.userId),
	]
);

export const invitation = pgTable(
	"invitation",
	{
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		email: text("email").notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		id: text("id").primaryKey(),
		/**
		 * Cascades on user deletion, matching every other reference the plugin
		 * declares — it sets no explicit `onDelete`, and Better Auth's own migration
		 * generator defaults an unspecified reference to `cascade`. So a deleted
		 * inviter takes their outstanding invitations with them, which is the right
		 * outcome anyway: an invitation is an act by a person, and there is nobody
		 * left to have performed it.
		 */
		inviterId: text("inviter_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
		organizationId: text("organization_id")
			.notNull()
			.references(() => organization.id, { onDelete: "cascade" }),
		// Nullable, unlike `member.role`: upstream declares this field
		// `required: false`, so an invitation may carry no role and the accept path
		// falls back to the plugin's default.
		role: text("role"),
		// One of pending | accepted | rejected | canceled. Left as text for the same
		// reason as `member.role`.
		status: text("status").default("pending").notNull(),
	},
	(table) => [
		index("invitation_email_idx").on(table.email),
		index("invitation_organizationId_idx").on(table.organizationId),
	]
);

export const organizationRelations = relations(organization, ({ many }) => ({
	invitations: many(invitation),
	members: many(member),
}));

export const memberRelations = relations(member, ({ one }) => ({
	organization: one(organization, {
		fields: [member.organizationId],
		references: [organization.id],
	}),
	user: one(user, {
		fields: [member.userId],
		references: [user.id],
	}),
}));

export const invitationRelations = relations(invitation, ({ one }) => ({
	inviter: one(user, {
		fields: [invitation.inviterId],
		references: [user.id],
	}),
	organization: one(organization, {
		fields: [invitation.organizationId],
		references: [organization.id],
	}),
}));
