import { badRequest, conflict } from "@keel/http/errors";
import { createMiddleware } from "hono/factory";
import type { AppEnv } from "./context";
import {
	claim,
	deleteById,
	findByActorOrgAndKey,
	storeResponse,
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
 * actor in the same organization for the same request replays the first reply
 * instead of running the handler again.
 *
 * MUST be mounted after `requireUser` and `requireOrg`: the key space is scoped
 * to `actorId` and `organizationId`, and those guards are what put both on the
 * context. It refuses to run when either is missing rather than keying on what
 * is left: in front of those guards the key space is scoped to nobody, and one
 * namespace shared by every client is a replay across tenants.
 */
export const idempotent = createMiddleware<AppEnv>(async (c, next) => {
	const actorId = c.get("actorId");
	const organizationId = c.get("organizationId");
	if (!(actorId && organizationId)) {
		/*
		 * Checked before the header, not beside the lookup: the mount is wrong for
		 * every request, so the first one should say so rather than the first one
		 * that happens to opt in.
		 *
		 * `AppEnv` types both as plain strings, so that wiring compiles and the
		 * key collapses to `(null, null, key)` — the shared namespace the scope
		 * exists to prevent. What refuses it today is two `not null` columns a
		 * layer down: `claim` fails on the insert and the caller gets `null value
		 * in column "actor_id"`, a 500 that reads as a database fault and names
		 * nothing. That is a constraint doing this middleware's job, and it stops
		 * covering the moment either column is written by something that tolerates
		 * a null. The invariant belongs where the scope is decided.
		 */
		throw new Error(
			"idempotent ran with no actorId or organizationId on the context, so it is mounted above requireUser or requireOrg. Every client would share one key namespace. Mount idempotent after both guards."
		);
	}

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

	// Reading the body here is safe: `c.req.text()` fills Hono's body cache and
	// `c.req.json()` reads through that same cache, so the validator and the
	// handler downstream still see the body.
	const requestHash = await sha256(await c.req.text());
	const stored = await findByActorOrgAndKey(actorId, organizationId, key);

	if (stored) {
		if (stored.expiresAt.getTime() <= Date.now()) {
			// Past its expiry the row is invisible to the client, so it must not be
			// allowed to occupy the unique slot the new request needs.
			await deleteById(stored.id);
		} else if (stored.status === 0) {
			// A claim still waiting on its handler: a concurrent request holds the
			// key and has not answered yet. Replaying would hand back a response
			// that does not exist, and running the handler would double the side
			// effect — so this is the same 409 a finished mismatch gets.
			throw conflict("Request", HEADER);
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

	// Claim first, handler second. The insert is the arbiter of the race: the
	// unique index admits exactly one request onto the handler, and a concurrent
	// request that read an empty table loses here — before `next()`, so its side
	// effect never happens. This closes the old check-then-act window, where
	// both requests ran the handler and the loser's post-handler insert was the
	// only thing left to surface a 409. The loser's answer is unchanged — still
	// a 409 — but the double execution is gone.
	const claimed = await claim({
		actorId,
		expiresAt: new Date(Date.now() + TTL_MS),
		key,
		method: c.req.method,
		organizationId,
		path: c.req.path,
		requestHash,
	});
	if (!claimed) {
		// Lost the claim race: the 409 must not wait for the winner to finish.
		throw conflict("Request", HEADER);
	}

	await next();

	if (c.res.status < 200 || c.res.status >= 300) {
		// A failure is never stored. A retry after a 500 has to reach the handler
		// again, and a rejected request produced nothing worth replaying.
		await deleteById(claimed.id);
		return;
	}

	// Cloned so the caller still receives an unread body.
	const body = await c.res.clone().text();
	await storeResponse(claimed.id, { body }, c.res.status);
});
