import { describe, expect, it } from "bun:test";
import { createHmac } from "node:crypto";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { webhookEvent } from "@keel/db/schema/webhook-event";
import { and, eq } from "drizzle-orm";
import { DELIVERED, delivery, SECRET } from "@/lib/webhook.fixtures";
import { webhookProcess } from "@/modules/webhooks";
import { skipNotice, testDbReady } from "../../../../test-db";
import { createClient } from "../../../../test-http";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("webhooks internal routes"));
}

const api = createClient();

/**
 * End to end through the real stack — CORS, wide event, validator, handler,
 * repository, Postgres — driven by `app.request()` with no socket and no
 * session: the signature is the authentication, which is the point of the
 * route. Deliveries are built with `webhook.fixtures.ts`'s `delivery()`, which
 * computes the digest over the exact bytes and prefix the receiver must
 * reconstruct from the request alone.
 */

const MINUTE = 60 * 1000;

const eventId = () => `evt_${crypto.randomUUID().slice(0, 8)}`;
const payload = (id: string) =>
	JSON.stringify({ amount: 1.0, id, type: "thing.created" });
const unixSeconds = (at: Date) => String(Math.floor(at.getTime() / 1000));
const post = (
	provider: string,
	signature: string,
	body: string,
	timestamp?: string
) =>
	api.request(`/api/webhooks/${provider}`, {
		body,
		headers: {
			"content-type": "application/json",
			"x-webhook-signature": signature,
			...(timestamp !== undefined && { "x-webhook-timestamp": timestamp }),
		},
		method: "POST",
	});

const events = (provider: string, id: string) =>
	db
		.select()
		.from(webhookEvent)
		.where(
			and(eq(webhookEvent.provider, provider), eq(webhookEvent.eventId, id))
		);

const jobs = (dedupeKey: string) =>
	db.select().from(job).where(eq(job.dedupeKey, dedupeKey));
async function singleEvent(provider: string, id: string) {
	const [row] = await events(provider, id);
	if (row === undefined) {
		throw new Error("expected the delivery to be persisted");
	}
	return row;
}

async function singleJob(dedupeKey: string) {
	const [row] = await jobs(dedupeKey);
	if (row === undefined) {
		throw new Error("expected the delivery to be queued");
	}
	return row;
}
describe.skipIf(!ready)("webhook receiver", () => {
	it("rejects an unverified delivery as 401 before anything is persisted", async () => {
		const id = eventId();
		const body = payload(id);

		// A digest-shaped value signed with the wrong key.
		const forged = createHmac("sha256", "the-wrong-secret")
			.update(DELIVERED, "utf8")
			.digest("hex");
		expect(
			(await post("generic", forged, body, unixSeconds(new Date()))).status
		).toBe(401);

		// A header that is not even digest-shaped.
		expect(
			(await post("generic", "not-a-digest", body, unixSeconds(new Date())))
				.status
		).toBe(401);

		expect(await events("generic", id)).toHaveLength(0);
		expect(await jobs(`webhook:generic:${id}`)).toHaveLength(0);
	});

	it("verifies a fresh delivery: one row, one pending job, exact bytes", async () => {
		const id = eventId();
		const body = payload(id);
		const at = new Date();
		const d = delivery({ at, payload: body });

		const response = await post("generic", d.header, body, unixSeconds(at));
		expect(response.status).toBe(200);
		const envelope = await api.body<{ data: { eventId: string } }>(response);
		expect(envelope.data.eventId).toBe(id);

		expect(await events("generic", id)).toHaveLength(1);
		const row = await singleEvent("generic", id);
		expect(row.rawBody).toBe(body);
		expect(row.processedAt).toBeNull();

		expect(await jobs(`webhook:generic:${id}`)).toHaveLength(1);
		const queued = await singleJob(`webhook:generic:${id}`);
		expect(queued.kind).toBe("webhook.process");
		expect(queued.status).toBe("pending");
	});

	it("replays the same event idempotently: still one row and one job", async () => {
		const id = eventId();
		const body = payload(id);
		const at = new Date();
		const d = delivery({ at, payload: body });

		expect(
			(await post("generic", d.header, body, unixSeconds(at))).status
		).toBe(200);
		expect(
			(await post("generic", d.header, body, unixSeconds(at))).status
		).toBe(200);

		// The unique index holds the row; the namespaced dedupeKey collapses
		// the still-pending second enqueue. Both halves of the contract.
		expect(await events("generic", id)).toHaveLength(1);
		expect(await jobs(`webhook:generic:${id}`)).toHaveLength(1);
	});

	it("refuses a delivery stamped outside the five-minute window as 401", async () => {
		const id = eventId();
		const body = payload(id);
		const at = new Date(Date.now() - 6 * MINUTE);
		const d = delivery({ at, payload: body });

		expect(
			(await post("generic", d.header, body, unixSeconds(at))).status
		).toBe(401);
		expect(await events("generic", id)).toHaveLength(0);
	});

	it("refuses a timestamped provider that omitted its timestamp as 400", async () => {
		const id = eventId();
		const body = payload(id);
		const d = delivery({ payload: body });

		expect((await post("generic", d.header, body)).status).toBe(400);
		expect(await events("generic", id)).toHaveLength(0);
	});

	it("verifies a no-timestamp provider, and the unique index survives a settled job", async () => {
		const id = eventId();
		const body = payload(id);
		const signature = createHmac("sha256", SECRET)
			.update(body, "utf8")
			.digest("hex");
		const key = `webhook:bare:${id}`;

		expect((await post("bare", signature, body)).status).toBe(200);
		expect(await events("bare", id)).toHaveLength(1);
		expect(await jobs(key)).toHaveLength(1);

		// The dedupeKey guard is gone the moment the job settles — delete the
		// row to prove what is left. The unique index must still refuse a
		// second row, and the receiver must not re-enqueue for the duplicate.
		await db.delete(job).where(eq(job.dedupeKey, key));

		expect((await post("bare", signature, body)).status).toBe(200);
		expect(await events("bare", id)).toHaveLength(1);
		expect(await jobs(key)).toHaveLength(0);
	});

	it("marks a persisted event processed exactly once, even if the job runs twice", async () => {
		const id = eventId();
		const body = payload(id);
		const at = new Date();
		const d = delivery({ at, payload: body });

		await post("generic", d.header, body, unixSeconds(at));
		await webhookProcess({ eventId: id, provider: "generic" });

		const once = await singleEvent("generic", id);
		expect(once.processedAt).not.toBeNull();

		// The queue's contract: a redelivered job runs again and does nothing.
		await webhookProcess({ eventId: id, provider: "generic" });
		const twice = await singleEvent("generic", id);
		expect(twice.processedAt).toEqual(once.processedAt);
	});
});
