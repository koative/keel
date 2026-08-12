# README and AGENTS.md Accuracy Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** DOCS-01 + DOCS-02 (`plans/audit-report.md`), plus the AGENTS.md clause handed over by plan 022.
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Make README.md's claims about the repo's own enforcement match reality: the architecture-rule count, the AGENTS.md length promise, and the webhook receiver sentence that plan 022 updated in the code but deliberately left for this plan to carry into AGENTS.md.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `README.md:48-49` — "**The enforcement is itself tested.** A rule that quietly stops matching looks / exactly like clean code. `tools/check-rules.ts` violates all thirteen on purpose" — **the count is now 20**, not 13 (plan 014 added fixtures; `bun run check` prints "check-rules: 20 architecture rules verified against deliberate violations.").
2. `README.md:383-384` — "`AGENTS.md` is the agent entry point; `CLAUDE.md` is a symlink to it. It stays / under 40 lines and deliberately repeats nothing the linter already enforces." — `wc -l AGENTS.md` = **82**. The promise is already false.
3. `AGENTS.md:49-51` — "Webhook receivers verify over `await c.req.arrayBuffer()`, persist, enqueue, return 200; a re-stringified body produces a different digest and rejects every event." Plan 022 (landed) changed the code and the README's webhook paragraph to include the 5-minute replay window and the event-id dedupe; the AGENTS.md sentence must now say the same true thing. The handover clause, verbatim from plan 022:
   > Webhook receivers verify over `await c.req.arrayBuffer()`, refuse a delivery stamped more than five minutes from now, persist, enqueue under the provider's event id, return 200; a re-stringified body produces a different digest and rejects every event.
4. AGENTS.md's line count must not grow beyond 82 (ideally stay at 82) — the replacement clause is a within-line edit.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- AGENTS.md line count must stay 82 (or shrink), and the file's content discipline ("repeats nothing the linter enforces") stays intact.

## Do not

- Do not edit anything in `tools/` — the counts come from there; this plan only reports them accurately.
- Do not rewrite AGENTS.md wholesale to hit 40 lines. Trimming to under 40 is a big structural change owned by nobody yet; the finding is that the README *claims* something false. The honest fix is the claim.
- Do not touch the webhook sentence in README (plan 022 already made it correct); only AGENTS.md:49-51 gets the replacement.

## File structure

| File | Responsibility |
|---|---|
| `README.md:49` | **Modify.** "thirteen" → the current count, or drop the number. |
| `README.md:383-384` | **Modify.** Make the AGENTS.md length claim true. |
| `AGENTS.md:49-51` | **Modify.** Apply plan 022's replacement clause, keeping line count at 82. |

### Task 1: The rule count

**Files:** `README.md`

- [x] **Step 1:** Confirm the count by running `bun tools/check-rules.ts` and reading its summary line (expected: 20).
- [x] **Step 2:** In README.md:49, replace "all thirteen" with the verified count — e.g. "violates all twenty on purpose" — or, if the number is likely to drift again, rephrase to drop the number ("violates every architecture rule on purpose"). Prefer the phrasing that stays true longest; the repo's own check prints the count, so a prose number is inherently drift-prone.
- [x] **Step 3:** Commit: `docs(readme): the architecture-rule count matches the checker`.

### Task 2: The AGENTS.md length promise

**Files:** `README.md:383-384`

- [ ] **Step 1:** Decide the honest claim. AGENTS.md is 82 lines. Either say "It stays short and deliberately repeats nothing the linter already enforces" (drops the number), or state a true bound. Prefer dropping the number — a line-count promise without an enforced gate is exactly the class of stale claim this finding is about.
- [ ] **Step 2:** Commit: `docs(readme): the AGENTS.md length promise was already false`.

### Task 3: The webhook sentence, made true

**Files:** `AGENTS.md:49-51`

- [ ] **Step 1:** Read the current sentence and the surrounding Background-work section so the replacement reads naturally in context.
- [ ] **Step 2:** Apply plan 022's handover clause as a within-line edit, keeping the file at 82 lines (verify with `wc -l` after).
- [ ] **Step 3:** Commit: `docs(agents): webhook receivers now have a replay window and an event id`.

## Done when

- README's rule count and AGENTS.md length claims are both true (or number-free).
- AGENTS.md:49-51 describes the 5-minute window and event-id enqueue.
- AGENTS.md is still 82 lines.

## Out of scope

- Trimming AGENTS.md below 40 lines — a structural rewrite, deliberately not this plan.
- Updating `plans/README.md` (the lead owns it).
- Any `tools/` change.
