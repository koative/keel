CREATE TABLE "webhook_event" (
	"event_id" text NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"processed_at" timestamp with time zone,
	"provider" text NOT NULL,
	"raw_body" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_event_provider_event_id_idx" ON "webhook_event" USING btree ("provider","event_id");