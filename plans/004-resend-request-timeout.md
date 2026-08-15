# Resend Request Timeout Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** PERF-01 (`plans/audit-report.md:179-185`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Goal:** Bound the Resend request — headers and body together — so a stalled provider socket becomes a retryable job failure in seconds instead of holding the worker's only execution slot for as long as the network lets it.

**Architecture:** `packages/mail/src/send.ts:62` calls `fetch` with no `signal`, so nothing in the process can end that request. The worker runs a claimed batch one job at a time (`apps/server/src/lib/jobs.ts:50-53`, with an explicit `noAwaitInLoops` exemption), so the stall is not one slow mail job: `ai.generate` and every future kind wait behind it. `packages/ai/src/generate.ts:17,57` already solved this for the other outbound call — a module constant plus a per-call override, fed to `AbortSignal.timeout` — and its doc comment at lines 3-16 names this exact hazard. The fix copies that shape into the mail package: one `AbortSignal.timeout` covering the fetch **and** the error-path body read, and a `catch` that turns the abort into an error naming Resend and the budget, so `runJob`'s catch (`apps/server/src/lib/jobs.ts:81-87`) records something a human can act on and reschedules the job.

**Tech Stack:** Bun 1.3.14 (WHATWG `fetch`, `AbortSignal.timeout`), bun:test, `@keel/mail` (which has no runtime dependency other than `@keel/db`).

---

## Verified evidence (do not re-litigate)

PERF-01 is CONFIRMED outright. Everything below was checked against the working tree at `39fd32c`, and the Bun behaviour was executed rather than assumed.

**1. The call is genuinely unbounded.** `packages/mail/src/send.ts:62-82`:

```ts
	const response = await fetch(RESEND_ENDPOINT, {
		body: JSON.stringify({ … }),
		headers: {
			Authorization: `Bearer ${config.apiKey}`,
			"Content-Type": "application/json",
			"Idempotency-Key": idempotencyKey,
		},
		method: "POST",
	});
```

No `signal`, no `AbortController`, nothing else in the function that could end it.

**2. The contrast is one directory away, and it is already argued.** `packages/ai/src/generate.ts:17` is `export const DEFAULT_TIMEOUT_MS = 120_000;`, line 41 is `timeoutMs?: number` on `GenerateOptions`, and line 57 is `abortSignal: AbortSignal.timeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS)`. Its doc comment (lines 3-16) states the hazard in the same words the audit uses:

> Left unbounded that is not one slow job: `runOnce` runs a claimed batch sequentially, so a single hung call stops the worker from touching any other kind of work until the provider gives up — and the job row stays `running` with a lock nobody will release.

**3. The serial loop is real — but the audit's citation for it is wrong.** The audit cites `apps/server/src/lib/jobs.ts:38-46`. That range is the tail of `runOnce`'s doc comment, its signature, and the `claim` call. `runOnce` spans **39-56**; the loop is **50-53**:

```ts
	for (const entry of claimed) {
		// biome-ignore lint/performance/noAwaitInLoops: one job at a time is the intended throughput ceiling; a parallel batch would hold DATABASE_POOL_MAX connections that request handling also draws from.
		await runJob(registry, entry, workerId);
	}
```

Same conclusion, correct lines. `mail.send` is registered at `apps/server/src/worker.ts:58-63` and calls `sendMail` directly, so a stalled socket stalls `loop()` at `worker.ts:144`.

**4. The forced kill is real.** `apps/server/src/worker.ts:117` is `const SHUTDOWN_DEADLINE_MS = 10_000;`, and `worker.ts:173-178` arms a timer that writes `still draining after 10000ms, exiting anyway` and calls `process.exit(1)`. The drain at `worker.ts:184` is `await finished`, which cannot resolve while the loop is inside a hung `fetch`. The row is then stranded `running` with no reaper — that gap is CORR-01, owned by plan 011, not this plan.

**5. Correction to the audit's fix sketch.** It says "read the body with the same budget", which reads as though the success path reads a body. **It does not.** `send.ts:84-94` checks `response.ok` and returns; the only body read in the file is `await response.text()` at line **91**, inside the non-OK branch. So the headers-arrived-body-never-ends hang lives exclusively on the failure path — which is worse than it sounds, because a provider under stress is precisely the one that answers 429/503 slowly. Do not go looking for a body read on the success path; there is none, and this plan does not add one.

