/**
 * The opaque page token for keyset pagination.
 *
 * Opaque on purpose. A client that can read `createdAt` out of the token will
 * eventually construct one, and then the sort key is frozen: changing it would
 * break every caller. Base64url of a private string says "echo this back" and
 * nothing else, so the encoding stays ours to change.
 *
 * This is a wire concern, which is why it lives in `lib/` and not in the
 * service. The service takes a decoded `{ createdAt, id }`; only the HTTP
 * boundary knows there is a string involved at all.
 */
export interface Cursor {
	createdAt: Date;
	id: string;
}

// A UUID contains no "|", so the first separator is the only separator and the
// id needs no escaping.
const SEPARATOR = "|";

export function encodeCursor(cursor: Cursor): string {
	return Buffer.from(
		`${cursor.createdAt.toISOString()}${SEPARATOR}${cursor.id}`
	).toString("base64url");
}

/**
 * Returns `null` for anything that is not a token we issued, and never throws.
 *
 * A tampered, truncated or hand-written cursor is a client mistake, so it has to
 * surface as a 422 from the request validator. Throwing here would reach
 * `app.onError` carrying no status and degrade to a 500 — the server reporting
 * its own fault for the client's typo.
 */
export function decodeCursor(raw: string): Cursor | null {
	// `Buffer.from(..., "base64url")` never throws: it drops characters outside
	// the alphabet, so garbage decodes to garbage rather than failing here. The
	// content checks below are what actually reject it.
	const decoded = Buffer.from(raw, "base64url").toString("utf8");
	const separator = decoded.indexOf(SEPARATOR);
	if (separator < 0) {
		return null;
	}

	const iso = decoded.slice(0, separator);
	const id = decoded.slice(separator + 1);
	if (id.length === 0) {
		return null;
	}

	const createdAt = new Date(iso);
	if (Number.isNaN(createdAt.getTime())) {
		return null;
	}

	// `new Date` accepts far more than ISO-8601 — "2026-1-1", "Jan 1 2026" — and
	// each of those would seek from a different instant than the one we handed
	// out. Requiring the exact round-trip accepts only our own output.
	return createdAt.toISOString() === iso ? { createdAt, id } : null;
}
