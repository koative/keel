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

export async function findByActorAndKey(actorId: string, key: string) {
	const [found] = await db
		.select()
		.from(idempotencyKey)
		.where(
			and(eq(idempotencyKey.actorId, actorId), eq(idempotencyKey.key, key))
		)
		.limit(1);
	return found;
}

export async function deleteById(id: string) {
	await db.delete(idempotencyKey).where(eq(idempotencyKey.id, id));
}

/**
 * Wrapped in `withUniqueConflict` so a race on `(actorId, key)` surfaces as a
 * 409 instead of a driver error: the unique index is the only thing that can
 * arbitrate two requests that both read an empty table.
 */
export async function insert(record: {
	actorId: string;
	expiresAt: Date;
	key: string;
	method: string;
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
