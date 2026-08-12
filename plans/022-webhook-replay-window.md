# Webhook Replay Window Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** SEC-05 (`plans/audit-report.md:75-81`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Ships before plan 025.** Plan 025 (DIR-03, `plans/audit-report.md:398-401`) adds the reference webhook receiver and calls `verifySignature`. This plan tightens that function's signature — two new **required** fields — so 025 writes its call site against the tightened contract and never against today's. Land this first. The exact final shape 025 consumes is in Task 2's **Interfaces** block.

**Goal:** Give `verifySignature` an authenticated delivery timestamp and a five-minute symmetric replay window, so a captured valid webhook request stops verifying forever, and state the exactly-once contract every future receiver inherits.

**Architecture:** The primitive is not broken; it is incomplete. `verifySignature` takes `{ header, rawBody, secret }` (`apps/server/src/lib/webhook.ts:41-46`) and answers one question — does this digest match these bytes under this key. That answer is true for the same bytes tomorrow, next month and after the secret has been rotated out of memory but not out of the attacker's capture. The fix adds a second question — was this delivery stamped recently — and the whole difficulty is that the stamp must be *covered by the signature* or moving it is free. So two fields go in together: `signedAt`, the instant the route parsed, and `signedPrefix`, the bytes the provider hashes in front of the body. Both verdicts are then computed unconditionally and combined at the end, so no branch happens on the digest before the window has also been decided.

**Tech Stack:** Bun, `node:crypto` (`createHmac`, `timingSafeEqual` via `@keel/crypto/equals`), bun:test.

---

## Verified evidence (do not re-litigate)

Each of these was checked against the working tree at `39fd32c`, not copied from the audit.

1. **The audit's evidence is accurate; its impact statement overstates the danger.** `SignatureInput` really is three fields and nothing else (`apps/server/src/lib/webhook.ts:41-46`), and `verifySignature` really does destructure exactly those three (`:75-79`). A search for `timestamp` or `tolerance` anywhere in that file returns nothing.

   What the audit's **Impact** line invites you to imagine — "a captured valid webhook request replays indefinitely" — is true of the primitive and false of the deployed system, because nothing calls the primitive. `verifySignature` is imported by exactly one file, its own test (`apps/server/src/lib/webhook.test.ts:3`). There is no route, no module and no handler behind it. **Nothing is exploitable today.** Do not go hunting for a live replay hazard; you will not find one, and you will waste an afternoon. This plan tightens a contract before anyone inherits it, which is the cheapest possible moment to do it and the only reason the change is small.

2. **The cryptographic primitive is sound. Do not "fix" it.** The digest is computed over `Buffer.from(rawBody)` — a view over the received bytes, no copy, no re-serialisation (`webhook.ts:93-97`) — and compared with `safeEquals`, which is `timingSafeEqual` behind a length guard (`packages/crypto/src/equals.ts:16-25`). The shape check rejects anything that is not 64 hex characters before a comparison is attempted (`webhook.ts:39`, `:89-91`). A malformed header returns `false` rather than throwing, deliberately (`webhook.ts:69-73`). All of that stays exactly as it is.

3. **What is missing is only the window.** There is no notion of *when* the delivery was made, so a byte-identical replay of a valid request verifies for as long as the secret lives. The receiver order the repo documents — verify, persist raw, enqueue, return 200 (`webhook.ts:4-12`, `README.md:257-261`, `AGENTS.md:46-51`) — would then persist a fresh row per replay, because none of those four steps consults an event identity.

4. **One mitigation was hunted for and is not there.** The repo's only idempotency mechanism is `apps/server/src/lib/idempotency.ts`. It is keyed on an `Idempotency-Key` header *plus* an authenticated actor: `const actorId = c.get("actorId")` at `:75`, used as half the lookup key at `:80`, and its own doc comment says "MUST be mounted after `requireUser`: the key space is scoped to `actorId`" (`:55-57`). It is mounted in exactly one place — `surface.on("POST", "*", idempotent)` at `apps/server/src/modules/projects/public/projects.v1.routes.ts:160`, behind `requireUser` (`:145`) and `requireOrg` (`:155`). A webhook endpoint is unauthenticated by definition: the provider has a shared secret, not a session, so there is no `actorId` to key on and no `Idempotency-Key` header to read. **That middleware cannot protect a webhook path.** It is not a candidate, and reaching for it is the first wrong turn available here.

5. **The queue's dedupe key is a debounce, not a replay guard.** `job.dedupe_key` is unique only `WHERE status = 'pending'` (`packages/db/src/schema/job.ts:71-73`, and the comment at `:59-70` says so in as many words: "Once that job settles — picked up, done or failed — it leaves the index, and the same key is immediately usable again"). `enqueue` swallows that one conflict on purpose (`packages/db/src/jobs.ts:52-57`). So a replay arriving after the first job finished re-enqueues cleanly. The dedupe key still has to be the provider's event id — it is what collapses a provider's own in-flight retries — but it is not, and cannot be, the durable guard. This is exactly CORR-08's observation, and it is the reason Task 3 exists.

6. **Two `createHmac(...).update(…)` calls equal one over the concatenation, and an empty prefix is a no-op.** Executed against the installed runtime before this plan was written, over `'{"type":"thing.created","id":"evt_1","amount":1.0}'`:

   ```
   hmac(body)                              === hmac("").update(body)          →  true
   hmac("1700000000.").update(body)        === hmac("1700000000." + body)     →  true
   hmac(body)                              === hmac("1700000000.").update(body) →  false
   ```

   That is what makes `signedPrefix: ""` bit-for-bit today's behaviour, and what lets the prefix be hashed without allocating a second copy of the body.

