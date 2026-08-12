import { env } from "@keel/env/server";
import {
	type ClaimedJob,
	claim,
	complete,
	fail,
	markUnsettled,
} from "./jobs.repository";

/**
 * The queue's public face: what a job kind means, what one pass of a worker
 * does, and how work gets in. Everything that touches the table lives in
 * `jobs.repository`, which is private to this pair — callers reach the queue
 * through this module, so its surface stays one import wide and a lint rule
 * can say so.
 */

// biome-ignore lint/performance/noBarrelFile: not a barrel — this module owns the worker loop and re-exports exactly one entry point so that `@/lib/jobs` is the whole queue API. The alternative the rule leaves, importing then exporting the binding, is what noExportedImports forbids.
export {
	type EnqueueInput,
	type EnqueueResult,
	enqueue,
} from "./jobs.repository";

/**
 * The payload is `unknown` on purpose. It comes back from jsonb and crossed a
 * process boundary, so it has no more claim to a type than a request body does;
 * a handler parses it — with a contract schema — exactly as a route does.
 *
 * `jobId` is passed alongside it because it is the only stable identifier for
 * this unit of work that survives a retry: the row keeps its id across every
 * attempt. A handler calling a provider that accepts an idempotency key hands
 * this over, and a redelivery then cannot produce a second side effect.
 */
export type JobHandler = (payload: unknown, jobId: string) => Promise<void>;

export type JobRegistry = Map<string, JobHandler>;

/**
 * How many times a worker re-tries the settling UPDATE before giving the row up.
 *
 * Three, not one, because `complete` is a single fenced UPDATE with no
 * constraint left to violate: the only way it throws is infrastructural — a pool
 * hiccup, a dropped connection, a failover — and those clear in milliseconds far
 * more often than they last. Not thirty, because a worker that cannot reach
 * Postgres three times running will not be talked round by a fourth, and every
 * extra try holds the single worker slot open while the queue drains nowhere.
 *
 * Retrying is safe by construction rather than by hope: the fence includes
 * `status = 'running'`, so a second attempt after a first that committed but
 * whose acknowledgement was lost matches zero rows and reports "not me" instead
 * of settling anything twice.
 */
const SETTLE_ATTEMPTS = 3;

/** Doubles per retry — 100ms then 200ms, the length of a pool hiccup. */
const SETTLE_RETRY_BASE_MS = 100;

/**
 * Claims a batch and runs it, returning how many jobs were processed.
 *
 * The count is what lets a caller distinguish "queue empty, go to sleep" from
 * "batch was full, there is probably more waiting" without a second query.
 */
export async function runOnce(
	registry: JobRegistry,
	workerId: string,
	limit: number = env.WORKER_BATCH_SIZE
): Promise<number> {
	const claimed = await claim(workerId, limit);

	// Sequentially, not with Promise.all: every job in the batch would want its
	// own pooled connection at the same moment, and the pool is sized for the
	// whole process. Parallelism in this queue is a second worker, not a wider
	// batch.
	for (const entry of claimed) {
		// biome-ignore lint/performance/noAwaitInLoops: one job at a time is the intended throughput ceiling; a parallel batch would hold DATABASE_POOL_MAX connections that request handling also draws from.
		await runJob(registry, entry, workerId);
	}

	return claimed.length;
}

/**
 * Whether the worker should poll again immediately instead of sleeping.
 * A full batch means more work was already due when it was claimed, so
 * sleeping with a backlog just delays the next batch.
 */
export function shouldPollImmediately(
	processed: number,
	batchSize: number
): boolean {
	return processed >= batchSize;
}

async function runJob(
	registry: JobRegistry,
	entry: ClaimedJob,
	workerId: string
): Promise<void> {
	const handler = registry.get(entry.kind);

	// An unregistered kind is a deployment mistake — usually an old worker
	// meeting a job a newer release enqueued — not a queue error. Recording it
	// on the row keeps it visible and retryable once the worker catches up,
	// whereas throwing here would strand every job behind it in this batch.
	if (handler === undefined) {
		await fail(
			entry.id,
			workerId,
			`no handler registered for job kind "${entry.kind}"`
		);
		return;
	}

	try {
		await handler(entry.payload, entry.id);
	} catch (error) {
		// A handler is arbitrary application code and is expected to throw
		// sometimes. Unhandled, the rejection would kill the worker process and
		// leave every job it had claimed stuck in `running` with nothing left
		// alive to release them.
		await fail(entry.id, workerId, error);

		return;
	}

	// Outside the try, and this is the whole point. Settling is not part of the
	// work: by the time it runs the side effect has already happened, so a failure
	// here says the queue could not write down an outcome, not that the outcome
	// went wrong. `fail` is the wrong answer to that three times over — it spends
	// one of five attempts on something the handler did not do, it replaces the
	// handler's own diagnosis with a pool error, and it re-arms `run_at`, which is
	// a request to run the side effect again.
	await settle(entry.id, workerId);
}

function pause(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

/**
 * Writes down that the work finished, and says so loudly when it cannot.
 *
 * Three outcomes, and they are deliberately not the same. Settled: nothing to
 * report. Fenced out: the row moved on — either an earlier attempt at this same
 * statement committed, or something reclaimed it — so there is no work to do and
 * nothing to record, but a human still wants to know it happened. Exhausted: the
 * row stays `running`, which is the only state a worker that cannot reach the
 * database can leave it in, and plan 011's reaper is what releases it. Until
 * that exists the row is stuck, and stuck-and-logged is the better half of the
 * trade against the previous behaviour, which re-ran the side effect after
 * burning an attempt and overwriting the reason.
 */
async function settle(id: string, workerId: string): Promise<void> {
	let lastError: unknown;

	for (let attempt = 0; attempt < SETTLE_ATTEMPTS; attempt += 1) {
		try {
			// biome-ignore lint/performance/noAwaitInLoops: each attempt exists only because the previous one threw, so there is nothing to overlap it with.
			const settled = await complete(id, workerId);

			if (!settled) {
				process.stderr.write(
					`[jobs] ${id} finished, but this worker no longer owns the row — settlement left to whoever does\n`
				);
			}

			return;
		} catch (error) {
			lastError = error;
		}

		if (attempt + 1 < SETTLE_ATTEMPTS) {
			// The wait is the retry — going straight round would spend all three
			// attempts inside the same failed millisecond.
			await pause(SETTLE_RETRY_BASE_MS * 2 ** attempt);
		}
	}

	// Before the row, because the row may be unreachable — this line is the
	// record, and `markUnsettled` is a courtesy written over the same pool that
	// just refused three times.
	process.stderr.write(
		`[jobs] ${id} finished, but settlement failed ${SETTLE_ATTEMPTS} times — row left running: ${String(lastError)}\n`
	);

	try {
		await markUnsettled(id, workerId, lastError);
	} catch {
		// Swallowed on purpose and only here. The note is diagnostic; losing it
		// costs a line of context on a row whose real signal — still `running`,
		// still locked, `attempts` unmoved — is already written. Rethrowing would
		// propagate out of `runOnce` and abandon the rest of the claimed batch.
	}
}