**6. One `AbortSignal.timeout` covers both phases in Bun — executed, not reasoned.** Against a real `Bun.serve` that returned 403 headers immediately and then held the body stream open forever:

```
phase: headers-received status=403 after 17ms
threw after 305 ms
name: TimeoutError
message: The operation timed out.
is DOMException: true
signal.aborted: true
```

So the signal handed to `fetch` errors the response body stream too: `await response.text()` rejects on the same budget, started at signal creation. Aborting *before* headers behaves identically (`pre-headers: TimeoutError | The operation timed out. | after 202 ms`). Both facts matter: one signal is enough, and it must be created once and reused, not re-created for the body read.

**7. The abort's own error is useless on a job row.** It is a `DOMException` named `TimeoutError` whose message is exactly `The operation timed out.` — it names neither Resend, nor the budget, nor the fact that a retry is safe. `fail` stores `String(error)` into `job.last_error`, so that string is all an operator gets. It must be wrapped.

**8. A pending timeout timer does not hold the process open.** A successful fast send that leaves an `AbortSignal.timeout(8000)` timer pending exits immediately (`exited after 9 ms`), so this change adds no drag to the worker's drain and cannot keep a `bun test` process alive.

**9. Nothing mitigates this today.** `grep -E "AbortSignal|signal:|timeoutMs"` across `apps/` and `packages/` matches only `packages/ai/src/generate.ts` (+ its test) and the two unrelated `shutdown(signal: string)` functions. `STATEMENT_TIMEOUT_MS` (`packages/env/src/server.ts:145`) bounds a Postgres statement and an idle transaction; it has nothing to say about an HTTP socket.

**10. The new cases cannot go in the existing suite.** `packages/mail/src/send.test.ts` is 161 lines against the 200-line cap at `biome.jsonc:68-73`, and the new cases plus their three stubs are roughly 90 more. They go in an aspect suite, `send.timeout.test.ts`, which is what `<subject>[.<aspect>].test.ts` exists for — `apps/server/src/lib/jobs.ownership.test.ts` is the precedent, and it is self-contained with its own local constants rather than importing them from the lifecycle suite.

---

## Global Constraints