7. **`Math.abs(NaN - Date.now()) <= 300000` is `false`.** Also executed. An unparseable timestamp is therefore refused by the window arithmetic itself, with no special case to write. It is worth a test precisely because it is worth *not* writing a branch for.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, 16 architecture rules and migration drift (`package.json:"check"`).
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`, `biome.jsonc:68-72`; comment lines and the interior of a multi-line template literal do not count, blank lines do). `webhook.test.ts` is at 148 physical lines today and this plan adds tests to that subject, which is why the new suite is a second file rather than more of the same one.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts`; test doubles are `<subject>.fixtures.ts` inside `src/`. `tools/check-naming.ts` enforces both, and the stem must name a real module in the same directory (`tools/check-naming.ts:110-137`). `webhook.replay.test.ts` and `webhook.fixtures.ts` both satisfy that against `webhook.ts`.
- Tests live beside the code, never in `__tests__`. Nothing here needs a database, so nothing here gates on `testDbReady()`.
- **No environment variable gets a default.** The tolerance in this plan is a module constant, not configuration, and deliberately not an env key — see "Do not".
- `bun run lint` is `ultracite check`, which does not write. `bun run fix` is `ultracite fix`, which does. Biome owns import-specifier order and object-key order; if it rewrites either, take its version.

## Do not

- **Do not parse the timestamp out of `header`.** `webhook.ts:24-25` states the module's contract: "Deliberately provider-agnostic. Every provider spells the header differently; the route knows its own header name, this module only knows bytes." Teaching it Stripe's `t=…,v1=…` grammar makes GitHub (which sends no timestamp at all), Slack (`X-Slack-Request-Timestamp`, a separate header) and Svix (`webhook-timestamp`, another separate header) unsupportable behind a name that claims to be generic — and it puts a per-provider parser in the one file that must stay small enough to audit. The route already knows its provider's header name; it therefore knows where its provider puts the timestamp and in what unit. It hands over a parsed instant.
- **Do not make `signedAt` optional, and do not give `signedPrefix` a default of `""`.** An optional freshness input is a silent hole: the receiver that forgets it compiles, passes, and has no window — which is the bug this plan exists to prevent, reintroduced with a nicer signature. Both fields are required, so omitting one is a type error at the call site. The provider that genuinely transports no timestamp opts out by naming `NO_TIMESTAMP`, which is greppable in review.
- **Do not make the tolerance a parameter or an environment variable.** A knob is what a route widens at 02:00 to make a flaky integration green, and the widened value then lives in a route file nobody audits as a security decision. It is also, per the repo's env rule, a deployment decision the repository would be making on someone's behalf. One constant in the file the reviewer is already reading.
- **Do not write `return matches && fresh` or `return fresh && matches(...)` with either operand computed inside the `&&`.** `&&` short-circuits, so operand order silently becomes a security property that no assertion in the suite can catch. `matches && withinWindow(...)` is the actively dangerous spelling: total response time then depends on whether the digest matched, which is the coarse oracle `safeEquals` exists to deny. Compute both verdicts into `const`s first, then combine. The wasted HMAC on a stale delivery is one SHA-256 over a body that plan 005's limit already bounds.
- **Do not concatenate the prefix and the body into a new buffer.** `.update(signedPrefix, "utf8").update(Buffer.from(rawBody))` gives the identical digest (Verified evidence 6) without allocating a second copy of the payload, and the "raw bytes, never a re-serialisation" doctrine in `webhook.ts:50-58` stays literally true.
- **Do not reach for `apps/server/src/lib/idempotency.ts`.** Verified evidence 4: it is actor-keyed and mounted behind `requireUser`. It cannot see an unauthenticated request. Plan 012 owns that file in any case.
- **Do not write the receiver.** No route, no table, no job kind, no `enqueue` call. Plan 025 owns all of it; this plan hands it a contract.
- **Do not edit `AGENTS.md`.** Its webhook sentence at `:49-51` will need one clause about the window. Plan 021 owns that file's length and is the only plan permitted to change it; Task 3 records the exact clause for 021 to carry. `README.md:257-261` is a prose paragraph rather than a count, so Task 3 does update it — and touches nothing else in that file.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/webhook.ts` | **Modify.** The primitive: the signed payload gains a prefix (Task 1), the delivery gains a window (Task 2), the doc gains the receiver's exactly-once contract (Task 3). |
| `apps/server/src/lib/webhook.fixtures.ts` | **Create.** A faked provider. Builds a whole delivery whose digest is consistent by construction, so no suite ever hard-codes one. |
| `apps/server/src/lib/webhook.test.ts` | **Modify.** Keeps its subject — what the digest is computed over — and moves onto the fixture. |
| `apps/server/src/lib/webhook.replay.test.ts` | **Create.** The second suite over the same subject: how old a delivery may be. |
| `README.md:257-261` | **Modify.** The documented receiver order gains the freshness step and the event-id rule. |

---

### Task 1: The signed payload is not always the body

**Files:**
- Create: `apps/server/src/lib/webhook.fixtures.ts`
- Modify: `apps/server/src/lib/webhook.ts:41-46`, `:75-79`, `:95-97`
- Test: `apps/server/src/lib/webhook.test.ts` (rewritten onto the fixture, three cases added)

