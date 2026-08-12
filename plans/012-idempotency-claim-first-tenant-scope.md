# Idempotency Claim-First and Tenant Scope Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** CORR-03 + CORR-07 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Two fixes to the idempotency middleware, shipped together because they touch the same files:

1. **CORR-03 (claim-first):** stop the check-then-act window in which two concurrent same-key requests both run the handler. The loser currently executes the side effect and then surfaces a 409; it must never reach the handler.
2. **CORR-07 (tenant scope):** include the active organization in the stored record and the replay match, so a retry after an organization switch cannot replay the first organization's stored response.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/lib/idempotency.ts:80` `findByActorAndKey(actorId, key)` → `:100` `await next()` → `:117-126` insert **after** the handler. The expired-key branch (`:83-86`) deletes then re-runs — same window.
2. `:96` throws `conflict(Request, HEADER)` for same-key-different-request; the race 409 comes from `withUniqueConflict` in `idempotency.repository.ts:43-46` wrapping the post-handler insert. The comment at `idempotency.ts:108-116` documents the race as intended — this plan changes that intent for the concurrent case only.
3. CORR-07: key space is `(actorId, key)` only — lookup `idempotency.ts:80`, replay-equality `:87-92` (method/path/requestHash), insert `:117-126`; repository lookup `idempotency.repository.ts:13-21`; index `packages/db/src/schema/idempotency.ts:48-53` `idempotency_key_actor_key_idx` on `(actorId, key)`; the table has **no organization_id column**.
4. **Middleware ordering is already correct**: `projects.v1.routes.ts:149` `requireUser` → `:154` `rateLimit` → `:159` `requireOrg` → `:164` `idempotent`. `c.get("organizationId")` is set by `requireOrg` (`auth.ts:53-64`, `context.ts:12-22`). So the fix is schema + lookup + insert — **no middleware reordering needed**.
5. The internal surface has no idempotency at all (only the v1 projects surface uses it).

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- Test DB is up; `bun run db:test:migrate` before DB tests. **This plan adds a migration** (idempotency_key.organization_id + index change) — it MUST be sequenced: it is the only plan allowed to run `drizzle-kit generate` in its wave (see Out of scope).
- The loser's status stays **409** — the repo's documented, deliberate answer (audit README: "CORR-03's loser gets a 409, not a 200. The double execution is signalled, and idempotency.ts:110-116 chose that deliberately"). This plan kills the *double execution*, not the 409.
- No file over 200 code lines.

## Do not

