import { db } from "@keel/db";
import { withUniqueConflict } from "@keel/db/errors";
import { idempotencyKey } from "@keel/db/schema/idempotency";
import { and, eq, lt } from "drizzle-orm";

/**
 * The only file behind the idempotency middleware allowed to touch Drizzle,
 * mirroring the per-module repositories. It lives under lib/ rather than in a
 * module because the middleware is cross-cutting: every public write route
 * mounts the same instance.
 */

export async function findByActorOrgAndKey(
	actorId: string,
	organizationId: string,
	key: string
) {
	const [found] = await db
		.select()
		.from(idempotencyKey)
		.where(
			and(
				eq(idempotencyKey.actorId, actorId),
				eq(idempotencyKey.organizationId, organizationId),
				eq(idempotencyKey.key, key)
			)
		)
		.limit(1);
	return found;
}

export async function deleteById(id: string) {
	await db.delete(idempotencyKey).where(eq(idempotencyKey.id, id));
}

/**
 * Stores the reply a request produced, for a client that retries the same key.
 *
 * Only reached when a lookup already found nothing (or an expired row the
 * caller deleted), so a violation of `(actorId, organizationId, key)` is a
 * genuine race — the old post-handler window — and still surfaces as a 409.
 * The middleware itself no longer inserts after the handler; tests seed rows
 * through this path.
 */
export async function insert(record: {
	actorId: string;
	expiresAt: Date;
	key: string;
	method: string;
	organizationId: string;
	path: string;
	requestHash: string;
	response: { body: string };
	status: number;
}) {
	await withUniqueConflict(
		{ field: "Idempotency-Key", resource: "Request" },
		() => db.insert(idempotencyKey).values(record)
	);
}

/**
 * Reserves a key before the middleware runs the handler, making the unique
 * index the arbiter of the race: exactly one caller gets a row back, and a
 * concurrent request that read an empty table gets `undefined` and must 409
 * without ever reaching the handler.
 *
 * The reply columns are NOT NULL and do not exist until the handler answers,
 * so the row is written with a placeholder — `status 0`, which no real reply
 * can carry — and `storeResponse` fills it in on success. The failure path
 * deletes the row instead, so a placeholder escapes only when the process dies
 * mid-handler, in which case the key stays claimed until the TTL sweep: a 409
 * for retries, never a wrong replay.
 */
export async function claim(record: {
	actorId: string;
	expiresAt: Date;
	key: string;
	method: string;
	organizationId: string;
	path: string;
	requestHash: string;
}) {
	const [row] = await db
		.insert(idempotencyKey)
		.values({
			...record,
			response: { body: "" },
			status: 0,
		})
		.onConflictDoNothing({
			target: [
				idempotencyKey.actorId,
				idempotencyKey.organizationId,
				idempotencyKey.key,
			],
		})
		.returning();
	return row;
}

/**
 * Fills in the reply the claim row was holding the key slot for.
 */
export async function storeResponse(
	id: string,
	response: { body: string },
	status: number
) {
	await db
		.update(idempotencyKey)
		.set({ response, status })
		.where(eq(idempotencyKey.id, id));
}

/**
 * Drops every reply past its expiry and reports how many went.
 *
 * Deliberately not scheduled anywhere in this app: a starter that spawns its own
 * timer runs one sweep per process, so a three-replica deployment sweeps three
 * times and a serverless one never does. Call this from whatever the deployment
 * already uses for cron.
 */
export async function sweepExpiredKeys(
	now: Date = new Date()
): Promise<number> {
	const removed = await db
		.delete(idempotencyKey)
		.where(lt(idempotencyKey.expiresAt, now))
		.returning({ id: idempotencyKey.id });
	return removed.length;
}