**Interfaces:**
- Consumes: `safeEquals(a: string, b: string): boolean` from `@keel/crypto/equals`. Nothing else new.
- Produces:
  - `SignatureInput` gains `signedPrefix: string` (required).
  - `webhook.fixtures.ts` exports `SECRET: string`, `DELIVERED: string`, `bytes(payload: string): ArrayBuffer`, `signedPrefix(at: Date): string`, `DeliveryOptions`, and `delivery(options?: DeliveryOptions): SignatureInput`. Task 2 extends `delivery` and both suites depend on it.

- [x] **Step 1: Write the fixture**

The suites need a delivery whose digest matches the bytes *and* the prefix it claims. Computing that at each call site is how a suite ends up asserting against a digest literal nobody can re-derive, and once there are two suites it is also duplication. Create `apps/server/src/lib/webhook.fixtures.ts`:

```ts
import { createHmac } from "node:crypto";
import type { SignatureInput } from "./webhook";

/**
 * A provider, faked.
 *
 * Shared because there are two suites over `webhook.ts`: `webhook.test.ts`
 * covers what the digest is computed over, `webhook.replay.test.ts` covers how
 * old a delivery may be. Both need a delivery that is internally consistent —
 * digest, bytes and prefix agreeing — so that a test which moves exactly one
 * field knows the verdict came from that field and nothing else.
 *
 * Nothing here hard-codes a digest. A committed digest literal cannot be
 * re-derived by the next reader, and a test that asserts against one is pinning
 * the output of whatever code produced it rather than the rule it claims to
 * cover.
 */

/** The key the receiver holds. */
export const SECRET = "a-shared-webhook-secret";

/** The bytes as delivered — note the keys are not in alphabetical order. */
export const DELIVERED = '{"type":"thing.created","id":"evt_1","amount":1.0}';

/**
 * Built by hand rather than via `.buffer`, so the value under test is an
 * `ArrayBuffer` of exactly the payload's bytes with no view offset in play.
 */
export function bytes(payload: string): ArrayBuffer {
	const encoded = new TextEncoder().encode(payload);
	const buffer = new ArrayBuffer(encoded.byteLength);
	new Uint8Array(buffer).set(encoded);
	return buffer;
}

/**
 * A Stripe-shaped provider's prefix: the delivery instant in Unix seconds and a
 * separator, hashed in front of the body because the provider transports the
 * timestamp beside the payload rather than inside it.
 *
 * The spelling belongs to the provider, which is the whole point of the prefix
 * being a caller-supplied string: this fixture stands in for one provider's
 * grammar, and `webhook.ts` never learns it.
 */
export function signedPrefix(at: Date): string {
	return `${Math.floor(at.getTime() / 1000)}.`;
}

export interface DeliveryOptions {
	/** The instant the provider stamps and signs. Defaults to now. */
	at?: Date;
	payload?: string;
	/** The key the provider signs with. Defaults to the one the receiver holds. */
	secret?: string;
}

/**
 * A whole delivery as a provider would put it on the wire.
 *
 * `options.secret` is the *signer's* key while the returned `secret` is always
 * the receiver's, because "signed with somebody else's key" is a case worth
 * expressing in one argument.
 */
export function delivery(options: DeliveryOptions = {}): SignatureInput {
	const at = options.at ?? new Date();
	const payload = options.payload ?? DELIVERED;
	const prefix = signedPrefix(at);

	return {
		header: createHmac("sha256", options.secret ?? SECRET)
			.update(prefix, "utf8")
			.update(payload, "utf8")
			.digest("hex"),
		rawBody: bytes(payload),
		secret: SECRET,
		signedPrefix: prefix,
	};
}
```

- [x] **Step 2: Move the existing suite onto the fixture and add the three prefix cases**

