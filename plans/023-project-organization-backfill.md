# Migration 0001 Upgrade-Path Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** CORR-05 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Let a 0000-era database with project rows apply migration 0001. Today `0001_organizations_jobs.sql:61` runs `ALTER TABLE "project" ADD COLUMN "organization_id" text NOT NULL` with no DEFAULT and no backfill against a table that 0000 created with real rows — Postgres refuses `ADD COLUMN ... NOT NULL` on a non-empty table, and the upgrade aborts with no documented recovery.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `packages/db/src/migrations/0001_organizations_jobs.sql:61` — `ALTER TABLE "project" ADD COLUMN "organization_id" text NOT NULL;` (no DEFAULT, no backfill). `:65` adds the FK `project_organization_id_organization_id_fk` ON DELETE cascade.
2. Migrations present: 0000_initial, 0001_organizations_jobs, 0002_zone_aware_timestamps_and_seek_index, 0003_api_rate_limit, 0004_ai_usage, 0005_dedupe_unsettled_window. **No 0006 exists.**
3. 0001 also renames `project.owner_id` → `created_by` with a hand-added `DROP NOT NULL` (the known ARCH-05 hand-edit).
4. Fresh installs (empty DB) are unaffected — 0001 applies cleanly to an empty project table. Only 0000-era DBs with project rows break.
5. The schema (`packages/db/src/schema/project.ts`, scout-verified) already declares `organizationId NOT NULL` + FK cascade + unique `(org_id, slug)` + indexes `(org_id)`, `(org_id, created_at DESC NULLS FIRST, id DESC NULLS FIRST)`; `createdBy` nullable. The final schema is correct — only the migration's intermediate step is wrong.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- Test DB is up; `bun run db:test:migrate` once before DB tests.
- **Resolved as Option A (Step 1): 0001 was edited in place, and no new migration was created.** A repair migration ordered after 0001 can never run on the database that needs it — 0001 aborts first and the runner stops — so the only mechanical fix is making 0001 itself apply. This is an exception, not the new rule: every other committed migration stays frozen.
- `tools/check-migrations.ts` must stay green (schema ↔ migrations drift gate).

## Do not

- ~~Do not edit `0001_organizations_jobs.sql`.~~ **Superseded by Step 1's Option A — do not read this line as the standing rule.** 0001 was edited in place, matching the ARCH-05 hand-edit precedent the file already carries. It is safe for an already-migrated database because drizzle gates re-application on the stored `created_at` against the journal's `when`, which is unchanged, and never compares the sha256 it stores; the final schema is byte-identical either way.
- Do not delete or alter 0000-era data.
- Do not add a DEFAULT to `organization_id` in the schema — the final schema stays exactly as it is; the repair belongs in migration SQL only.

## File structure

| File | Responsibility |
|---|---|
| `packages/db/src/migrations/0001_organizations_jobs.sql` | **Modify** (Option A). The failing `ADD COLUMN ... NOT NULL` becomes add-nullable → backfill → `SET NOT NULL`. |
| `packages/db/src/migrations/0006_project_organization_backfill.sql` | ~~Create.~~ **Not created** — Option A needs no repair migration, and 0006 is taken by plan 012. |
| `packages/db/src/migrations/meta/*` | **Untouched.** The schema did not change, so nothing regenerates. |

### Task 1: The repair migration

**Files:** `packages/db/src/migrations/0001_organizations_jobs.sql`

