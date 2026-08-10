CREATE TABLE "api_rate_limit" (
	"key" text PRIMARY KEY NOT NULL,
	"tokens" double precision NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "api_rate_limit_updatedAt_idx" ON "api_rate_limit" USING btree ("updated_at");