Every assertion below already existed and keeps its wording and its comments; what changes is that the four fields come from `delivery()` and one of them is overridden per case. The last three cases are new. Replace the whole of `apps/server/src/lib/webhook.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { verifySignature } from "./webhook";
import { bytes, DELIVERED, delivery, signedPrefix } from "./webhook.fixtures";

describe("verifySignature", () => {
	it("verifies a digest computed over the exact received bytes", () => {
		expect(verifySignature(delivery())).toBe(true);
	});

	/**
	 * The reason the function takes raw bytes, and the case that decides whether
	 * a receiver works at all. The two payloads are the same value with the keys
	 * in a different order; a receiver that verified a parsed body would be
	 * verifying whichever order its own serialiser happens to emit, and would
	 * therefore reject every event the provider ever sent — not merely some.
	 */
	it("rejects the same value with its keys in a different order", () => {
		const reordered = '{"amount":1.0,"id":"evt_1","type":"thing.created"}';

		expect(JSON.parse(reordered)).toEqual(JSON.parse(DELIVERED));
		expect(
			verifySignature({ ...delivery(), rawBody: bytes(reordered) })
		).toBe(false);
	});

	// The same hazard from the other direction: a parse/serialise round trip
	// reformats numbers, so `1.0` comes back as `1` and the digest moves even
	// though nothing about the event changed.
	it("rejects a parse and re-stringify round trip", () => {
		const roundTripped = JSON.stringify(JSON.parse(DELIVERED));

		expect(roundTripped).not.toBe(DELIVERED);
		expect(
			verifySignature({ ...delivery(), rawBody: bytes(roundTripped) })
		).toBe(false);
	});

	it("accepts a digest carrying the algorithm prefix", () => {
		const sent = delivery();

		expect(
			verifySignature({ ...sent, header: `sha256=${sent.header}` })
		).toBe(true);
	});

	it("accepts an upper-cased digest", () => {
		const sent = delivery();

		expect(
			verifySignature({ ...sent, header: sent.header.toUpperCase() })
		).toBe(true);
	});

	it("rejects a tampered body", () => {
		expect(
			verifySignature({
				...delivery(),
				rawBody: bytes(DELIVERED.replace('"amount":1.0', '"amount":9001')),
			})
		).toBe(false);
	});

	it("rejects a digest signed with a different secret", () => {
		expect(
			verifySignature(delivery({ secret: "someone-elses-secret" }))
		).toBe(false);
	});

	/**
	 * The prefix is the only place a provider's out-of-band material — a
	 * timestamp, a delivery id — can be brought under the signature. If it were
	 * left out of the digest, presenting different material with the same digest
	 * would cost nothing, and anything the receiver decided from that material
	 * would be attacker-chosen.
	 */
	it("covers the prefix, so moving it invalidates the digest", () => {
		const sent = delivery();

		expect(
			verifySignature({
				...sent,
				signedPrefix: signedPrefix(new Date("2020-01-01T00:00:00.000Z")),
			})
		).toBe(false);
	});

	// A provider that signs the body alone — GitHub is the common one — passes
	// an empty prefix, and hashing nothing in front of the body is a no-op. So
	// that provider's digest is unchanged by the prefix existing at all.
	it("treats an empty prefix as the body alone", () => {
		const signedOverBodyOnly = delivery({ at: new Date(0) });

		expect(
			verifySignature({
				...delivery({ payload: DELIVERED }),
				header: signedOverBodyOnly.header,
				signedPrefix: "",
			})
		).toBe(false);
		expect(
			verifySignature({
				...delivery(),
				header: createDigestOverBodyOnly(),
				signedPrefix: "",
			})
		).toBe(true);
	});

	it("rejects a correct digest of the wrong length", () => {
		const sent = delivery();

		for (const malformed of [sent.header.slice(0, 63), `${sent.header}00`]) {
			expect(verifySignature({ ...sent, header: malformed })).toBe(false);
		}
	});

	/**
	 * Every one of these has to come back `false`. A throw would reach
	 * `app.onError` as a 500, which tells whoever sent the garbage that they
	 * reached application code, and turns provider retries into an error storm.
	 * These cases fail on a throw as surely as on a `true`.
	 */
	it.each([
		["null", null],
		["undefined", undefined],
		["empty", ""],
		["whitespace", "   "],
		["the prefix alone", "sha256="],
		["not hex", "sha256=not-a-digest"],
		["a different algorithm", `sha512=${delivery().header}`],
		["base64 rather than hex", Buffer.from(delivery().header).toString("base64")],
	])("returns false for a %s header", (_name, header) => {
		expect(verifySignature({ ...delivery(), header })).toBe(false);
	});
});
```

That draft has a deliberate loose end: `createDigestOverBodyOnly` does not exist. Fix it now rather than inventing a second helper — the empty-prefix case is exactly `delivery({ ... })` with no prefix, so express it through the fixture. Replace the whole `treats an empty prefix as the body alone` test with:

```ts
	// A provider that signs the body alone — GitHub is the common one — passes an
	// empty prefix, and hashing nothing in front of the body is a no-op, so that
	// provider's digest is unaffected by the prefix existing at all. The second
	// assertion is the same delivery with a non-empty prefix asserted against it,
	// which must fail: an empty prefix is a claim about the bytes, not a bypass.
	it("treats an empty prefix as the body alone", () => {
		const bodyOnly = createHmac("sha256", SECRET)
			.update(DELIVERED, "utf8")
			.digest("hex");

		expect(
			verifySignature({ ...delivery(), header: bodyOnly, signedPrefix: "" })
		).toBe(true);
		expect(
			verifySignature({ ...delivery(), header: bodyOnly })
		).toBe(false);
	});
```

and add `import { createHmac } from "node:crypto";` as the first import, plus `SECRET` to the fixture import list:

```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "bun:test";
import { verifySignature } from "./webhook";
import {
	bytes,
	DELIVERED,
	delivery,
	SECRET,
	signedPrefix,
} from "./webhook.fixtures";
```

- [x] **Step 3: Run it and watch it fail for the right reason**

```bash
cd apps/server && bun test src/lib/webhook.test.ts
```

Expected: the run fails to typecheck the fixture's return value and the overrides — `Object literal may only specify known properties, and 'signedPrefix' does not exist in type 'SignatureInput'`. Under `bun test` that surfaces as the suite erroring on import rather than as failed assertions. If instead you see `19 pass`, `signedPrefix` was already added to `webhook.ts`; back that out and do Step 4 deliberately.

- [x] **Step 4: Add `signedPrefix` to the input**

In `apps/server/src/lib/webhook.ts`, replace the interface at lines 41-46:

```ts
export interface SignatureInput {
	/** The provider's signature header, as read off the request. */
	header: string | null | undefined;
	rawBody: ArrayBuffer;
	secret: string;
	/**
	 * Bytes the provider hashes in **front** of the body, verbatim as it spells
	 * them on the wire — Stripe's `${unixSeconds}.`, Slack's `v0:${unixSeconds}:`
	 * — and `""` for a provider that signs the body alone.
	 *
	 * This exists because the signed payload is not always the payload. A
	 * provider that transports material beside the body (a timestamp, a delivery
	 * id) brings it under the signature by hashing it in front, and a receiver
	 * that decides anything from that material must verify it the same way, or
	 * the material is attacker-chosen while the digest still checks out.
	 *
	 * A `string` and not a parsed structure, and required rather than defaulted,
	 * for the same reason the header name is not this module's business: the
	 * route knows its provider's grammar and this module knows bytes. A default
	 * of `""` would let a Stripe receiver silently verify the wrong payload.
	 */
	signedPrefix: string;
}
```

