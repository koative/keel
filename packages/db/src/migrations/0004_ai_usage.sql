CREATE TABLE "ai_usage" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"input_tokens" integer NOT NULL,
	"job_id" text NOT NULL,
	"model" text NOT NULL,
	"organization_id" text NOT NULL,
	"output_tokens" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "ai_usage" ADD CONSTRAINT "ai_usage_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ai_usage_jobId_idx" ON "ai_usage" USING btree ("job_id");--> statement-breakpoint
CREATE INDEX "ai_usage_organization_created_idx" ON "ai_usage" USING btree ("organization_id","created_at");