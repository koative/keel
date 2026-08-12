# Sealed-Secrets Consumer Note Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** DIR-04 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** State plainly in the docs that the sealed-secrets cipher ships with no in-repo consumer, so a reader does not assume an integration exists. The cipher itself (`@keel/crypto/seal`) is complete, tested, and documented; the honest gap is that no app code stores a third-party token through it yet.

## Verified evidence (scout-confirmed, do not re-litigate)

1. Repo-wide grep of `@keel/crypto/seal`: no source imports — only docs (AGENTS.md:21, README.md:339, docker-compose.prod.yml:66) and `packages/env/src/server.ts:124`'s comment on `SECRETS_ENCRYPTION_KEY` (`:135`, optional, Base64 of 32 bytes, AES-256-GCM in `@keel/crypto/seal`; rotation makes v1 rows unreadable).
2. `packages/crypto/src/seal.test.ts:3` imports `./seal` relatively — the only consumer is the cipher's own test.
3. README documents the flow (README.md:339, "Secrets at rest") as if it were reachable; it is not.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- Docs-only change; no code, no new env keys.

## Do not

- Do not add a consumer in this plan (an OAuth token store etc. is a real feature decision; the finding is about the docs telling the truth).
- Do not touch `packages/crypto`, `packages/env`, or `docker-compose.prod.yml` (plan 019 owns the compose env block).
- Do not edit AGENTS.md (plan 021 owns its length) — the README is the home for this note unless AGENTS.md:21 already says it (check; if AGENTS.md:21 already states the seal is test-only, the README note just needs to match).

## File structure

| File | Responsibility |
|---|---|
| `README.md` (~:339, the "Secrets at rest" section) | **Modify.** Add one or two sentences stating the current consumer state. |

### Task 1: The honest note

**Files:** `README.md`

- [x] **Step 1:** Read the README's "Secrets at rest" section (`:335-345` roughly) and the AGENTS.md mention (:21) so the wording is consistent across both docs.
- [x] **Step 2:** Add a sentence to the README section, in the repo's voice, e.g.: "No integration in this repository stores a third-party token through `seal` yet — the cipher ships tested and documented, and the first consumer (an OAuth provider token column, a webhook secret store) is where the rotation semantics become load-bearing." Adjust to match the section's actual prose and to agree with whatever AGENTS.md:21 already says.
- [x] **Step 3:** Commit: `docs(readme): seal ships with no consumer yet, and says so`.

## Done when

- README's Secrets-at-rest section states that no in-repo integration consumes `seal` yet, matching AGENTS.md's existing wording.
- No code changed.

## Out of scope

- Adding a seal consumer (feature decision).
- `docker-compose.prod.yml` or `packages/env` (plan 019's and plan 006's territory).
