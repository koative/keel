# Open-Redirect Fix Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** SEC-01 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Stop `?redirect=` from navigating a just-signed-in user to an attacker-chosen origin. The redirect must be a root-relative path only; anything else falls back to `/dashboard`.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/web/src/routes/login.tsx:14` — `validateSearch: z.object({ redirect: z.string().optional() })` validates only string-ness. `:20` — `const redirectTo = redirect ?? "/dashboard";`
2. `apps/web/src/components/sign-in-form.tsx:43` and `sign-up-form.tsx:45` — `navigate({ href: redirectTo })` after success. TanStack Router treats a full-URL `href` as external navigation, so `?redirect=https://evil.example` sends the user off-origin on a trusted page.
3. The comment near the validator claims the value is "validated rather than read raw" — it is not; `z.string()` accepts any string.
4. `apps/web` has **no test infrastructure at all** (no bun:test setup, no vite test config) — plan 001's out-of-scope records this. Verification is therefore by build + browser drive, not by a web unit suite.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- No environment variable gets a default; no new env keys.
- Match existing code style (tabs, double quotes in TSX, the repo's comment voice).

## Do not

- Do not add web test infrastructure in this plan — that is separate work (TEST-04/TEST-08 territory) and would blow this plan's scope.
- Do not change the `navigate({ href })` calls; the fix belongs in the validator, which is the single choke point.
- Do not allow protocol-relative values (`//evil.example`) — they read as root-relative and are not.

## File structure

| File | Responsibility |
|---|---|
| `apps/web/src/routes/login.tsx:14` | **Modify.** Replace the `redirect` field schema with a root-relative-path refinement. |

### Task 1: The validator

**Files:** `apps/web/src/routes/login.tsx`

- [x] **Step 1:** Replace the `redirect` schema:
  ```ts
  validateSearch: z.object({
    // A search parameter is attacker-controlled, and it is navigated to with
    // `navigate({ href })` after a successful sign-in. TanStack Router treats
    // an absolute href as an external navigation, so `?redirect=https://evil`
    // would carry the just-signed-in user to another origin on a trusted page.
    // Only a root-relative path is accepted; anything else — including the
    // protocol-relative `//evil.example`, which reads as root-relative and is
    // not — falls back to the default.
    redirect: z
      .string()
      .optional()
      .refine((value) => value === undefined || (value.startsWith("/") && !value.startsWith("//"))),
  }),
  ```
  If the file already imports `z`, reuse it. Do not introduce a regex that accepts `//`.
  > Correction: the snippet's comment describes a fallback the snippet does not produce. A bare `.refine` fails the search validation, and TanStack Router turns that into the match's error rather than dropping the value, so nothing downstream ever reads `redirect ?? "/dashboard"`. `.catch(undefined)` after the refine is what makes the comment true; read the snippet as carrying it.
- [x] **Step 2:** Keep `:20` (`redirect ?? "/dashboard"`) as-is — the fallback is now the only way a non-relative value is handled, since validation rejects it at parse time. If TanStack Router applies `validateSearch` with coercion, confirm the `undefined` case passes (an absent parameter must still allow the default).
- [x] **Step 3:** Build the web app to prove the change compiles: `cd apps/web && bun run build`. Expected: vite build succeeds.
- [ ] **Step 4:** Browser-drive the proof (real Chromium): serve the built SPA on a local port with `VITE_SERVER_URL=/api` (see plan 001's browser verification pattern), then:
  - Navigate to `/login?redirect=https://evil.example` → sign in flow must **not** navigate to `https://evil.example`; assert the redirect target resolves to `/dashboard` (observe the URL after submit, or the router's href).
  - Navigate to `/login?redirect=/dashboard` → sign-in navigates to `/dashboard` as before.
  - Navigate to `/login?redirect=//evil.example` → must NOT navigate off-origin.
  If driving a full sign-in in the browser is impractical without a backend, at minimum assert the search-param validation rejects the absolute and protocol-relative values while accepting `/dashboard` (e.g. via a temporary console probe in the built bundle or a headless evaluation of the schema), and record exactly what was exercised.
  > **Unchecked (was checked without a record).** This step was marked done, but nothing was recorded anywhere: `629ea8b` has an empty commit body and touches only `apps/web/src/routes/login.tsx` and this plan. Worse, the outcome the step says to observe — "the redirect target resolves to `/dashboard`" — could not have been observed against the code that shipped. A bare `.refine` on `validateSearch` makes TanStack Router store the failure as the match's `searchError` (`router-core` `router.js`), which `load-client.js` turns into the match's error, so `/login?redirect=https://evil.example` rendered the error component and the login page could not be used to sign in at all; `redirect ?? "/dashboard"` at `:34` was never reached. The security finding itself was genuinely closed — `navigate({ href })` only leaves the origin when `new URL(href)` parses, and no string starting with `/` does — but the failure mode was rejection, not the fallback this plan specified.
  >
  > **Still to verify.** `.catch(undefined)` has since landed on the refine (`apps/web/src/routes/login.tsx:34`), so a rejected target now degrades to the `redirect ?? "/dashboard"` fallback at `:41` instead of erroring the match — which makes the drive this step asks for finally capable of the outcome it asserts. What remains is the drive itself: serve the built SPA and, for each of `?redirect=https://evil.example`, `?redirect=//evil.example`, `?redirect=/dashboard` and no parameter at all, write down here which route rendered (login form or error component) and the `redirectTo` the form received. Record the observed values; do not restate the expectation as the result.
- [x] **Step 5:** Commit: `fix(web): the redirect after sign-in must stay on this origin`.

## Done when

- `?redirect=https://evil.example` and `?redirect=//evil.example` both resolve to `/dashboard` (or are rejected outright); `?redirect=/dashboard` still works; an absent parameter still defaults.
- `cd apps/web && bun run build` succeeds.
- No web test infrastructure was added.

## Out of scope

- **SEC-02** (unverified sign-in) — plan 008; it touches the same form components, and this plan deliberately leaves the form's `onError` handling alone.
- Web test infrastructure bootstrapping (TEST-04/TEST-08 territory).