- `bun run check` must pass at the end of the task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, the architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`, `biome.jsonc:68-73`; comment lines and multi-line template literals do not count). `packages/mail/src/**` gets no exemption from it.
- **No environment variable gets a default.** This plan adds no environment variable at all — see the first bullet of "Do not" for why.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts`; `tools/check-naming.ts` enforces it. `send.timeout.test.ts` beside `send.ts` satisfies the rule because `send.timeout` starts with `send.`, and `send.ts` exists in the same directory (`tools/check-naming.ts:88-94`).
- Tests live beside the code. This suite touches no database, so it needs no `testDbReady()` gate — but note that `packages/mail/bunfig.toml` preloads `test-setup.ts`, which requires `TEST_DATABASE_URL` from the committed root `.env.test` before any suite in the package runs. It does not connect.
- `packages/mail` reads no environment. `send.ts:99-101` states it: "Config is an argument rather than an import: this package reads no environment". Keep it that way.

## Do not

- **Do not add a `MAIL_TIMEOUT_MS` (or similar) environment key.** Three reasons, each sufficient. (a) `packages/mail/package.json:13-15` depends only on `@keel/db`; reaching for `@keel/env` would invert the design that makes `MailConfig` an argument. (b) A required key means adding it to `.env.example`, `apps/server/.env`, `.env.test` **and** `docker-compose.prod.yml`'s `x-app-env` — which is plan 019's file — so that every deployment must name a socket timeout in order to boot. (c) An optional key would need a `resolve*` guard that throws naming it, and there is nothing to throw about: this value has a correct answer that the repository is better placed to pick than a deployment is. `@keel/ai` faced the identical choice and put `DEFAULT_TIMEOUT_MS` in the package (`packages/ai/src/generate.ts:17`). A constant is the consistent answer.
- **Do not implement the timeout with `Promise.race` or a bare `setTimeout`.** A race leaves the request running: the socket, the pooled TLS connection and the eventual response are all still live, and the only thing that ended was the caller's interest. The point is to end the request, which only an `AbortSignal` on the `fetch` init does.
- **Do not create a second signal for the body read.** Evidence 6 shows the fetch's own signal already errors the response body stream. A second signal would restart the budget after headers arrive, so a provider that dribbles headers then stalls would get twice the time it was granted.
- **Do not swallow the abort.** An aborted send must reject. Resolving it would let `runJob` call `complete` (`apps/server/src/lib/jobs.ts:80`) and mark a message delivered that may never have been sent.
- **Do not add a retry inside `sendMail`.** The queue is the retry mechanism and it is the visible one — attempts are counted on the row and the last failure is readable there. `packages/ai/src/generate.ts:58-63` makes this argument for the AI call; it applies unchanged here.
- **Do not change the non-OK error message.** `Resend rejected the message: ${status} ${body}` is load-bearing (`packages/mail/src/send.test.ts:130-141` pins it) and the timeout error must be distinguishable from it, not a variant of it.
- **Do not set `timeoutMs` in `resolveMailConfig`** (`apps/server/src/lib/mail.ts:47-51,56`). The override exists so a test can pick a 20 ms budget; a deployment always gets the constant.
- **Do not touch `apps/server/src/lib/jobs.ts` or `apps/server/src/worker.ts`.** Settlement is plan 010's, the reaper is plan 011's, and worker-loop testability is plan 016's. This plan changes one package.

## File structure

| File | Responsibility |
|---|---|
| `packages/mail/src/send.ts` | **Modify.** Own the request budget: the constant, the signal on the fetch, and the abort-to-named-error translation. |
| `packages/mail/src/send.timeout.test.ts` | **Create.** The budget's behaviour: a signal is passed, a silent provider aborts, a stalled body aborts, a real network failure keeps its own message. |

---

### Task 1: Bound the Resend request and prove the abort

**Files:**
- Create: `packages/mail/src/send.timeout.test.ts`
- Modify: `packages/mail/src/send.ts:3-10` (constant and `MailConfig`), `packages/mail/src/send.ts:47-94` (`sendViaResend`)

**Interfaces:**
- Consumes: `sendMail(config: MailConfig, message: MailMessage, idempotencyKey: string): Promise<void>` and `interface MailConfig { apiKey?: string; driver: "log" | "resend"; from: string }` from `packages/mail/src/send.ts:5-10,103-107`; `interface MailMessage { html: string; subject: string; text: string; to: string }` from `packages/mail/src/message.ts:9-14`.
- Produces: `export const RESEND_TIMEOUT_MS = 8_000` and a new optional `timeoutMs?: number` member on the exported `MailConfig`. Nothing else in the repository is required to change: `resolveMailConfig` builds `MailConfig` with an object literal (`apps/server/src/lib/mail.ts:47-51,56`) and an added optional member does not break it.

- [x] **Step 1: Write the failing suite**

Create `packages/mail/src/send.timeout.test.ts`. Three stubs, because three different kinds of stall have to be told apart, and one of them (`stubStalledBodyFetch`) reproduces in a fake exactly what evidence 6 measured against a real socket.

```ts
import { afterEach, describe, expect, it } from "bun:test";
import type { MailMessage } from "./message";
import { type MailConfig, RESEND_TIMEOUT_MS, sendMail } from "./send";

const API_KEY = "re_test_do_not_leak";
const KEY = "01JJ0000000000000000000000";

/**
 * Far below the shipped budget, so a stall that is correctly aborted costs the
 * suite 20ms and a stall that is not costs it bun:test's 5s per-test timeout —
 * a red test either way, never a hung run.
 */
const TEST_TIMEOUT_MS = 20;
const TIMEOUT_MESSAGE = /Resend did not answer within 20ms/;
const CONNECT_MESSAGE = /Unable to connect/;

/**
 * Duplicated on purpose from `apps/server/src/worker.ts:117`. A package may not
 * import from `apps/`, and the coupling is worth pinning anyway: the budget has
 * to stay under the worker's drain deadline, or one hung send is enough on its
 * own to turn a graceful shutdown into `process.exit(1)`.
 */
