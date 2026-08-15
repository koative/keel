CREATE TABLE "job" (
	"attempts" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"dedupe_key" text,
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"last_error" text,
	"locked_at" timestamp,
	"locked_by" text,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"payload" jsonb NOT NULL,
	"run_at" timestamp DEFAULT now() NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "job_status_check" CHECK ("job"."status" in ('pending', 'running', 'done', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "invitation" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"email" text NOT NULL,
	"expires_at" timestamp NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"inviter_id" text NOT NULL,
	"organization_id" text NOT NULL,
	"role" text,
	"status" text DEFAULT 'pending' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "member" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"user_id" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"created_at" timestamp DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"logo" text,
	"metadata" text,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	CONSTRAINT "organization_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "project" RENAME COLUMN "owner_id" TO "created_by";--> statement-breakpoint
--> Hand-added. `owner_id` was NOT NULL and a renamed column keeps its
--> constraints, but `created_by` is nullable on purpose: its foreign key is ON
--> DELETE SET NULL, and Postgres cannot set null on a NOT NULL column, so
--> deleting a user failed with a constraint violation instead of clearing the
--> creator. drizzle-kit does not diff nullability across a rename, so its own
--> diff reports the schema as matching; tools/check-migrations.ts replays this
--> statement and fails naming `"project"."created_by"` if it is ever removed.
ALTER TABLE "project" ALTER COLUMN "created_by" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "project" DROP CONSTRAINT "project_owner_id_user_id_fk";
--> statement-breakpoint
DROP INDEX "project_owner_slug_idx";--> statement-breakpoint
DROP INDEX "project_ownerId_idx";--> statement-breakpoint
ALTER TABLE "session" ADD COLUMN "active_organization_id" text;--> statement-breakpoint
--> Hand-added. `organization_id` is NOT NULL on purpose, but the original
--> `ADD COLUMN ... NOT NULL` here aborted on any 0000-era database: 0000's
--> `project` table already holds rows, and Postgres refuses to add a NOT NULL
--> column to a non-empty table, halting the whole upgrade with no recovery.
--> Committed migrations are frozen history, yet the only mechanical fix for
--> such a database is making 0001 itself apply, and a fresh install ends with
--> the identical final schema. Both forms leave `organization_id` NOT NULL, so
--> the drift gate reads them the same way, and this file already carries the
--> hand edit above. So the column is added nullable, backfilled, then tightened:
--> one organization per distinct creator (a 0000-era project's `created_by`
--> is its old NOT NULL `owner_id`, so every row has one), with an owner
--> member row. Ids and slugs derive from the user id, so the backfill is
--> deterministic.
ALTER TABLE "project" ADD COLUMN "organization_id" text;
--> statement-breakpoint
INSERT INTO "organization" ("id", "slug", "name")
SELECT 'org_' || "user"."id", "user"."id", 'Default'
FROM "user"
WHERE "user"."id" IN (SELECT "created_by" FROM "project");
--> statement-breakpoint
INSERT INTO "member" ("id", "organization_id", "user_id", "role")
SELECT 'member_' || "user"."id", 'org_' || "user"."id", "user"."id", 'owner'
FROM "user"
WHERE "user"."id" IN (SELECT "created_by" FROM "project");
--> statement-breakpoint
UPDATE "project" SET "organization_id" = 'org_' || "project"."created_by" WHERE "organization_id" IS NULL;
--> statement-breakpoint
ALTER TABLE "project" ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_inviter_id_user_id_fk" FOREIGN KEY ("inviter_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invitation" ADD CONSTRAINT "invitation_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "member" ADD CONSTRAINT "member_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_status_runAt_idx" ON "job" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "job_dedupeKey_pending_idx" ON "job" USING btree ("dedupe_key") WHERE "job"."status" = 'pending';--> statement-breakpoint
CREATE INDEX "invitation_email_idx" ON "invitation" USING btree ("email");--> statement-breakpoint
CREATE INDEX "invitation_organizationId_idx" ON "invitation" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_organizationId_idx" ON "member" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "member_userId_idx" ON "member" USING btree ("user_id");--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_created_by_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project" ADD CONSTRAINT "project_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "project_organization_slug_idx" ON "project" USING btree ("organization_id","slug");--> statement-breakpoint
CREATE INDEX "project_organizationId_idx" ON "project" USING btree ("organization_id");