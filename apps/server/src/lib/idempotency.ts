import { badRequest, conflict } from "@keel/http/errors";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";
import {
	deleteById,
	findByActorAndKey,
	insert,
} from "./idempotency.repository";

const HEADER = "Idempotency-Key";
const REPLAY_HEADER = "Idempotency-Replayed";

/** Room for a prefixed UUID or ULID, still small enough to index cheaply. */
const MAX_KEY_LENGTH = 255;

/**
 * How long a reply stays replayable. Long enough to cover a client's whole retry
 * budget including an operator manually re-running a failed job, short enough
 * that the table is a cache and not an audit log.
 */
const TTL_MS = 24 * 60 * 60 * 1000;

async function sha256(input: string): Promise<string> {
	const digest = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input)
	);
	return Array.from(new Uint8Array(digest), (byte) =>
		byte.toString(16).padStart(2, "0")
	).join("");
}

function replay(record: { response: { body: string }; status: number }) {
	const headers = new Headers({ [REPLAY_HEADER]: "true" });
	// Only a 2xx is ever stored, so the bodyless statuses this can meet are 204
	// and 205; `new Response` throws if either carries a body.
	const bodyless = record.status === 204 || record.status === 205;
	if (!bodyless) {
		// Every route this guards answers with the JSON envelope; the stored bytes
		// are that envelope verbatim.
		headers.set("Content-Type", "application/json");
	}

	return new Response(bodyless ? null : record.response.body, {
		headers,
		status: record.status,
	});
}

/**
 * Makes a write route safe to retry: the same `Idempotency-Key` from the same
 * actor for the same request replays the first reply instead of running the
 * handler again.
 *
 * MUST be mounted after `requireUser`: the key space is scoped to `actorId`,
 * and that guard is what puts `actorId` on the context. In front of it there is
 * no actor and every client would share one namespace.
 */
export const idempotent = createMiddleware<AppEnv>(async (c, next) => {
	const supplied = c.req.header(HEADER);
	if (supplied === undefined) {
		// The header is optional. A client that does not opt in gets the ordinary
		// at-least-once behaviour of the bare route.
		await next();
		return;
	}

	const key = supplied.trim();
	if (key.length === 0 || key.length > MAX_KEY_LENGTH) {
		throw badRequest(
			`${HEADER} must be 1 to ${MAX_KEY_LENGTH} characters, got ${key.length}`
		);
	}

	const actorId = c.get("actorId");
	// Reading the body here is safe: `c.req.text()` fills Hono's body cache and
	// `c.req.json()` reads through that same cache, so the validator and the
	// handler downstream still see the body.
	const requestHash = await sha256(await c.req.text());
	const stored = await findByActorAndKey(actorId, key);

	if (stored) {
		if (stored.expiresAt.getTime() <= Date.now()) {
			// Past its expiry the row is invisible to the client, so it must not be
			// allowed to occupy the unique slot the new request needs.
			await deleteById(stored.id);
		} else if (
			stored.method === c.req.method &&
			stored.path === c.req.path &&
			stored.requestHash === requestHash
		) {
			return replay(stored);
		} else {
			// Same key, different request. Replaying here would answer a question
			// the client never asked, and silently drop the write it did ask for.
			throw conflict("Request", HEADER);
		}
	}

	await next();

	if (c.res.status < 200 || c.res.status >= 300) {
		// A failure is never stored. A retry after a 500 has to reach the handler
		// again, and a rejected request produced nothing worth replaying.
		return;
	}

	// Cloned so the caller still receives an unread body.
	const body = await c.res.clone().text();

	// A duplicate here means a second request with this key was in flight and won
	// the race. `withUniqueConflict` turns that into a 409 rather than a replay,
	// which is the honest answer: this request's handler has already run, so its
	// side effect happened, and handing back the winner's body would hide the
	// double execution behind a 200. The 409 tells the client the key is spent
	// and a retry will get the stored reply.
	await insert({
		actorId,
		expiresAt: new Date(Date.now() + TTL_MS),
		key,
		method: c.req.method,
		path: c.req.path,
		requestHash,
		response: { body },
		status: c.res.status,
	});
});