const WORKER_SHUTDOWN_DEADLINE_MS = 10_000;

const MESSAGE: MailMessage = {
	html: "<p>Confirm your address</p>",
	subject: "Confirm your email address",
	text: "Confirm your address: https://keel.test/verify?token=abc",
	to: "recipient@example.com",
};

const RESEND_CONFIG: MailConfig = {
	apiKey: API_KEY,
	driver: "resend",
	from: "Keel <hi@keel.test>",
};

const originalFetch = globalThis.fetch;

interface Call {
	init: RequestInit;
	url: string;
}

/** Answers immediately, so the assertion is about what was passed, not timing. */
function stubFetch(response: () => Response): Call[] {
	const calls: Call[] = [];

	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({ init, url });

		return Promise.resolve(response());
	}) as unknown as typeof fetch;

	return calls;
}

/** A provider that accepted the connection and then said nothing at all. */
function stubSilentFetch(): Call[] {
	const calls: Call[] = [];

	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({ init, url });

		const { promise, reject } = Promise.withResolvers<Response>();
		init.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
			once: true,
		});

		return promise;
	}) as unknown as typeof fetch;

	return calls;
}

/**
 * Headers arrive, the body never ends. Erroring the stream on abort is not
 * invention: a real Bun fetch does exactly this, measured against a live
 * `Bun.serve` that held a body stream open — `response.text()` rejected with the
 * signal's `TimeoutError` on the fetch's own budget.
 */
function stubStalledBodyFetch(status: number): Call[] {
	const calls: Call[] = [];

	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({ init, url });

		const body = new ReadableStream({
			start(controller) {
				controller.enqueue(new TextEncoder().encode('{"message":"partial'));
				init.signal?.addEventListener(
					"abort",
					() => controller.error(init.signal?.reason),
					{ once: true }
				);
			},
		});

		return Promise.resolve(new Response(body, { status }));
	}) as unknown as typeof fetch;

	return calls;
}

/** A socket that failed outright, which is not a timeout and must not read as one. */
function stubFailingFetch(error: Error): Call[] {
	const calls: Call[] = [];

	globalThis.fetch = ((url: string, init: RequestInit) => {
		calls.push({ init, url });

		return Promise.reject(error);
	}) as unknown as typeof fetch;

	return calls;
}

afterEach(() => {
	globalThis.fetch = originalFetch;
});

/**
 * The budget, split from the lifecycle suite because that file is at 161 of the
 * 200 permitted lines and these cases need three stubs of their own.
 *
 * What is being defended: the worker runs a claimed batch one job at a time, so
 * an unbounded send does not delay one message — it stops every kind of work in
 * the process until the network gives up.
 */
describe("sendMail, resend request budget", () => {
	it("bounds the request with an abort signal", async () => {
		const calls = stubFetch(() => new Response("{}", { status: 200 }));

		await sendMail(RESEND_CONFIG, MESSAGE, KEY);

		expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal);
		expect(calls[0]?.init.signal?.aborted).toBe(false);
	});

	it("aborts a request the provider never answers", async () => {
		stubSilentFetch();

		await expect(
			sendMail({ ...RESEND_CONFIG, timeoutMs: TEST_TIMEOUT_MS }, MESSAGE, KEY)
		).rejects.toThrow(TIMEOUT_MESSAGE);
	});

	it("aborts a response whose headers arrived and whose body never ends", async () => {
		stubStalledBodyFetch(403);

		await expect(
			sendMail({ ...RESEND_CONFIG, timeoutMs: TEST_TIMEOUT_MS }, MESSAGE, KEY)
		).rejects.toThrow(TIMEOUT_MESSAGE);
	});

	it("leaves a failure that is not a timeout carrying its own message", async () => {
		stubFailingFetch(new TypeError("Unable to connect"));

		await expect(
			sendMail({ ...RESEND_CONFIG, timeoutMs: TEST_TIMEOUT_MS }, MESSAGE, KEY)
		).rejects.toThrow(CONNECT_MESSAGE);
	});

	it("does not put the API key in the timeout error", async () => {
		stubSilentFetch();

		const error = await sendMail(
			{ ...RESEND_CONFIG, timeoutMs: TEST_TIMEOUT_MS },
			MESSAGE,
			KEY
		).catch((thrown: Error) => thrown);

		expect(String(error)).not.toContain(API_KEY);
	});

	it("ships a budget the worker can still drain inside", () => {
		expect(RESEND_TIMEOUT_MS).toBeLessThan(WORKER_SHUTDOWN_DEADLINE_MS);
	});
});
```

- [x] **Step 2: Run it and watch it fail for the right reason**

```bash
cd packages/mail && bun test src/send.timeout.test.ts
```

Expected — the module never even loads, because the constant does not exist yet:

```
# Unhandled error between tests
-------------------------------
SyntaxError: Export named 'RESEND_TIMEOUT_MS' not found in module '<repo>/packages/mail/src/send.ts'.
-------------------------------

 0 pass
 1 fail
 1 error
