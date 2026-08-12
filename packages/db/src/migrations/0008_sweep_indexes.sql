CREATE INDEX "rate_limit_lastRequest_idx" ON "rate_limit" USING btree ("last_request");--> statement-breakpoint
CREATE INDEX "job_status_updatedAt_idx" ON "job" USING btree ("status","updated_at");