- [x] **Step 1:** Understand the exact failure: a 0000-era DB has a `project` table with rows (columns per 0000: `id`, `name`, `slug`(?), `owner_id`, timestamps — read `0000_initial.sql` for the true 0000 project shape) and a `user` table, but **no** `organization`/`member` tables (0001 creates them). The repair must run AFTER 0001 has created organizations/members but BEFORE... no — the problem is 0001 itself fails on the non-empty project table. So the repair cannot run after 0001 if 0001 aborted.
  **Resolution:** the 0000-era operator's migration runner applies 0001, it aborts on the `NOT NULL` column, and the runner stops. The only durable fix is: 0001 must be made to apply on a non-empty project table. Since committed 0001 is frozen, the **operator-facing** repair is a documented 0006 that a 0000-era operator applies by first letting 0001 partially apply, then repairing — which is not how drizzle migrations work.
  **The actual design decision (read carefully):** the clean, testable fix is to change 0001's failing statement *in place* to the three-step form (add nullable → backfill → set not null) AND ship a 0006 that does the same for any database that somehow already ran a broken partial state. But the repo rule says never edit committed migrations. Weigh both and choose, with a comment in the chosen file explaining the trade:
  - **Option A (chosen if the repo's rule permits no exception):** edit `0001` minimally — `ADD COLUMN organization_id text` (nullable), backfill `UPDATE project SET organization_id = ...`, then `ALTER COLUMN ... SET NOT NULL` — all inside 0001, matching how 0001 already contains the hand-added `DROP NOT NULL` (the ARCH-05 precedent shows this file already carries hand edits with comments). Fresh installs: unchanged result. 0000-era with rows: applies. This is the only fix that actually unblocks the upgrade path, and it does not change the final schema (the drift gate stays green).
  - **Option B (fallback if the lead/plan direction is strictly no-edit):** ship 0006 as a documentation-plus-guard migration that fails loudly with a clear message when the 0000-era state is detected (no real repair possible), and record the manual SQL in a comment. Only choose this if Option A is vetoed — Option B does not fix the finding.
  Prefer **Option A**; it is the honest fix and the file already has hand-edit precedent. State your choice and rationale in the commit message.
- [x] **Step 2:** Backfill source: 0000-era projects have `owner_id` (the user). 0001 creates `organization` and `member` in the same migration. The backfill must give each project an organization: create one organization per distinct project `owner_id` (slug from user id, name "Default", or per-project orgs — read 0001's organization/member schema and the `project` table's 0000 columns to pick a deterministic, sensible mapping), insert a member row (owner role), and update the project's `organization_id`. Keep it deterministic and idempotent.
  - **Delivered:** deterministic, not idempotent. The `ON CONFLICT ("id") DO NOTHING` clauses that carried the idempotence intent were unreachable — `organization` and `member` are created empty in the same file and the same transaction, and each insert's source is `"user"`, keyed by its primary key — so they were removed; drizzle never replays a migration in any case.
- [x] **Step 3:** If you edited 0001 (Option A): the file already ends with the schema-matching state, so no new 0006 is needed and meta/ is untouched — verify `bun tools/check-migrations.ts` is green (it regenerates against the schema, which is unchanged). If you shipped 0006 instead (Option B): generate meta via `drizzle-kit generate --name project_organization_backfill` — but a no-op schema diff produces no migration, so you must hand-write the 0006 .sql plus journal/snapshot entries carefully or use the `drizzle-kit generate` after a temporary schema tweak — prefer Option A to avoid this entirely.
- [x] **Step 4:** Prove it: `bun run db:test:migrate` on a fresh test DB (green), then simulate the 0000-era path: create a scratch DB, apply only `0000_initial.sql` (via `bunx drizzle-kit migrate` or psql), insert a `user` and a `project` row, then run the full migration chain — it must apply without error and the project row must end up with an `organization_id` that exists in `organization`. Delete the scratch DB after. If the repo has a tool for this, use it; otherwise psql against the test postgres on :5433 is fine — record the exact commands in your report.
- [x] **Step 5:** Commit: `fix(db): 0001 applies to a 0000-era database with project rows`.

## Done when

- A 0000-era database (0000 applied, user + project rows present) runs the full migration chain to completion; the project row has a valid `organization_id`.
- A fresh install still migrates identically to before.
- `bun tools/check-migrations.ts` green; final schema untouched.
- The chosen approach (A vs B) and its rationale are in the commit message and a code comment.

## Out of scope

- **ARCH-05** (the drift gate cannot see hand-edited SQL) — plan 032, a later wave.
- Reverting or rewriting 0001's other statements (rename, DROP NOT NULL).
- The schema itself — it is correct.