```

If instead you see `TEST_DATABASE_URL is required to run the tests`, the preload at `packages/mail/test-setup.ts:13-17` could not read the root `.env.test`; restore that file rather than editing the preload.

- [x] **Step 3: Declare the budget and the override**

In `packages/mail/src/send.ts`, replace lines 3-10 — the endpoint constant and the `MailConfig` interface — with:

```ts
const RESEND_ENDPOINT = "https://api.resend.com/emails";

/**
 * How long one Resend call may take, connection through body.
 *
 * Unbounded, this is not one slow message. The worker runs a claimed batch one
 * job at a time (`runOnce` in apps/server/src/lib/jobs.ts), so a socket the
 * provider never answers stops every other kind of work in the process, and the
 * 10s drain deadline in apps/server/src/worker.ts then turns a graceful
 * shutdown into `process.exit(1)` with the row still `running`.
 *
 * Eight seconds is roughly an order of magnitude above a normal answer — the
 * endpoint accepts a message and queues it, it does not wait for delivery — and
 * is deliberately under that drain deadline, so one hung send cannot on its own
 * force the kill. A whole batch of hung sends still can; that is what a reaper
 * is for, not a timeout.
 *
 * A constant rather than an environment key, for the same reason
 * `DEFAULT_TIMEOUT_MS` in @keel/ai is one: this package reads no environment,
 * and a socket budget is a decision the repository is better placed to make
 * than every deployment that would otherwise have to name it in order to boot.
 */
export const RESEND_TIMEOUT_MS = 8_000;