- Do not add a new job/queue table or reorder middleware.
- Do not change the request-hash equality or the expiry policy (24h or whatever `expiresAt` currently is — read it).
- Do not make `organizationId` optional in the stored row if a row can always be attributed (the actor always has an active org at this middleware's position — if `c.get("organizationId")` can be undefined, the middleware must fail closed with a 4xx, not store a null).

## File structure

| File | Responsibility |
|---|---|
| `packages/db/src/schema/idempotency.ts` | **Modify.** Add `organizationId` column; widen the unique index to `(actorId, organizationId, key)`. |
| `packages/db/src/migrations/0006_idempotency_organization.sql` | **Create** (drizzle-kit generate + one data statement if existing rows need org backfill — read whether the table can have pre-existing rows; if the table is new-only, the column can be NOT NULL from birth). |
| `apps/server/src/lib/idempotency.repository.ts` | **Modify.** Lookup on `(actorId, organizationId, key)`; claim-first insert. |
| `apps/server/src/lib/idempotency.ts` | **Modify.** Insert a claim row before `next()`; on conflict, 409 without running the handler; store the response on success; tenant-scoped replay equality. |
| `apps/server/src/lib/idempotency.test.ts` | **Modify/Extend.** Org-scope the existing cases. The new race and org-switch tests live in `apps/server/src/lib/idempotency-race.test.ts` (new file): the suite's existing cases were already at the 200-line cap, so the new coverage was split out rather than crammed in — same throwaway-app shape, same DB fixtures. |
| `apps/server/src/modules/projects/public/projects.v1.routes.ts:164` | Possibly **Modify** only if the middleware signature changes (it should not). |

### Task 1: The schema

**Files:** `packages/db/src/schema/idempotency.ts`, migration 0006

- [x] **Step 1:** Read the current schema and migration 0000/0001 to see how `idempotency_key` is defined and whether any migration can have left rows in it (if the table is only written by this middleware, and this middleware is v1-projects-only, pre-existing rows are possible in a deployed DB — decide nullable-then-backfill vs NOT NULL from birth based on that, and say which in the migration comment).
- [x] **Step 2:** Add `organizationId: text not null` (or nullable + backfill + `set not null` if pre-existing rows exist) with a FK to organization (match the project table's FK style, ON DELETE cascade), and change the unique index to `(actorId, organizationId, key)` (drop the old one).
- [x] **Step 3:** Generate the migration with `drizzle-kit generate` (check how the repo runs it: `cd packages/db && bunx drizzle-kit generate --name idempotency_organization` or the package script), format the resulting meta files like the repo's committed ones (see plan 024's post-landing fix: drizzle-kit emits verbose JSON; the repo's snapshots are formatter-compact — run the formatter on the generated meta or match the existing files' shape), and run `bun run db:test:migrate`.
- [x] **Step 4:** `bun tools/check-migrations.ts` green.
- [x] **Step 5:** Commit: `feat(db): idempotency keys are scoped to the active organization`.

### Task 2: Claim-first, and the org-scoped replay

**Files:** `apps/server/src/lib/idempotency.repository.ts`, `apps/server/src/lib/idempotency.ts`

- [x] **Step 1:** Read the whole middleware and repository (they are small). Map the current flow: lookup → equality → expired-delete → `next()` → insert.
- [x] **Step 2:** Repository: add a claim insert — `insert ... onConflictDoNothing({ target: [actorId, organizationId, key] }) returning *` — that returns the row whether it was newly inserted (this caller wins) or already existed (a concurrent caller or a true replay).
- [x] **Step 3:** Middleware, new flow:
  1. Look up by `(actorId, organizationId, key)`.
  2. If a committed row exists and its method/path/requestHash match → replay the stored response (existing behavior, now org-scoped).
  3. If a committed row exists and differs → 409 (existing behavior).
  4. If none exists → **claim-insert first** (before `next()`). Winner proceeds to the handler; a concurrent loser's claim-insert conflicts → the loser 409s immediately, before its handler runs. On the winner's success path, store the response on the claimed row. On the winner's failure path, delete the claim (or mark it — match the existing failure handling in `:117-126` and the test "stores nothing for a failure so the retry reaches the handler").
  - The expired-key branch: same claim-first shape (delete the expired row, then claim).
- [x] **Step 4:** Keep the comment voice: update `:108-116` so it says the race is closed (the loser never runs the handler) while the 409 answer is unchanged.
- [x] **Step 5:** Tests (extend `idempotency.test.ts`):
  - Two **concurrent** same-key requests (fire both, await both): exactly one runs the handler (assert via a handler side-effect counter), the loser gets 409.
  - Org switch: perform a request with org A, then the same key+body with org B → B must NOT replay A's response (it runs fresh or 409s as a new key-space member).
  - All existing tests keep passing (especially "stores nothing for a failure" and the 409 cases).
- [x] **Step 6:** Run the suite: `cd apps/server && bun test src/lib/idempotency.test.ts` — green.
- [x] **Step 7:** Commit: `fix(idempotency): the loser never runs the handler, and replays are org-scoped`.

## Done when

- Two concurrent same-key requests execute the handler exactly once; the loser gets 409 without side effects.
- A retry after an organization switch cannot replay the previous org's response.
- The unique index is `(actorId, organizationId, key)`; migration 0006 applies cleanly; `check-migrations` green.
- All existing idempotency tests pass.

## Out of scope

- The internal surface's lack of idempotency (not a finding).
- **CORR-07's** claim that requireOrg ordering already prevents leaks — it does (verified); this plan only closes the silent wrong-tenant replay.
- Any change to the request-hash or expiry policy.
- **Migration serialization**: this plan runs `drizzle-kit generate` and owns migration 0006. No other plan in the same wave may run drizzle-kit generate (plans 023, 025, 026 each own a later migration and are sequenced after this one).
