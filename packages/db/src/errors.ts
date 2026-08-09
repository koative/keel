import { conflict } from "@keel/http/errors";

/** SQLSTATE for `unique_violation`. */
const UNIQUE_VIOLATION = "23505";

/**
 * Drizzle wraps every driver failure in a `DrizzleQueryError` and hangs the
 * original `pg` error off `cause`, so the SQLSTATE is one level down. The chain
 * is walked rather than matched with `instanceof DatabaseError` for the same
 * reason evlog warns against `instanceof` on its own errors: `drizzle-orm`
 * resolves `pg` independently of this package, and a second physical copy turns
 * the check silently false — downgrading a "that slug is taken" to a 500.
 */
function isUniqueViolation(error: unknown): boolean {
	for (
		let current: unknown = error;
		current !== null && current !== undefined;
	) {
		if (
			typeof current === "object" &&
			"code" in current &&
			current.code === UNIQUE_VIOLATION
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
		if (isUniqueViolation(error)) {
			throw conflict(target.resource, target.field);
		}
		throw error;
	}
}
