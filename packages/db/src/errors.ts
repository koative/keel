import { conflict } from "@keel/http/errors";
import { DatabaseError } from "pg";

/** SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/**
 * Runs a write and translates a unique constraint violation into a Conflict.
 *
 * Postgres reports these as SQLSTATE 23505. Left alone the driver error escapes
 * the repository, `parseError` finds no status on it, and a perfectly ordinary
 * "that slug is taken" becomes a 500 with a driver message in the log.
 *
 * Deliberately a wrapper rather than a bare predicate: a hand-written try/catch
 * around a write is one `throw error` away from swallowing every other database
 * failure, and that mistake is invisible in review.
 */
export async function withUniqueConflict<T>(
	target: { resource: string; field: string },
	write: () => Promise<T>
): Promise<T> {
	try {
		return await write();
	} catch (error) {
		if (error instanceof DatabaseError && error.code === UNIQUE_VIOLATION) {
			throw conflict(target.resource, target.field);
		}
		throw error;
	}
}
