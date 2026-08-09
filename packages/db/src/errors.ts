import { conflict } from "@keel/http/errors";

/** SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/** SQLSTATE for `undefined_table`. */
export const UNDEFINED_TABLE = "42P01";

/**
 * Reports whether `error`, or anything it wraps, carries this SQLSTATE.
 *
 * Drizzle wraps every driver failure in a `DrizzleQueryError` and hangs the
 * original `pg` error off `cause`, so the SQLSTATE is one level down. The chain
 * is walked rather than matched with `instanceof DatabaseError` for the same
 * reason evlog warns against `instanceof` on its own errors: `drizzle-orm`
 * resolves `pg` independently of this package, and a second physical copy turns
 * the check silently false — downgrading a "that slug is taken" to a 500.
 *
 * Only the code is read. A node-postgres error also carries the host, port, user,
 * password and database it could not reach, so callers that turn a failure into a
 * message must never reach for anything else on it.
 */
export function hasSqlState(error: unknown, sqlstate: string): boolean {
	for (
		let current: unknown = error;
		current !== null && current !== undefined;
	) {
		if (
			typeof current === "object" &&
			"code" in current &&
			current.code === sqlstate
		) {
			return true;
		}
		current = current instanceof Error ? current.cause : undefined;
	}

	return false;
}

/**
 * Runs a write and translates a unique constraint violation into a Conflict.
 *
 * Left alone the driver error escapes the repository, `parseError` finds no
 * status on it, and an ordinary "that slug is taken" becomes a 500 with a driver
 * message in the log.
 *
 * Deliberately a wrapper rather than a bare predicate: a hand-written try/catch
 * around a write is one missing `throw error` away from swallowing every other
 * database failure, and that mistake is invisible in review.
 */
export async function withUniqueConflict<T>(
	target: { resource: string; field: string },
	write: () => Promise<T>
): Promise<T> {
	try {
		return await write();
	} catch (error) {
		if (hasSqlState(error, UNIQUE_VIOLATION)) {
			throw conflict(target.resource, target.field);
		}
		throw error;
	}
}