- [x] **Step 5: Fold the prefix into the digest**

Same file. Replace the destructure at lines 75-79:

```ts
export function verifySignature({
	header,
	rawBody,
	secret,
	signedPrefix,
}: SignatureInput): boolean {
```

and the digest at lines 95-97:

```ts
	const expected = createHmac("sha256", secret)
		.update(signedPrefix, "utf8")
		.update(Buffer.from(rawBody))
		.digest("hex");
```

Two `update` calls rather than a concatenation: the digest is identical, and the body is still hashed in place with no second copy of it — which is what the comment two lines above promises. An empty prefix hashes nothing, so a body-only provider's digest is bit-for-bit what this function produced before this commit.

- [x] **Step 6: Run the test and watch it pass**

```bash
cd apps/server && bun test src/lib/webhook.test.ts
```

Expected: `19 pass, 0 fail` — the 16 cases that existed at `39fd32c` plus the three prefix cases.

- [x] **Step 7: Prove the whole gate is green**

```bash
bun run fix && bun run check
```

Expected: every turbo task successful; `check-naming` reports the same suite count as before this task (33 at `39fd32c` — the new file is a `.fixtures.ts`, not a suite) and no violation for it; 16 architecture rules verified; migrations match. `bun run fix` runs first because Biome owns import-specifier and object-key order, and `bun run lint` inside `check` does not write.

- [x] **Step 8: Commit**

```bash
git add apps/server/src/lib/webhook.ts apps/server/src/lib/webhook.fixtures.ts apps/server/src/lib/webhook.test.ts
git commit -m "feat(webhook)!: hash what the provider signed, not just the body

The signed payload is not always the payload. Stripe hashes \`\${t}.\` in front of
the body, Slack \`v0:\${t}:\`, Svix the message id and timestamp; GitHub hashes
the body alone. \`verifySignature\` only ever hashed the body, so any material a
provider transports beside the payload was outside the signature — and a
receiver that decided anything from that material would be deciding it from
attacker-chosen bytes while the digest still checked out. That is the hole the
replay window would have fallen through, so it is closed first.

\`signedPrefix\` is a required string rather than an optional one or a parsed
structure. Optional would let a Stripe receiver compile while verifying the
wrong payload; parsed would drag one provider's header grammar into the one file
that says, two lines from the top, that the route knows its own header name and
this module only knows bytes.

Two \`update\` calls, not a concatenation: same digest, and the body is still
hashed through a view over the received bytes with no second copy. Confirmed
before writing it that hmac(prefix)+hmac(body) equals hmac(prefix+body) and that
an empty prefix hashes nothing — so a body-only provider's digest is unchanged
by this commit, and there is a test that says so.

The suite moves onto a shared \`webhook.fixtures.ts\` that builds a delivery
whose digest, bytes and prefix agree by construction. A second suite is coming
and would otherwise copy the signing helpers, and a fixture that derives the
digest is what keeps a committed digest literal — unre-derivable by the next
reader — out of the tests. 19 pass."
```

---

### Task 2: A captured delivery expires

**Files:**
- Modify: `apps/server/src/lib/webhook.ts:7-9`, `:41-46` (as rewritten in Task 1), `:75-79`, and the return
- Modify: `apps/server/src/lib/webhook.fixtures.ts` (`delivery` returns `signedAt`)
- Test: `apps/server/src/lib/webhook.replay.test.ts` (create)

**Interfaces:**
- Consumes: everything Task 1 produced. `signedPrefix` must already be part of the digest, or the timestamp is unauthenticated and this task is theatre.
- Produces — **this is the contract plan 025 writes against**:

  ```ts
  export const NO_TIMESTAMP = "no-timestamp";

  export interface SignatureInput {
  	header: string | null | undefined;
  	rawBody: ArrayBuffer;
  	secret: string;
  	signedAt: Date | typeof NO_TIMESTAMP;
  	signedPrefix: string;
  }

  export function verifySignature(input: SignatureInput): boolean;
  ```

  The return type stays `boolean`. A result union naming *why* verification failed is the next thing a receiver would put in a response body or a log line an attacker can provoke, and the distinction between "stale" and "forged" is precisely what must not leave the process.

- [x] **Step 1: Teach the fixture to return the instant it signed**

`delivery` already computes `at` and derives the prefix from it. Return it as well, so a suite cannot hand `verifySignature` a `signedAt` that disagrees with the prefix by accident. In `apps/server/src/lib/webhook.fixtures.ts`, replace the returned object inside `delivery`:

```ts
	return {
		header: createHmac("sha256", options.secret ?? SECRET)
			.update(prefix, "utf8")
			.update(payload, "utf8")
			.digest("hex"),
		rawBody: bytes(payload),
		secret: SECRET,
		signedAt: at,
		signedPrefix: prefix,
	};
```

and extend the doc comment above `delivery` with the reason the two travel together:

```ts
/**
 * A whole delivery as a provider would put it on the wire.
 *
 * `signedAt` and `signedPrefix` are derived from the same instant, which is the
 * invariant a real receiver has to maintain by hand: the instant it acts on must
 * be parsed from the bytes it puts in the prefix. A fixture that let the two
 * drift would let a suite pass while proving nothing.
 *
 * `options.secret` is the *signer's* key while the returned `secret` is always
 * the receiver's, because "signed with somebody else's key" is a case worth
 * expressing in one argument.
 */
```

- [x] **Step 2: Write the failing suite**

Create `apps/server/src/lib/webhook.replay.test.ts`:

```ts
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
```

- [x] **Step 3: Run it and watch it fail for the right reason**

