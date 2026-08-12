import { describe, expect, it } from "bun:test";
import { shouldPollImmediately } from "@/lib/jobs";

/**
 * The worker's poll/sleep decision, extracted so the loop's one branch is not
 * a piece of entrypoint code nothing exercises. `worker.ts` never calls this
 * with a zero batch size — `WORKER_BATCH_SIZE` is validated `.min(1)` in
 * `@keel/env` — so the degenerate call below is only possible from here, and
 * the function stays a bare comparison rather than gaining a branch for an
 * input the environment cannot produce.
 */
describe("worker poll decision", () => {
	it.each([
		{ batchSize: 1, processed: 0 },
		{ batchSize: 10, processed: 0 },
		{ batchSize: 10, processed: 9 },
		{ batchSize: 100, processed: 99 },
	])(
		"sleeps when the batch has room left ($processed of $batchSize)",
		({ processed, batchSize }) => {
			expect(shouldPollImmediately(processed, batchSize)).toBe(false);
		}
	);

	it.each([
		{ batchSize: 1, processed: 1 },
		{ batchSize: 10, processed: 10 },
		{ batchSize: 100, processed: 100 },
	])(
		"polls again when the batch was exactly full ($processed of $batchSize)",
		({ processed, batchSize }) => {
			expect(shouldPollImmediately(processed, batchSize)).toBe(true);
		}
	);

	it.each([
		{ batchSize: 1, processed: 2 },
		{ batchSize: 10, processed: 11 },
	])(
		"polls again when the batch was claimed to capacity ($processed of $batchSize)",
		({ processed, batchSize }) => {
			expect(shouldPollImmediately(processed, batchSize)).toBe(true);
		}
	);

	// A zero-sized batch claims nothing, so "full" and "empty" are the same
	// answer — `0 >= 0` holds and the function reports a full batch. No branch
	// defends the case because the env schema's `.min(1)` is the guard that
	// actually prevents a hot loop; pinning the bare comparison here is what
	// keeps a future "fix" for the unreachable input from silently changing the
	// real contract.
	it("treats a zero-sized batch as full", () => {
		expect(shouldPollImmediately(0, 0)).toBe(true);
	});
});
