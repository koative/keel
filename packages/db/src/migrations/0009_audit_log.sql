CREATE TABLE "audit_log" (
	"actor_id" text,
	"created_at" timestamp (3) with time zone DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"method" text NOT NULL,
	"organization_id" text,
	"path" text NOT NULL,
	"request_id" text NOT NULL,
	"status" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_actor_id_user_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_organization_created_idx" ON "audit_log" USING btree ("organization_id","created_at" DESC NULLS FIRST,"id" DESC NULLS FIRST);