```bash
cd apps/server && bun test src/lib/webhook.replay.test.ts
```

Expected: the suite errors on import — `NO_TIMESTAMP` is not exported from `./webhook`, and `signedAt` is not a known property of `SignatureInput`. If it runs and reports `1 pass, 6 fail`, an earlier attempt left `signedAt` in the interface without the window; read `webhook.ts` before continuing.

- [x] **Step 4: Add the window**

In `apps/server/src/lib/webhook.ts`, insert after the `HEX_DIGEST` constant at line 39:

```ts
/**
 * How far a delivery's own timestamp may sit from now, in either direction.
 *
 * Five minutes, which is what Stripe's own libraries default to and what Slack
 * documents, and it is chosen from both ends. It has to be wide enough to
 * survive a provider's retry jitter, a few seconds of NTP drift on either host
 * and a queue that briefly falls behind — a minute is not, and a receiver that
 * intermittently 400s teaches its operator to stop reading the alert. It has to
 * be narrow enough that a captured request is a five-minute liability rather
 * than a permanent one.
 *
 * A constant and not a parameter, and certainly not an environment variable. A
 * parameter is a knob that gets widened at 02:00 to make a flaky integration
 * green, and the widened value then lives in a route file nobody reviews as a
 * security decision. An env key would additionally be this repository making a
 * deployment decision on somebody's behalf, which is the thing `packages/env`
 * was refactored to stop doing. If a provider ever genuinely needs more, that is
 * a deliberate edit here, with a comment, reviewed as what it is.
 */
const TOLERANCE_MS = 5 * 60 * 1000;

/**
 * What a receiver passes as `signedAt` when its provider transports no timestamp
 * at all — GitHub is the common one, signing the body and nothing else.
 *
 * A named value rather than an optional field or a `null`, because opting out of
 * a replay window must not be reachable by forgetting. This one has to be
 * imported and spelled out at the call site, so it appears in the diff, in the
 * review and in a grep for every receiver that has no window. Such a receiver
 * owes exactly-once by another route: see the contract on `verifySignature`.
 */
export const NO_TIMESTAMP = "no-timestamp";

/**
 * Whether the delivery claims an instant close enough to now.
 *
 * Symmetric, because clocks are wrong in both directions. A far-future stamp is
 * either a host whose clock is ahead — where honouring it would silently extend
 * every window that follows — or a capture held back until the honest window
 * closed. `Math.abs` costs nothing and the one-sided spelling admits every
 * future timestamp there will ever be.
 *
 * An unparseable instant arrives here as `NaN` and every comparison against
 * `NaN` is false, so it is refused by the arithmetic. That is the answer wanted,
 * and a branch written for it would only be a second way to get it wrong.
 */
function withinWindow(signedAt: Date | typeof NO_TIMESTAMP): boolean {
	if (signedAt === NO_TIMESTAMP) {
		return true;
	}

	return Math.abs(Date.now() - signedAt.getTime()) <= TOLERANCE_MS;
}
```

- [x] **Step 5: Add `signedAt` to the input**

Same file. Insert into `SignatureInput`, between `secret` and `signedPrefix` so the members stay sorted:

```ts
	/**
	 * The instant the provider says it stamped this delivery, already parsed.
	 *
	 * A `Date` and not a raw header value, because providers disagree about
	 * everything except that they disagree: Stripe puts `t=` inside the signature
	 * header, Slack and Svix use a separate header, others use a body field, and
	 * the unit is sometimes seconds and sometimes milliseconds. Parsing that here
	 * would mean either guessing or learning one provider's grammar, and the
	 * route that already knows its own header name is the place that knows.
	 *
	 * The invariant the caller MUST hold: this instant is parsed from the same
	 * bytes it passes as `signedPrefix`. That is what makes the timestamp
	 * authenticated rather than advisory — relabelling a stale capture then moves
	 * the prefix, and the digest stops matching. A caller that reads the instant
	 * from one place and prefixes another has a window an attacker can slide.
	 */
	signedAt: Date | typeof NO_TIMESTAMP;
```

Then add it to the destructure, keeping the order:

```ts
export function verifySignature({
	header,
	rawBody,
	secret,
	signedAt,
	signedPrefix,
}: SignatureInput): boolean {
```

- [x] **Step 6: Combine the two verdicts without a branch between them**

Same file. Replace the final return (the `safeEquals` line and the three comment lines above it):

```ts
	// Both verdicts are computed before either is looked at, and this is not
	// style. `&&` short-circuits, so `matches && withinWindow(...)` would make
	// the function's running time depend on whether the digest matched — the
	// coarse oracle `safeEquals` exists to deny — and `withinWindow(...) &&
	// safeEquals(...)` would make operand order a security property that no
	// assertion in the suite can catch. Two consts and one combine at the end
	// keeps the property local and visible. The cost when a delivery is stale is
	// one SHA-256 over a body the request body limit already bounds.
	//
	// Hex has two spellings and `digest("hex")` only produces the lower one.
	// Normalising accepts a provider that upper-cases without weakening the
	// comparison, which the shape check above has already length-bounded.
	const fresh = withinWindow(signedAt);
	const matches = safeEquals(supplied.toLowerCase(), expected);

	return fresh && matches;
```

- [x] **Step 7: Put freshness into the receiver order at the top of the file**

Same file, lines 7-9 — the first item of the numbered receiver order. Replace:

```ts
 * 1. Verify the signature over the raw request bytes, and refuse a delivery
 *    whose own timestamp is outside the replay window. Nothing else happens
 *    first — an unsigned request must not be able to reach a parser, a query
 *    or a log line that an operator will later read as fact, and a request that
 *    verified last week must not be able to reach any of them twice.
