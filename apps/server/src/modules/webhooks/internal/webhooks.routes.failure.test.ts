import { afterEach, describe, expect, it, mock, spyOn } from "bun:test";
import { createHmac } from "node:crypto";
import { db } from "@keel/db";
import { job } from "@keel/db/schema/job";
import { webhookEvent } from "@keel/db/schema/webhook-event";
import { and, eq } from "drizzle-orm";
// biome-ignore lint/performance/noNamespaceImport: `spyOn` patches a property on the object it is given, and the queue's public face is a module namespace.
import * as jobQueue from "@/lib/jobs";
import { SECRET } from "@/lib/webhook.fixtures";
import { skipNotice, testDbReady } from "../../../../test-db";
import { createClient } from "../../../../test-http";

const ready = await testDbReady();
if (!ready) {
	process.stdout.write(skipNotice("webhooks receiver failures"));
}

const api = createClient();

/**
 * The delivery the receiver must not record.
 *
 * `webhooks.routes.test.ts` covers the ones that verify and land. This is the
 * case where a 200 would be a lie: an event that persisted but could not be
 * queued. Driven through `app.request()` like the main suite, because it is the
 * receiver's ordering — verify, persist, enqueue — that is under test.
 */

const eventId = () => `evt_${crypto.randomUUID().slice(0, 8)}`;
const post = (provider: string, signature: string, body: string) =>
	api.request(`/api/webhooks/${provider}`, {
		body,
		headers: {
			"content-type": "application/json",
			"x-webhook-signature": signature,
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

// The spy below lives for one request. Restoring it here — not at the end of the
// test — also covers a failing assertion, and other suites share this process.
afterEach(() => {
	mock.restore();
});

describe.skipIf(!ready)("webhook receiver failures", () => {
	it("persists nothing when the enqueue after the insert fails", async () => {
		const id = eventId();
		const body = JSON.stringify({ id, type: "thing.created" });
		const signature = createHmac("sha256", SECRET)
			.update(body, "utf8")
			.digest("hex");

		// Pool exhaustion, a failover and a statement timeout all reach the enqueue
		// after the row has committed, and none of them can be staged against a
		// Postgres every other suite shares: a lock or a revoked privilege on `job`
		// would take those suites with it. So the seam the handler calls is the one
		// that fails, and nothing else about the request changes.
		spyOn(jobQueue, "enqueue").mockImplementation(() => {
			throw new Error("pool exhausted");
		});

		const response = await post("bare", signature, body);

		// A 500 is honest: nothing is durable, so the provider has to retry. What
		// must not survive is the row — a persisted event whose retry finds
		// `created` false and skips the enqueue is one nothing will ever process.
		expect(response.status).toBe(500);
		expect(await events("bare", id)).toHaveLength(0);
		expect(await jobs(`webhook:bare:${id}`)).toHaveLength(0);
	});
});
