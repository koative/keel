# Require Email Verification Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** SEC-02 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** An account whose address has never been proven must not be able to sign in. The mail + token path already exists; the gate does not. Add `requireEmailVerification: true` to the `emailAndPassword` config and surface the not-verified state in the SPA sign-in form.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `packages/auth/src/index.ts:151-175` — `emailAndPassword` block sets `enabled: true` and `sendResetPassword`, but **no** `requireEmailVerification` anywhere (repo-wide grep: 0 hits).
2. `packages/auth/src/index.ts:176-188` — `emailVerification: { sendOnSignUp: true, sendVerificationEmail }` already lands (this part is done).
3. better-auth 1.6.25 gates sign-in on verification only when `emailAndPassword.requireEmailVerification` is truthy (verified in `dist/api/routes/sign-in.mjs:312`).
4. `apps/web/src/components/sign-in-form.tsx:38-40` — `onError` only toasts `error.error.message || error.error.statusText`; no not-verified branch.
5. The `emailAndPassword` block's own comment (around `:151`) claims the alternative is "an account whose address has never been proven: password reset then mails a stranger" — the code does not deliver on that claim today.

## Global Constraints

- `bun run check` must pass at the end of every task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- No environment variable gets a default; no new env keys.
- Better Auth config keys must be spelled exactly as the installed version (1.6.25) documents: `requireEmailVerification` is a property of `emailAndPassword`.

## Do not

- Do not add `requireEmailVerification` to `emailVerification` — it belongs on `emailAndPassword`.
- Do not invent a new error-code string. Use Better Auth's own `EMAIL_NOT_VERIFIED` status code (verify the exact constant in the installed better-auth dist before writing the form branch).
- Do not change the password-reset flow or the verification email rendering.

## File structure

| File | Responsibility |
|---|---|
| `packages/auth/src/index.ts:151-175` | **Modify.** Add `requireEmailVerification: true` to the `emailAndPassword` object. |
| `apps/web/src/components/sign-in-form.tsx:38-40` | **Modify.** Add a not-verified branch to `onError`. |

### Task 1: The gate

**Files:** `packages/auth/src/index.ts`

- [x] **Step 1:** In the `emailAndPassword` object, add `requireEmailVerification: true` next to `enabled`, and extend the nearby comment so it says what the code now does: sign-in is refused until the address is proven, which is what makes the password-reset path safe.
- [x] **Step 2:** Prove the flag is recognized: grep the installed better-auth dist for `requireEmailVerification` and confirm the config key name and the `EMAIL_NOT_VERIFIED` status string it returns (note the exact spelling in your report for the form task).
- [x] **Step 3:** Run the auth package's tests if any exist (`cd packages/auth && bun test` — explicit paths only); the lead runs the full gate.
- [x] **Step 4:** Commit: `feat(auth): refuse sign-in until the address is proven`.

### Task 2: Say it to the person typing the password

**Files:** `apps/web/src/components/sign-in-form.tsx`

- [x] **Step 1:** In `onError`, before the generic toast, branch on Better Auth's not-verified status (use the exact constant from Task 1 Step 2 — e.g. `error.error.status === "EMAIL_NOT_VERIFIED"`) and show a message that tells the user to check their inbox for the verification mail, rather than the generic failure.
- [x] **Step 2:** Build the web app to prove it compiles: `cd apps/web && bun run build`.
- [x] **Step 3:** Commit: `feat(web): tell the user the address is unverified, not that the password was wrong`.

## Done when

- `packages/auth/src/index.ts` sets `requireEmailVerification: true` and the comment matches reality.
- The sign-in form distinguishes "address not verified" from "credentials wrong".
- The change compiles (`bun run check` types + web build).

## Out of scope

- **SEC-07** (session lifetime) — plan 013; it edits the same `packages/auth/src/index.ts` file in a different region (the `session` config block), so coordinate if running concurrently: plan 013 owns `createAuth`'s `session` key, this plan owns `emailAndPassword`.
- Changing the verification email template or the sign-up flow.

## Follow-up (executed, commit `1f00c40`)

The gate had an unplanned consequence the scout pass did not list: with
`requireEmailVerification: true`, `/api/auth/sign-up/email` no longer issues a
session cookie, so `apps/server/test-http.ts`'s `signUp` helpers threw
"sign-up returned no cookie" and every route suite that signs up through them
went red — violating the Global Constraint that the gate stays green. Fixed in
`apps/server/test-http.ts`: the helper marks the address verified in the
database (the test's stand-in for the verification mail's link) and then signs
in through the real `/api/auth/sign-in/email` route, so the session the guards
exercise is still minted by production code. Verified against the test DB with
a live probe (sign-up → no cookie; verified sign-in → cookie; org create → 200)
and by running the affected suites.