```

- [x] **Step 8: Run both suites and watch them pass**

```bash
cd apps/server && bun test src/lib/webhook.test.ts src/lib/webhook.replay.test.ts
```

Expected: `26 pass, 0 fail` — 19 from Task 1 and 7 here.

- [x] **Step 9: Prove the whole gate is green**

```bash
bun run fix && bun run check
```

Expected: every turbo task successful; `check-naming` reports one more suite than before this task (34 at `39fd32c`, and it accepts `webhook.replay.test.ts` because `webhook.ts` exists beside it); 16 architecture rules verified; migrations match.

- [x] **Step 10: Commit**

```bash
git add apps/server/src/lib/webhook.ts apps/server/src/lib/webhook.fixtures.ts apps/server/src/lib/webhook.replay.test.ts
git commit -m "feat(webhook)!: a captured delivery stops verifying after 5 minutes

\`verifySignature\` answered one question — does this digest match these bytes
under this key — and that answer stays true forever. A recorded valid request
therefore verified indefinitely, and the receiver order this repo documents
(verify, persist, enqueue, 200) would have written a fresh row for every replay,
because none of those four steps consults an event identity.

Nothing is exploitable today: the function's only importer is its own test and no
receiver exists yet. That is the argument for doing it now rather than later —
the reference receiver lands next and would otherwise inherit the gap and
re-derive a fix for it.

\`signedAt\` is a parsed \`Date\`, not a header to parse. Stripe puts \`t=\`
inside the signature header, Slack and Svix use separate headers, others use a
body field, and the unit is sometimes seconds. The route already owns its
provider's header name, so it owns this too, and the module keeps knowing only
bytes. What the module does enforce is that the instant be authenticated: it must
come from the same bytes the caller passes as the prefix, so relabelling a stale
capture moves the prefix and the digest stops matching. There is a test for
exactly that, with both instants inside the window so only the digest can refuse.

Five minutes, symmetric, as a module constant. Wide enough for retry jitter and
NTP drift, narrow enough that a capture is a five-minute liability. Symmetric
because a far-future stamp is either a clock that is ahead — silently extending
every window after it — or a capture held back on purpose. A constant rather than
a parameter because a knob gets widened to make a flaky integration green, and
rather than an env key because that would be this repository making a deployment
decision, which is what \`packages/env\` was refactored to stop doing.

The two verdicts are computed into consts and combined at the end. \`&&\`
short-circuits, so \`matches && fresh\` would make running time depend on whether
the digest matched, and \`fresh && matches\` would make operand order a security
property no test can catch. A stale delivery pays one SHA-256 for that.

\`NO_TIMESTAMP\` is the opt-out for a provider that transports no timestamp at
all, and it is a named export rather than an optional field so that having no
window cannot be reached by forgetting — it shows up in the diff and in a grep.
26 pass across the two suites."
```

---

### Task 3: State the exactly-once contract a receiver inherits

**Files:**
- Modify: `apps/server/src/lib/webhook.ts` (the doc comment on `verifySignature`)
- Modify: `README.md:257-261`

**Interfaces:**
- Consumes: `NO_TIMESTAMP` and the window from Task 2.
- Produces: no code. The contract plan 025's receiver, and every receiver after it, is held to.

- [x] **Step 1: Write the contract onto the function**

The window bounds a replay to five minutes; it does not make delivery exactly-once, and a reader who stops at "there is a window now" will build a receiver that double-processes inside it. Two candidates were considered for where this belongs. `.agents/skills/server-module/SKILL.md` covers modules — tables, contracts, the four layers, tenancy — and has no background-work section at all; putting the queue's replay semantics there means a receiver author reads it only if they happen to be adding a module at the time. The doc comment travels with the signature they are already reading, and it is what their editor shows them at the call site. So: the doc comment, and 025's receiver as the executable statement of it.

In `apps/server/src/lib/webhook.ts`, append to the doc comment on `verifySignature` — after the paragraph ending "...error storm in our own alerting.", before the closing `*/`:

```ts
 *
 * ## What a receiver still owes, after this returns true
 *
 * The window bounds a replay; it does not make delivery exactly-once. Inside
 * five minutes a provider's own retry — and an attacker's replay — verifies,
 * correctly, because it is a genuine delivery of a genuine event. Deduplication
 * is therefore the receiver's job and it has two halves, both required:
 *
 * 1. **A unique index on the provider's event id**, on whatever table holds the
 *    raw payload. This is the durable guard, and it is the one that still works
 *    when `signedAt` is `NO_TIMESTAMP` and there is no window at all. Key it on
 *    the provider as well as the id: two providers can and do mint the same
 *    string.
 * 2. **`enqueue`'s `dedupeKey` set to that same event id**, namespaced —
 *    `webhook:<provider>:<eventId>` — so a burst of provider retries collapses
 *    into the one job that has not started yet.
 *
 * The second is not a substitute for the first, and the reason is in the index
 * rather than in the code: `job_dedupeKey_pending_idx` is unique only
 * `WHERE status = 'pending'` (`packages/db/src/schema/job.ts`). The moment a job
 * settles the key leaves the index and is usable again, which is exactly the
 * behaviour that makes it a debounce and a mutex — and exactly why it cannot
 * remember an event from ten minutes ago. A receiver that treats `dedupeKey` as
 * its replay guard is relying on a row it has already deleted.
 *
 * The event id comes out of the payload, which means it is read after the
 * signature verified and never before. An id parsed from an unverified body is
 * an attacker-chosen primary key.
 */
```

