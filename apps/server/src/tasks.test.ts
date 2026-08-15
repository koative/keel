import { describe, expect, it } from "bun:test";
import { $ } from "bun";

/**
 * The maintenance script's error isolation, exercised as a process rather than as
 * a function.
 *
 * `guardedSweep` is private to a module that does its work at import, so the
 * process is the only honest seam: what the script promises is that one failed
 * statement does not take the rest of the run, the summary, the exit code or
 * `closePool` with it. That promise shipped with plan 026 and was never tested,
 * which is how the stranded-job reclaim stayed outside the guard.
 *
 * The fault injected is an unreachable database, so every statement rejects
 * before it reads or writes a row. That matters on a database the mail suite is
 * using concurrently: a run that cannot connect cannot sweep a peer's rows, and
 * a run against the real one would.
 */
const ABSENT_DATABASE_URL =
	"postgresql://postgres:password@localhost:5433/keel_tasks_absent";

/** Every maintenance statement the script makes, in the order it makes them. */
const STEPS = [
	"idempotency",
	"auth rate-limit",
	"idle token bucket",
	"settled job",
	"stranded job",
];

describe("tasks", () => {
	it("isolates a failed step, still summarises the run and exits non-zero", async () => {
		// The override is a shell prefix rather than a replacement environment: the
		// child inherits the keys `@keel/env` validates at import, and only the
		// one this test is about changes.
		const run = await $`DATABASE_URL=${ABSENT_DATABASE_URL} bun src/tasks.ts`
			.cwd(new URL("..", import.meta.url).pathname)
			.nothrow()
			.quiet();

		const reported = run.stderr.toString();
		// One report per step is what proves the isolation: the first failure did
		// not stop the four statements queued behind it.
		for (const step of STEPS) {
			expect(reported).toContain(`[tasks] ${step} sweep failed:`);
		}

		// The summary is the line a cron log is read for, and it printed even
		// though every step failed — including the last one, whose bare `await`
		// used to reject at module top level and take this line with it.
		expect(run.stdout.toString()).toContain(
			"[tasks] swept 0 idempotency key(s), 0 auth rate-limit counter(s), 0 idle token bucket(s), 0 settled job(s); requeued 0 stranded job(s), exhausted 0"
		);
		// Reported and summarised is not the same as fine: cron has to see this
		// run as a failure.
		expect(run.exitCode).toBe(1);
	});
});
