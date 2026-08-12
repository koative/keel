ALTER TABLE "idempotency_key" ADD COLUMN "organization_id" text;
--> statement-breakpoint
--> Hand-added. The table predates this column (migration 0000), so a deployed
--> database can hold rows written when the tenant was never recorded, and
--> there is nothing to backfill them with. They are unreplayable under the new
--> key space (actor_id, organization_id, key) for exactly that reason, and
--> every row is a 24-hour TTL cache the sweep already drops, so the honest
--> move is to remove them and make the column NOT NULL from here on.
--> drizzle-kit generated a bare `ADD COLUMN ... NOT NULL`, which fails on
--> exactly the table with rows this migration is written for.
DELETE FROM "idempotency_key";
--> statement-breakpoint
ALTER TABLE "idempotency_key" ALTER COLUMN "organization_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
DROP INDEX "idempotency_key_actor_key_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_key_actor_organization_key_idx" ON "idempotency_key" USING btree ("actor_id","organization_id","key");
