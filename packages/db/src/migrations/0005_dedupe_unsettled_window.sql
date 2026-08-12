-- Legacy rows: the old index allowed a second unsettled row to take a key while
-- the first was running, so a live table can hold pairs the new index forbids.
-- Keep the oldest in-flight row per key and unkey the rest rather than deleting
-- them: those jobs were always going to run, the duplicate execution already
-- happened under the old rule, and a null dedupe key is how the schema already
-- spells "this row does not participate in dedupe". Nothing queued is lost.
UPDATE "job" SET "dedupe_key" = NULL WHERE "id" IN (
	SELECT "id" FROM (
		SELECT "id", row_number() OVER (
			PARTITION BY "dedupe_key" ORDER BY "created_at", "id"
		) AS rn
		FROM "job"
		WHERE "dedupe_key" IS NOT NULL AND "status" IN ('pending', 'running')
	) ranked WHERE ranked.rn > 1
);--> statement-breakpoint
DROP INDEX "job_dedupeKey_pending_idx";--> statement-breakpoint
CREATE UNIQUE INDEX "job_dedupeKey_unsettled_idx" ON "job" USING btree ("dedupe_key") WHERE "job"."status" in ('pending', 'running');