export interface MailConfig {
	/** Required when `driver` is `resend`. */
	apiKey?: string;
	driver: "log" | "resend";
	from: string;
	/**
	 * Overrides `RESEND_TIMEOUT_MS` for this config. Nothing in a deployment
	 * sets it — `resolveMailConfig` does not — and it exists so a test can pick a
	 * budget it can afford to wait out.
	 */
	timeoutMs?: number;
}
```

- [x] **Step 4: Pass the signal and translate the abort**

In the same file, replace `sendViaResend` — lines 47-94, the whole function, keeping the `apiKey` guard exactly as it is — with:

```ts
async function sendViaResend(
	config: MailConfig,
	message: MailMessage,
	idempotencyKey: string
): Promise<void> {
	if (!config.apiKey) {
		// A programmer error, not a runtime condition: whoever resolves the driver
		// resolves the key with it and fails at startup. Degrading to `log` here
		// would turn a misconfigured production deployment into one that looks
		// healthy while delivering nothing.
		throw new Error(
			'MailConfig.apiKey is required when driver is "resend". Resolve the driver and the key together, and fail at startup rather than at the first send.'
		);
	}

	const timeoutMs = config.timeoutMs ?? RESEND_TIMEOUT_MS;

	// One signal, created once, covering both phases. Handing it to `fetch` also
	// errors the response body stream, so the `response.text()` below is on the
	// same budget as the request that produced it — a provider whose headers
	// arrive and whose body never completes hangs exactly as hard as one that
	// never answers, and a second signal would silently grant it twice the time.
	const signal = AbortSignal.timeout(timeoutMs);

	try {
		const response = await fetch(RESEND_ENDPOINT, {
			body: JSON.stringify({
				from: config.from,
				html: message.html,
				subject: message.subject,
				text: message.text,
				to: [message.to],
			}),
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				"Content-Type": "application/json",
				// The queue retries a failed job, and the most common failure is a
				// timeout — which is indistinguishable from a slow success, because the
				// message may well have been accepted and delivered before the socket
				// gave up. Without this header that retry is a second copy in the
				// recipient's inbox; with it Resend replays the first outcome. The key
				// is the job id, so every attempt at one job carries the same value.
				"Idempotency-Key": idempotencyKey,
			},
			method: "POST",
			signal,
		});

		if (!response.ok) {
			// Status and body both, because the worker stores this string as the job's
			// `lastError` and that is all anyone will have to work from: 403 with a
			// domain-not-verified body and 429 with a rate-limit body need entirely
			// different fixes, and "send failed" distinguishes neither. The API key is
			// never interpolated — a job row is not a secret store.
			throw new Error(
				`Resend rejected the message: ${response.status} ${await response.text()}`
			);
		}
	} catch (error) {
		// Only the abort is reclassified. A refused connection, a DNS failure and
		// the rejection above all carry a message that already says what happened,
		// and burying them under "did not answer" would cost the operator the one
		// line the job row keeps.
		if (signal.aborted) {
			// The abort's own error is a DOMException reading "The operation timed
			// out." — it names neither the provider, nor the budget, nor the fact
			// that the retry is safe, and `job.last_error` is where it lands. The
			// original travels as `cause` for a local stack rather than being
			// concatenated into a string a human has to read in a database row.
			throw new Error(
				`Resend did not answer within ${timeoutMs}ms, so the request was aborted. Retrying is safe: every attempt carries the same Idempotency-Key, so a message the provider did accept cannot be delivered twice.`,
				{ cause: error }
			);
		}

		throw error;
	}
}
```

- [x] **Step 5: Run both mail suites and watch them pass**

```bash
cd packages/mail && bun test src/send.timeout.test.ts src/send.test.ts
```

Expected — the six new cases green, and the nine existing ones untouched:

```
send.test.ts:
(pass) sendMail, log driver > writes the recipient, the subject and both bodies where they can be read
(pass) sendMail, log driver > marks the output as not sent, so a log reader cannot mistake it for delivery
(pass) sendMail, log driver > performs no request
(pass) sendMail, resend driver > posts the message to the Resend endpoint
(pass) sendMail, resend driver > authenticates as a bearer token and sends JSON
(pass) sendMail, resend driver > passes the idempotency key as a header, so a retry cannot deliver twice
(pass) sendMail, resend driver > throws with the status and the response body, which the worker records
(pass) sendMail, resend driver > does not put the API key in the error it throws
(pass) sendMail, resend driver > refuses to run without an API key rather than degrading to stdout

send.timeout.test.ts:
(pass) sendMail, resend request budget > bounds the request with an abort signal
(pass) sendMail, resend request budget > aborts a request the provider never answers [~20ms]
(pass) sendMail, resend request budget > aborts a response whose headers arrived and whose body never ends [~20ms]
(pass) sendMail, resend request budget > leaves a failure that is not a timeout carrying its own message
(pass) sendMail, resend request budget > does not put the API key in the timeout error [~20ms]
(pass) sendMail, resend request budget > ships a budget the worker can still drain inside

 15 pass
 0 fail
```

The three ~20ms lines are the proof: each is a stall that ended on its own budget. A missing or unused signal shows up as those tests sitting until bun:test's 5s per-test timeout kills them.

- [x] **Step 6: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful; `check-naming` exits 0, prints `check-naming: <n> suites and their helpers are named and placed to convention.` and counts `packages/mail/src/send.timeout.test.ts` among them — the count itself is whatever the tree holds and is not an acceptance criterion, because every later plan that adds a suite moves it. `check-rules` exits 0; migrations match. `send.ts` grows to roughly 165 lines of which about 80 are code — well inside the 200-line cap — and `send.timeout.test.ts` lands near 160 lines with about 120 of code.

- [x] **Step 7: Commit**

```bash
git add packages/mail/src/send.ts packages/mail/src/send.timeout.test.ts
git commit -m "fix(mail): the Resend call could not be ended by anything

