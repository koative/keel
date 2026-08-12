# Migration Drift Gate Hand-Edit Visibility Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** ARCH-05 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Close the single unguarded seam in the migration pipeline: hand-edited SQL inside a committed migration that drizzle-kit would not re-emit is invisible to CI today. `0001`'s `ALTER COLUMN "created_by" DROP NOT NULL` is the documented example; the next hand-edit gets caught.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `tools/check-migrations.ts:1-59` — backs up `meta/`, runs `bunx drizzle-kit generate --name drift-probe`, lists any new `.sql` files, restores `meta/`, deletes the probe and exits 1 if drift found. **The comparison is schema → SQL only**; it never validates that each committed migration's hand-edited statements match the schema.
2. `packages/db/src/migrations/0001_organizations_jobs.sql:48-55` — the hand-added comment says `owner_id` was `NOT NULL` … "drizzle-kit does not diff nullability across a rename … tools/check-migrations.ts cannot catch this class of drift either" — then `:55` `ALTER TABLE "project" ALTER COLUMN "created_by" DROP NOT NULL;`.
3. The schema (`packages/db/src/schema/project.ts`) declares `createdBy` **nullable** — so the hand-edit is currently *consistent* with the schema; the gate just cannot prove it.
4. The repo's own comment at `biome.jsonc:184`-adjacent tooling culture: every enforced rule is itself tested. This is the migration analogue.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- `tools/check-migrations.ts` is the home of the gate; extend it, do not fork it.
- The check must stay fast (it already runs a generate probe; add only what is cheap).

## Do not

- Do not parse SQL with regexes and assert on them — hand-edit drift is a *schema agreement* problem, not a syntax problem. The check must compare **what the migrations collectively declare** against **what the schema declares**.
- Do not rewrite committed migrations to "fix" their hand-edits — they are frozen; the gate must *see* them, not change them.
- Do not make the check require a live database (it must run in CI's check step, which has no DB — only the test job does).
- Do not change the existing generate-probe behavior — it catches missing migrations; the new check is additive.

## File structure

| File | Responsibility |
|---|---|
| `tools/check-migrations.ts` | **Modify.** Add the hand-edit visibility pass. |

### Task 1: A nullability snapshot the gate can diff

**Files:** `tools/check-migrations.ts`

- [ ] **Step 1:** Read the whole current script. Understand: (a) how it invokes drizzle-kit, (b) whether the meta snapshots (`packages/db/src/migrations/meta/000N_snapshot.json`) are available at check time (they are, in-tree), and (c) what drizzle-kit's snapshot format contains per column (`default`, `nullable`, `type`). The snapshot JSON is the authoritative record of what the *generated* migrations declared.
- [ ] **Step 2:** Design the pass: for each table/column in the **current schema** (which the script can read via the drizzle schema module — check how the script imports `packages/db/src/schema` or whether it shells out), compare nullability against the latest snapshot that should contain it. The gap the hand-edit exposes: `created_by` is nullable in the schema and in the hand-edited 0001, but a *fresh* `drizzle-kit generate` would emit `ADD COLUMN ... NOT NULL`-era nullability differently across the rename — the snapshot's `created_by` entry is the tell. The precise assertion: **for every column in the latest migration snapshot, the schema's nullability must match**; where they differ, the script reports the column as drift (the hand-edit changed SQL without a schema change, or the schema changed without a migration — both directions report).
  - If reading the drizzle schema from the script is not straightforward (it may require a DB or env), fall back to parsing the snapshot JSON + the schema's drizzle definitions via the same module the generate probe uses — read `packages/db/package.json`/`drizzle.config.ts` to see what's importable without a DB. Choose the implementation that is honest about what it checks: if only the snapshot side is reachable without a DB, assert snapshot-vs-schema from a second generate-probe artifact instead (generate produces the *would-be* SQL; diff the nullability statements the probe emits against the committed migrations' statements — the probe reflects the schema, the committed files reflect history, and a hand-edit shows up as a committed statement with no probe counterpart).
- [ ] **Step 3:** Implement the chosen pass so that:
  - the current tree (0001's hand-edit, schema nullable) is **green** — the hand-edit agrees with the schema, so the gate proves agreement, not just absence;
  - a planted drift is **red**: temporarily change `schema/project.ts`'s `createdBy` to non-nullable (or flip any column), run the script, confirm it reports that column, then revert. Record both directions (schema-ahead and migration-ahead if reachable) in your verification.
- [ ] **Step 4:** Keep the output in the script's existing voice (`check-migrations: ...` summary line) and exit codes (0/1).
- [ ] **Step 5:** Run `bun tools/check-migrations.ts` — green; run `bun run check`'s script chain — green (the lead runs the full gate).
- [ ] **Step 6:** Commit: `feat(tools): migration drift now sees hand-edited SQL`.

## Done when

- The gate proves the `created_by` hand-edit agrees with the schema (green on the current tree).
- A planted nullability drift fails the gate naming the column.
- The existing missing-migration probe still works.
- No committed migration was edited.

## Out of scope

- **CORR-05** (the 0001 upgrade path for 0000-era DBs) — plan 023, an earlier wave; if it edits 0001, re-verify this gate against the final tree.
- Rewriting or normalizing committed migrations.
- A live-DB migration replay check (the check step has no DB by design).
