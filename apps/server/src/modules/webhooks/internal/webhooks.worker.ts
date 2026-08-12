import { z } from "zod";
import { markProcessed } from "../webhooks.repository";

const webhookProcessPayload = z.object({
	eventId: z.string().min(1),
	provider: z.string().min(1),
	// Carried for observability only; the row's `received_at` is authoritative.
	receivedAt: z.string(),
});

/**
 * Runs one persisted delivery: marks the row processed and nothing more.
 *
 * This is the minimal honest version a reference implementation owes. The
 * receiver already verified the signature and persisted the exact bytes, so the
 * worker never re-verifies and never re-parses the body — a real provider
 * integration reads the raw body from the row it looks up by (provider,
 * eventId), the same key the durable index holds.
 *
 * The queue may run this twice: a crash between `claim` and settlement hands
 * the job back, and the second run must not execute the work twice.
 * `processed_at` is the durable marker — the second run's UPDATE matches no
 * row (it is no longer null) and does nothing, then the job settles. The job
 * row's own status would not be enough, because the crash that redelivers this
 * job is exactly the one that leaves it `pending` again with the work done.
 */
export async function webhookProcess(payload: unknown): Promise<void> {
	const { eventId, provider } = webhookProcessPayload.parse(payload);
	await markProcessed(provider, eventId);
}
