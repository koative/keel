# Session Lifetime Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** SEC-07 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Make the session lifetime a decision in code instead of an inherited default. Today no `session.expiresIn` exists anywhere, so Better Auth's 7-day default applies while `apps/server/src/lib/membership.repository.ts:20-21` cites "seven days at Better Auth's default" as fact.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `packages/auth/src/index.ts` — no `session` config block, no `expiresIn` match anywhere except the `databaseHooks.session.create` hook at `:115-147` (which sets `activeOrganizationId` on create; it is not a lifetime setting).
2. `apps/server/src/lib/membership.repository.ts:20-21` — the doc comment says "until the session expires — seven days at Better Auth's default."
3. Better Auth 1.6.25's default is 7 days (audit-verified; the claim in the comment is accurate).
4. `requireOrg`'s membership re-check already mitigates removed members; the finding is about cookie theft duration.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- No environment variable gets a default; do not introduce a `SESSION_TTL_*` env key — the repo's rule is a decision in code (see the webhook TOLERANCE_MS precedent in plan 022: a constant, not a knob).
- The SPA must still work after a session expires: the existing 401-to-sign-in path (whatever the app does when the session API returns 401) must not regress — this is a duration change, not a mechanism change.

## Do not

- Do not set `expiresIn` without also considering `updateAge` — Better Auth's sliding renewal (`updateAge`) decides whether activity extends the session; read the installed version's `session` options (grep better-auth dist or types for `expiresIn`/`updateAge`) before choosing values.
- Do not change the session cookie flags or the `activeOrganizationId` create-hook.
- Do not touch `membership.repository.ts`'s behavior — only its comment (Task 2).

## File structure

| File | Responsibility |
|---|---|
| `packages/auth/src/index.ts` | **Modify.** Add a `session` block to `createAuth`. |
| `apps/server/src/lib/membership.repository.ts:20-21` | **Modify.** The comment says the true thing again. |

### Task 1: The decision

**Files:** `packages/auth/src/index.ts`

- [ ] **Step 1:** Read the installed better-auth session options (types or dist) to confirm the option names and units (`expiresIn` in seconds) and `updateAge`'s semantics for 1.6.25.
- [ ] **Step 2:** Add a `session` block to `createAuth` next to the other pinned knobs, with a comment stating the choice and why. Recommended (audit's sketch): one day with a sliding window:
  ```ts
  // One day, sliding: a stolen cookie is a one-day liability rather than a
  // seven-day one, and activity extends the session so a working user is not
  // logged out mid-day. Deliberately a constant, not an env key — a lifetime
  // knob that gets widened to stop complaints stops meaning anything.
  session: {
    expiresIn: 60 * 60 * 24,
    updateAge: 60 * 60 * 24,
  },
  ```
  Verify `updateAge`'s unit (Better Auth uses seconds too) before committing; if the installed version's semantics differ, choose the smallest value that keeps a working session alive through a normal day and say so in the comment.
- [ ] **Step 3:** Run the auth package tests if any exist (`cd packages/auth && bun test` — explicit paths) and the server typecheck. The lead runs the full gate.
- [ ] **Step 4:** Commit: `feat(auth): a session is a one-day decision, not a seven-day default`.

### Task 2: The comment that cited the old default

**Files:** `apps/server/src/lib/membership.repository.ts`

- [ ] **Step 1:** Update the doc comment at `:20-21` to name the new lifetime (one day, sliding) instead of "seven days at Better Auth's default", keeping the surrounding text's meaning.
- [ ] **Step 2:** Commit: `docs(membership): the comment matches the session policy`.

## Done when

- `createAuth` pins `session.expiresIn` (and `updateAge` where applicable) with a comment stating the choice.
- The membership comment names the actual lifetime.
- No new env key; no mechanism change.

## Out of scope

- **SEC-02** (email verification gate) — plan 008; it edits the same file's `emailAndPassword` block. Coordinate if concurrent: this plan owns the `session` key of `createAuth`, plan 008 owns `emailAndPassword`.
- Session cookie flags, CSRF, or the 401-to-sign-in UX.
