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

- [x] **Step 1:** Read the installed better-auth session options (types or dist) to confirm the option names and units (`expiresIn` in seconds) and `updateAge`'s semantics for 1.6.25. Verified against `packages/auth/node_modules/better-auth/dist/context/create-context.mjs` (defaults `expiresIn: 3600*24*7`, `updateAge: 1440*60` — seconds) and `dist/api/routes/session.mjs:207` (`expiresAt - expiresIn*1e3 + updateAge*1e3 <= now` — refresh fires once the session is `updateAge` old), plus the `@better-auth/core` `init-options.d.mts` type docs.
- [x] **Step 2:** Add a `session` block to `createAuth` next to the other pinned knobs, with a comment stating the choice and why. **Deviation, sanctioned by the plan:** the sketch's `updateAge: 60 * 60 * 24` equals `expiresIn`, which the installed semantics make a *no-op* sliding window — the refresh condition only holds at the instant of expiry, so the session would never be extended. Chose `updateAge: 60 * 60` (one hour): strictly smaller than `expiresIn` so the session genuinely slides, keeps a working session alive through a normal day (any session older than an hour is renewed by the next request), and caps the renewal write at once per session per hour. The comment explains all of this and cites the installed `session.mjs` condition.
- [x] **Step 3:** Run the auth package tests if any exist (`cd packages/auth && bun test` — explicit paths) and the server typecheck. The lead runs the full gate. No tests exist in `packages/auth`; `bun run check-types` (tsc --noEmit) is green.
- [x] **Step 4:** Commit: `feat(auth): a session is a one-day decision, not a seven-day default`.

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
