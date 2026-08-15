import { env } from "@keel/env/server";
import {
	badRequest,
	serviceUnavailable,
	unauthorized,
} from "@keel/http/errors";
import { ok } from "@keel/http/response";
import type { Context } from "hono";
import type { AppEnv } from "@/lib/context";
import { enqueue } from "@/lib/jobs";
import { NO_TIMESTAMP, verifySignature } from "@/lib/webhook";
import { deleteEvent, insertEvent } from "../webhooks.repository";
import type { WebhookHeaders, WebhookProvider } from "./webhooks.schema";

/** The signature header every grammar on this route shares. */
const SIGNATURE_HEADER = "x-webhook-signature";

/** The timestamp header of the `generic` grammar, documented below. */
const TIMESTAMP_HEADER = "x-webhook-timestamp";

/**
 * The two reference wire formats this receiver knows. They live here — in the
 * receiver — because `webhook.ts` is deliberately provider-agnostic and must
 * stay that way; the primitive only knows bytes.
 *
 * `generic` — the timestamped grammar:
 *
 *   - `x-webhook-signature`: hex HMAC-SHA256 over `<unixSeconds>.<body>`,
 *     optionally prefixed `sha256=`. Stripe's prefix spelling, transported the
 *     way Slack and Svix transport a timestamp: in its own header.
 *   - `x-webhook-timestamp`: the delivery instant as Unix seconds, decimal.
 *   - The digest covers the timestamp, which is the whole point: the receiver
 *     derives the prefix from the same header value the digest authenticates,
 *     so a captured delivery cannot be relabelled with a fresh instant.
 *
 * `bare` — the no-timestamp grammar (the shape GitHub uses, genericised):
 *
 *   - `x-webhook-signature`: hex HMAC-SHA256 over the body alone, no prefix.
 *   - No window exists — `signedAt` is `NO_TIMESTAMP` and freshness is the
 *     provider's retry cadence — so exactly-once is entirely the unique index's
 *     job, which is why the receiver enqueues only for the delivery that
 *     created the row.
 */
function parseDelivery(
	provider: WebhookProvider,
	timestamp: string | undefined
): { signedAt: Date | typeof NO_TIMESTAMP; signedPrefix: string } | null {
	if (provider === "bare") {
		return { signedAt: NO_TIMESTAMP, signedPrefix: "" };
	}

	// A timestamped provider that omitted the timestamp sent a delivery the
	// receiver cannot place in any window, so there is nothing to verify.
	if (timestamp === undefined) {
		return null;
	}

	const seconds = Number(timestamp);
	return {
		signedAt: new Date(seconds * 1000),
		// The header's own spelling, verbatim — `webhook.ts`'s contract is that
		// the prefix is the bytes the provider hashed, and a leading zero the
		// provider signed must survive the round trip.
		signedPrefix: `${timestamp}.`,
	};
}

/** The event id a provider grammar names in the payload. */
function parseEventId(rawBody: string): string | null {
	try {
		const body = JSON.parse(rawBody) as { id?: unknown };
		return typeof body.id === "string" && body.id.length > 0 ? body.id : null;
	} catch {
		return null;
	}
}

/**
 * The shared key the receiver verifies against, resolved per delivery.
 *
 * Optional in `@keel/env` for the same reason the storage keys are: receiving
 * webhooks is opt-in, and demanding a secret to boot would tax every deployment
 * that never mounts a provider integration. The refusal is a 503 naming the
 * key — the storage module's `storageOf` shape — because a deployment that
 * forgot the secret has a configuration gap, not a bad delivery: the provider
 * is right to retry once the key ships.
 */
function secretOf(): string {
	if (!env.WEBHOOK_SECRET) {
		throw serviceUnavailable(
			"WEBHOOK_SECRET is required to receive webhooks. Set it to the shared key the provider signs with, or stop mounting /api/webhooks."
		);
	}
	return env.WEBHOOK_SECRET;
}

type ReceiveContext = Context<
	AppEnv,
	string,
	{
		in: { header: WebhookHeaders; param: { provider: WebhookProvider } };
		out: { header: WebhookHeaders; param: { provider: WebhookProvider } };
	}
>;

/**
 * Receives one delivery. The order is fixed and is the contract:
 *
 *   1. Verify the signature over the raw request bytes, window included.
 *      Nothing else happens first — an unsigned request must not reach a
 *      parser, and a delivery that verified last week must not reach the
 *      database twice. A failure here is a permanent 4xx, never a 5xx: a 5xx
 *      makes the provider retry a delivery that failed for good, and converts
 *      the provider's ordinary retries into an error storm in our alerting.
 *   2. Read the event id — after verification only, because an id parsed from
 *      an unverified body is an attacker-chosen primary key.
 *   3. Persist the raw payload under the unique (provider, event_id) index.
 *      A duplicate insert means the event is already handled: return 200 with
 *      no new job, and without re-enqueueing — the unique index is the replay
 *      guard, `dedupeKey` only collapses retries still in flight.
 *   4. Enqueue, referencing the persisted row by its natural key. The raw
 *      body deliberately does not travel in the job payload: jsonb would
 *      normalise it, and the table row is the record.
 *   5. Return 200 — the event is durable, which is what the provider's retry
 *      clock is allowed to stop.
 *
 * A failure between persist and enqueue (step 3 done, step 4 not) is the one
 * case where a 200 would be a lie: the provider's retry inserts nothing, so the
 * `if (created)` guard would skip the enqueue and the event would stay durable
 * and unprocessed for good. The row is therefore deleted again and the failure
 * propagates, which puts the event back to never-received — the one state the
 * provider's own retry repairs.
 */
export async function receive(c: ReceiveContext) {
	const rawBody = await c.req.arrayBuffer();

	const { provider } = c.req.valid("param");
	const headers = c.req.valid("header");

	const delivery = parseDelivery(provider, headers[TIMESTAMP_HEADER]);
	if (delivery === null) {
		throw badRequest(
			`${TIMESTAMP_HEADER} is required for provider "${provider}"`
		);
	}

	const verified = verifySignature({
		header: c.req.header(SIGNATURE_HEADER),
		rawBody,
		secret: secretOf(),
		signedAt: delivery.signedAt,
		signedPrefix: delivery.signedPrefix,
	});
	if (!verified) {
		throw unauthorized();
	}

	const rawText = new TextDecoder().decode(rawBody);
	const eventId = parseEventId(rawText);
	if (eventId === null) {
		throw badRequest("The verified payload carries no string `id` field");
	}

	const receivedAt = new Date();
	const created = await insertEvent({
		eventId,
		provider,
		rawBody: rawText,
		receivedAt,
	});

	if (created) {
		try {
			await enqueue({
				dedupeKey: `webhook:${provider}:${eventId}`,
				kind: "webhook.process",
				payload: { eventId, provider },
			});
		} catch (error) {
			// The compensation has to run before the response, because a durable row
			// with no job is the one failure a provider retry cannot repair. A delete
			// that fails too leaves the request the 500 it already was.
			await deleteEvent(provider, eventId);
			throw error;
		}
	}

	return ok(c, { eventId });
}