The \`fetch\` to Resend carried no \`signal\`, so the only thing that could end a
send was the network. That is not one slow message: the worker runs a claimed
batch one job at a time — \`runOnce\` says so in a \`noAwaitInLoops\` exemption —
so a socket the provider never answers stops \`ai.generate\` and every future
kind with it. The drain then cannot finish either, the 10s deadline fires,
\`process.exit(1)\` takes the process, and the row is left \`running\`.

Eight seconds, as a constant in the package rather than an environment key.
@keel/ai made the same call for the same reason: this package reads no
environment, and a socket budget is not a decision worth making every
deployment name in order to boot. It sits under the worker's drain deadline on
purpose, so one hung send cannot by itself force the kill.

The budget covers the body, not just the request. Measured against a live
\`Bun.serve\` that returned 403 headers and then held its body stream open
forever: the fetch's own signal errors that stream, so \`response.text()\` — the
file's only body read, and it is on the failure path, which is exactly the path
a provider under stress takes — rejects on the same budget. One signal, created
once; a second would restart the clock after headers and grant twice the time.

An abort throws rather than resolving, so \`runJob\` records it and reschedules.
It throws a named error rather than the DOMException, whose entire message is
\"The operation timed out.\" — \`job.last_error\` is all an operator gets, so it
names Resend, the budget, and the fact that the Idempotency-Key makes the retry
safe. Nothing else is reclassified: a refused connection keeps its own message.

Verified: a stub that never answers fails the send in 20ms, a 403 whose body
never ends fails the same way, a connection refusal still reads \"Unable to
connect\", and the nine existing send cases are unchanged. 15 pass, 0 fail in
the mail package; \`bun run check\` green with 34 suites."
```

*(The message above is `a6f6e47` verbatim. Its "34 suites" was the count on the tree that commit was made against; `check-naming` prints 51 at HEAD, because the number moves with every plan that lands a suite. What the commit actually proved is that `send.timeout.test.ts` is counted and the checker exits 0.)*

---

## Done when

- `packages/mail/src/send.ts` passes an `AbortSignal` on the Resend `fetch`, and that same signal — not a second one — is what bounds the `response.text()` read on the non-OK path.
- A Resend call that never answers rejects after `RESEND_TIMEOUT_MS`, and so does one whose headers arrive and whose body never completes.
- The rejection is an `Error` whose message contains `Resend` and the budget in milliseconds, and does not contain the API key. `runJob`'s existing catch therefore records it and reschedules the job with no change to `apps/server`.
- A failure that is not an abort — a refused connection, a non-OK status — reaches the caller with its original message, unwrapped.
- `RESEND_TIMEOUT_MS` is strictly less than the worker's 10 000 ms drain deadline, and a test says so.
- No environment key was added, and `.env.example`, `apps/server/.env`, `.env.test` and `docker-compose.prod.yml` are untouched.
- `bun run check` is green; `check-naming` exits 0 and counts `send.timeout.test.ts` as a suite. (The suite total the checker prints is deliberately not pinned here: it moves with every plan that lands a suite.)

## Out of scope

- **The stranded `running` row after a hard kill.** CORR-01, plan 011. This plan makes the common case stop producing them; it does not recover the ones a SIGKILL leaves behind.
- **Settlement failure classified as work failure.** CORR-02, plan 010.
- **Testing the worker loop, drain and poll-failure paths.** TEST-04/05, plan 016. This plan asserts the relationship between the mail budget and `SHUTDOWN_DEADLINE_MS` from the mail side only, with the deadline duplicated as a local constant because a package may not import from `apps/`.
- **A timeout for any other outbound call.** `@keel/ai` already has one; `@keel/storage` presigns URLs locally and issues no request of its own.
- **`MAIL_DRIVER=log` in production.** SEC-04, a separate plan — a different failure of the same file, with a different fix and a different test.
- **The audit's stale line citations.** Corrected here for PERF-01 only; `plans/audit-report.md` is not edited, and README/AGENTS.md housekeeping belongs to plan 021.
