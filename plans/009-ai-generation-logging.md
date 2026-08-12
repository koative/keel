# AI Generation Logging Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** SEC-06 (`plans/audit-report.md`)
**Audited commit:** `39fd32c` — HEAD has moved (33 commits past). Line numbers below are scout-verified at `421f5db`.
**Goal:** Stop the worker from writing the unbounded AI completion — user-supplied prompt output — to stdout, where it lands in container logs. Keep the completion reachable in development, and never lose it silently in production.

## Verified evidence (scout-confirmed, do not re-litigate)

1. `apps/server/src/worker.ts:105-107` — `process.stdout.write(\`[ai.generate] ${jobId} ${generation.model} in=${generation.usage.inputTokens} out=${generation.usage.outputTokens}\n${generation.text}\n\`);` — writes the **entire** `generation.text` (unbounded) to stdout.
2. The comment at `worker.ts:101-104` explicitly calls the stdout write "the seam": "a starter has nowhere honest to put it". It is a deliberate seam, but the delivery (container logs) is the wrong one for user data.
3. Shutdown path: `worker.ts:177` `process.exit(1)` (deadline), `:188` `process.exit(1)` (drain failure), `:193` `process.exit(0)` (clean), `:206` `process.exit(1)` (loop rejection). `process.exit` does not flush buffered stdout to a pipe — a `console.log`-style write can be lost exactly when it is the only record.
4. The handler still records usage to the `ai_usage` ledger (`hasUsageForJob`/`recordUsage`, worker.ts:86-107) — the audit trail for charging is already durable; the stdout write is presentation, not bookkeeping.

## Global Constraints

- `bun run check` must pass at the end of the task (the lead runs the full gate; run targeted checks yourself).
- All code, comments and commit messages in English.
- No environment variable gets a default; no new env keys.
- The ai.generate handler stays registered and the usage ledger stays untouched.

## Do not

- Do not delete the write entirely without a replacement path — the completion must be reachable in development.
- Do not log the prompt to stdout in any environment (it is the same class of leak).
- Do not touch `packages/ai/src/*` — the change is in the worker's handler, which is app code.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/worker.ts:101-107` | **Modify.** Gate the stdout echo behind non-production, cap its length. |
| `apps/server/src/worker.ts:193` (clean exit) | **Modify.** Flush stdout before `process.exit(0)`. |

### Task 1: Gate and cap the echo

**Files:** `apps/server/src/worker.ts`

- [ ] **Step 1:** Replace the unconditional `process.stdout.write` with one gated on the environment (the worker already has `env` in scope — check how `env.NODE_ENV` or `env.LOG_DRAIN` is accessed elsewhere in the file and use the same source), and cap the echoed text:
  ```ts
  // The seam stays a seam, but stdout is the wrong sink for user data: in
  // production this lands in container logs, aggregated and readable far
  // beyond the database. Development keeps the echo — capped, because the
  // completion is unbounded — and production records only the durable
  // summary the usage ledger already holds.
  if (env.NODE_ENV !== "production") {
    process.stdout.write(
      `[ai.generate] ${jobId} ${generation.model} in=${generation.usage.inputTokens} out=${generation.usage.outputTokens}\n${generation.text.slice(0, 4000)}\n`
    );
  }
  ```
  Keep the usage-ledger lines exactly as they are.
- [ ] **Step 2:** Confirm the write is the only stdout emission of prompt/completion content in the file (grep `generation.text` / `payload` in worker.ts).
- [ ] **Step 3:** Commit: `fix(worker): a completion is not a log line`.

### Task 2: Don't lose the last record

**Files:** `apps/server/src/worker.ts` (the clean-exit path)

- [ ] **Step 1:** Before `process.exit(0)` at the clean-exit point (`:193`), await a stdout flush. The portable form that does not hold the event loop hostage:
  ```ts
  await new Promise<void>((resolve) => process.stdout.write("", resolve));
  ```
  Place it after the drain completes and before the exit call. The deadline and drain-failure exits (`:177`, `:188`) keep their current behavior — a hard deadline that awaits a flush would defeat the deadline's purpose — but add a brief comment noting why only the clean path flushes.
- [ ] **Step 2:** Smoke-run the worker briefly in development (`cd apps/server && bun src/worker.ts` with a timeout) to confirm it still boots and the clean shutdown path executes (a `[worker]` shutdown line appears and the process exits 0).
- [ ] **Step 3:** Commit: `fix(worker): flush stdout before the clean exit`.

## Done when

- In production, no AI completion text reaches stdout; in development it does, capped at 4000 characters.
- The clean shutdown flushes pending stdout writes before `process.exit(0)`.
- The usage ledger is untouched and the handler still runs.

## Out of scope

- **DIR-01** (an endpoint that can enqueue AI work) — plan 035.
- Changing `packages/ai` or the evlog drain configuration.
