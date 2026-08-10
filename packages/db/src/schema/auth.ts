import { relations } from "drizzle-orm";
import {
	bigint,
	boolean,
	index,
	integer,
	pgTable,
	text,
	timestamp,
} from "drizzle-orm/pg-core";

export const user = pgTable("user", {
	createdAt: timestamp("created_at", { withTimezone: true })
		.defaultNow()
		.notNull(),
	email: text("email").notNull().unique(),
	emailVerified: boolean("email_verified").default(false).notNull(),
	id: text("id").primaryKey(),
	image: text("image"),
	name: text("name").notNull(),
	updatedAt: timestamp("updated_at", { withTimezone: true })
		.defaultNow()
		.$onUpdate(() => /* @__PURE__ */ new Date())
		.notNull(),
});

export const session = pgTable(
	"session",
	{
		/**
		 * Added to `session` by the organization plugin, which is why it lives here
		 * and not in `schema/organization.ts`. It carries no foreign key: upstream
		 * declares the field with no reference, so a deleted organization leaves the
		 * id dangling and the plugin's own membership check is what rejects it. A FK
		 * would also point this module at `./organization`, which already imports
		 * `user` from here.
		 *
		 * `input: false` upstream — a client can never set it directly, only through
		 * `setActive()` or the session-create hook in @keel/auth.
		 */
		activeOrganizationId: text("active_organization_id"),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		id: text("id").primaryKey(),
		ipAddress: text("ip_address"),
		token: text("token").notNull().unique(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		userAgent: text("user_agent"),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("session_userId_idx").on(table.userId)]
);

export const account = pgTable(
	"account",
	{
		accessToken: text("access_token"),
		accessTokenExpiresAt: timestamp("access_token_expires_at", {
			withTimezone: true,
		}),
		accountId: text("account_id").notNull(),
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		id: text("id").primaryKey(),
		idToken: text("id_token"),
		password: text("password"),
		providerId: text("provider_id").notNull(),
		refreshToken: text("refresh_token"),
		refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
			withTimezone: true,
		}),
		scope: text("scope"),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		userId: text("user_id")
			.notNull()
			.references(() => user.id, { onDelete: "cascade" }),
	},
	(table) => [index("account_userId_idx").on(table.userId)]
);

export const verification = pgTable(
	"verification",
	{
		createdAt: timestamp("created_at", { withTimezone: true })
			.defaultNow()
			.notNull(),
		expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
		id: text("id").primaryKey(),
		identifier: text("identifier").notNull(),
		updatedAt: timestamp("updated_at", { withTimezone: true })
			.defaultNow()
			.$onUpdate(() => /* @__PURE__ */ new Date())
			.notNull(),
		value: text("value").notNull(),
	},
	(table) => [index("verification_identifier_idx").on(table.identifier)]
);

/**
 * Better Auth's rate-limit counters, required by `rateLimit.storage: "database"`.
 *
 * Not written by this application: Better Auth owns every row, keyed by IP and
 * path. The shape mirrors `getAuthTables` in @better-auth/core — `key` unique,
 * `count` a plain integer, `lastRequest` an epoch in milliseconds, which is why
 * it is a bigint and not a timestamp. Better Auth prunes expired rows itself.
 */
export const rateLimit = pgTable("rate_limit", {
	count: integer("count").notNull(),
	id: text("id").primaryKey(),
	key: text("key").notNull().unique(),
	lastRequest: bigint("last_request", { mode: "number" }).notNull(),
});

export const userRelations = relations(user, ({ many }) => ({
	accounts: many(account),
	sessions: many(session),
}));

export const sessionRelations = relations(session, ({ one }) => ({
	user: one(user, {
		fields: [session.userId],
		references: [user.id],
	}),
}));

export const accountRelations = relations(account, ({ one }) => ({
	user: one(user, {
		fields: [account.userId],
		references: [user.id],
	}),
}));