- [x] **Step 2: Fix the documented receiver order in the README**

`README.md:257-261` describes the pattern as the clearest case for background work and now under-describes it — a reader following that paragraph would build a receiver with no freshness check and no event identity. Replace those lines:

```markdown
Work belongs here rather than in a request whenever it can outlive one. Webhook
receivers are the clearest case: `apps/server/src/lib/webhook.ts` verifies the
signature over the **raw bytes** — a body that was parsed and re-stringified
produces a different digest and rejects every event — refuses a delivery whose own
timestamp is more than five minutes from now in either direction, then persists the
payload, enqueues under the provider's event id, and returns 200. The window bounds
a replay; the event id is what makes processing exactly-once, because
`dedupe_key` is unique only while a job is pending. Providers retry within
seconds, and an LLM or outbound API call does not fit inside that window.
```

Nothing else in `README.md` changes. Its counts belong to plan 021.

- [x] **Step 3: Hand plan 021 the AGENTS.md clause**

`AGENTS.md:49-51` carries the same pattern in one sentence: "Webhook receivers verify over `await c.req.arrayBuffer()`, persist, enqueue, return 200; a re-stringified body produces a different digest and rejects every event." Plan 021 owns that file's length and is the only plan permitted to edit it, so do not touch it here. Record the replacement for 021 to carry:

> Webhook receivers verify over `await c.req.arrayBuffer()`, refuse a delivery stamped more than five minutes from now, persist, enqueue under the provider's event id, return 200; a re-stringified body produces a different digest and rejects every event.

Post it to plan 021's author, or add it to that plan's file if 021 has not landed. Do not leave it only in this plan.

- [x] **Step 4: Prove the whole gate is green**

```bash
bun run fix && bun run check
```

Expected: every turbo task successful, `26 pass` across the two webhook suites, suite count unchanged from Task 2, 16 architecture rules verified, migrations match. Comment lines do not count toward `noExcessiveLinesPerFile`, so the doc addition cannot push `webhook.ts` over the limit — but the run is what says so.

- [x] **Step 5: Commit**

```bash
git add apps/server/src/lib/webhook.ts README.md
git commit -m "docs(webhook): the replay window is not exactly-once delivery

A five-minute window bounds a replay. Inside it, a provider's retry verifies —
correctly, because it is a real delivery of a real event — so deduplication is
still the receiver's job, and a reader who stops at \"there is a window now\"
builds a receiver that double-processes inside it.

Both halves are now stated on the function a receiver author is already reading,
rather than in a skill file they would open only if they happened to be adding a
module: a unique index on (provider, event id) over the persisted payload as the
durable guard, and \`enqueue\`'s \`dedupeKey\` set to the same event id to
collapse a retry burst. The second is explicitly not a substitute for the first,
and the reason is the index rather than the code — \`job_dedupeKey_pending_idx\`
is unique only while a job is pending, so the key is reusable the moment the job
settles. Treating it as a replay guard means relying on a row already gone.

The event id is read from the payload, which is to say after the signature
verified. An id parsed from an unverified body is an attacker-chosen primary key.

The README paragraph that calls this pattern the clearest case for background
work described four steps and now describes six. AGENTS.md carries the same
sentence and is left alone; plan 021 owns that file's length and has the clause."
```

---

## Done when

- `SignatureInput` is `{ header, rawBody, secret, signedAt, signedPrefix }`, both new fields required, and `verifySignature` still returns `boolean`.
- A delivery signed at `now` verifies; the same delivery signed six minutes ago or six minutes ahead does not; one signed 4m59s ago does and one signed 5m1s ago does not.
- A stale delivery relabelled with a fresh timestamp fails, with both instants inside the tolerance, so the refusal provably comes from the digest and not from the window.
- A `Date` that parsed to `NaN` is refused.
- `NO_TIMESTAMP` verifies a delivery of any age, and appears nowhere except its own definition, its test and a receiver that has chosen it.
- No early return sits between the HMAC and the freshness verdict: both are `const`s and the only branch is the final combine.
- `apps/server/src/lib/webhook.replay.test.ts` and `apps/server/src/lib/webhook.fixtures.ts` exist, no digest literal is committed in either suite, and `26 pass, 0 fail` across the two webhook suites.
- `verifySignature`'s doc comment names the event id as the `enqueue` dedupe key, requires a unique index on (provider, event id) as the durable guard, and says why the queue's partial index is not one.
- `README.md`'s webhook paragraph describes the window and the event id. `AGENTS.md` is untouched and its replacement clause has been handed to plan 021.
- `bun run check` passes.

## Out of scope

- **The receiver itself** — the route, the payload table, the job kind, the unique index, the `enqueue` call. Plan 025 (DIR-03) owns all of it and consumes the signature in Task 2's **Interfaces** block. This plan deliberately ships a primitive with one importer, which is its own test.
- **`AGENTS.md`** — plan 021 owns its length; Task 3 Step 3 hands over the clause.
- **The request body limit** that bounds the SHA-256 a stale delivery pays for — plan 005 owns `apps/server/src/lib/security.ts`.
- **The `Idempotency-Key` middleware** — plan 012 owns `apps/server/src/lib/idempotency.ts`. Verified evidence 4 records why it is not a candidate here.
- **Making the queue's dedupe key survive settlement** (CORR-08). Not a bug: the partial index is a deliberate debounce-and-mutex (`packages/db/src/schema/job.ts:59-73`). Task 3 states the consequence for receivers instead of changing the index.
- **Queue settlement, the reaper, and the worker loop** — plans 010, 011 and 016 in that order.
