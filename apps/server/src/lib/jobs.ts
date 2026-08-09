import { env } from "@keel/env/server";
import { type ClaimedJob, claim, complete, fail } from "./jobs.repository";

/**
 * The queue's execution half: what a job kind means, and what one pass of a
 * worker does. Everything that touches the table lives in `jobs.repository`.
 */

/**
 * The payload is `unknown` on purpose. It comes back from jsonb and crossed a
 * process boundary, so it has no more claim to a type than a request body does;
 * a handler parses it — with a contract schema — exactly as a route does.
 */
export type JobHandler = (payload: unknown) => Promise<void>;

export type JobRegistry = Map<string, JobHandler>;

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
		await runJob(registry, entry);
	}

	return claimed.length;
}

async function runJob(registry: JobRegistry, entry: ClaimedJob): Promise<void> {
	const handler = registry.get(entry.kind);

	// An unregistered kind is a deployment mistake — usually an old worker
	// meeting a job a newer release enqueued — not a queue error. Recording it
	// on the row keeps it visible and retryable once the worker catches up,
	// whereas throwing here would strand every job behind it in this batch.
	if (handler === undefined) {
		await fail(entry.id, `no handler registered for job kind "${entry.kind}"`);
		return;
	}

	try {
		await handler(entry.payload);
		await complete(entry.id);
	} catch (error) {
		// A handler is arbitrary application code and is expected to throw
		// sometimes. Unhandled, the rejection would kill the worker process and
		// leave every job it had claimed stuck in `running` with nothing left
		// alive to release them.
		await fail(entry.id, error);
	}
}
