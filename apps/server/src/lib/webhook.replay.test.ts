import { describe, expect, it } from "bun:test";
import { NO_TIMESTAMP, verifySignature } from "./webhook";
import { delivery, signedPrefix } from "./webhook.fixtures";

/**
 * How old a delivery may be. `webhook.test.ts` covers what the digest is
 * computed over; this suite covers the second question the function answers,
 * which is whether it was asked recently.
 *
 * The offsets are literals rather than an imported constant on purpose. A suite
 * that imports the tolerance asserts that the code equals itself; five and six
 * minutes written out assert the window a provider and an operator actually
 * live with, and moving the constant has to break something here.
 */

const MINUTE = 60 * 1000;
const ago = (ms: number) => new Date(Date.now() - ms);
const ahead = (ms: number) => new Date(Date.now() + ms);

describe("verifySignature replay window", () => {
	it("verifies a delivery stamped now", () => {
		expect(verifySignature(delivery())).toBe(true);
	});

	// The finding, expressed. Before the window existed this returned true, and
	// would have gone on returning true for as long as the secret lived.
	it("refuses a delivery stamped before the window", () => {
		expect(verifySignature(delivery({ at: ago(6 * MINUTE) }))).toBe(false);
	});

	/**
	 * Skew runs both ways. A far-future stamp is either a clock that is wrong —
	 * in which case honouring it silently extends every window that follows it —
	 * or a capture held back to be replayed once the honest window has closed.
	 * Neither deserves a `true`, and a one-sided check is the easy mistake: the
	 * obvious spelling, `now - signedAt <= tolerance`, admits every future
	 * timestamp there will ever be.
	 */
	it("refuses a delivery stamped after the window", () => {
		expect(verifySignature(delivery({ at: ahead(6 * MINUTE) }))).toBe(false);
	});

	/**
	 * The case that decides whether the window is worth anything. Both instants
	 * are inside the tolerance, so freshness cannot be what refuses this — the
	 * digest is. That is only true because the prefix is hashed: if the timestamp
	 * were advisory, an attacker would replay a stale capture forever simply by
	 * relabelling it, and every other test in this file would still pass.
	 */
	it("refuses a fresh timestamp the signature does not cover", () => {
		const sent = delivery({ at: ago(MINUTE) });
		const now = new Date();

		expect(
			verifySignature({
				...sent,
				signedAt: now,
				signedPrefix: signedPrefix(now),
			})
		).toBe(false);
	});

	/**
	 * `Math.abs(NaN - now) <= tolerance` is false, so an instant the route could
	 * not parse is refused by the arithmetic with no branch written for it. The
	 * delivery is signed over the prefix it presents, so the digest matches and
	 * the window is provably what returned false.
	 */
	it("refuses a timestamp that parsed to nothing", () => {
		expect(verifySignature(delivery({ at: new Date("not a date") }))).toBe(
			false
		);
	});

	/**
	 * The edge, pinning the constant to five minutes from both sides.
	 *
	 * Offsets of 4m59s and 5m1s rather than exactly 5m: for a past stamp the gap
	 * grows by however long the test itself takes, so an exact-tolerance case
	 * would sit one microsecond from flaky. One second of slack in each direction
	 * is far smaller than the minute a wrong constant would move.
	 */
	it("verifies at the edge of the window and refuses just past it", () => {
		expect(
			verifySignature(delivery({ at: ago(5 * MINUTE - 1000) }))
		).toBe(true);
		expect(
			verifySignature(delivery({ at: ago(5 * MINUTE + 1000) }))
		).toBe(false);
		expect(
			verifySignature(delivery({ at: ahead(5 * MINUTE + 1000) }))
		).toBe(false);
	});

	/**
	 * GitHub signs the body and sends no timestamp anywhere, so a receiver for it
	 * has no freshness signal to check and must say so in a word that shows up in
	 * a grep and a review. The alternative — an optional field — would let a
	 * receiver that simply forgot look identical to one that decided.
	 *
	 * What such a receiver owes instead is in `verifySignature`'s doc comment: a
	 * unique index on the provider's event id, which is the only replay guard
	 * available when there is no clock to consult.
	 */
	it("verifies at any age when the provider transports no timestamp", () => {
		const sent = delivery({ at: ago(30 * 24 * 60 * MINUTE) });

		expect(verifySignature({ ...sent, signedAt: NO_TIMESTAMP })).toBe(true);
	});
});
