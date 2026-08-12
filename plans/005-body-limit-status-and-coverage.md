# Body-Limit Status and Coverage Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** CORR-06 (`plans/audit-report.md:151-156`), TEST-08 (`plans/audit-report.md:255-261`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Goal:** Make an oversized request body answer `413 Payload Too Large` — the status `apps/server/src/index.ts:26` already promises — declare it on the frozen `/v1` write route, and put the two genuinely untested parts of `apps/server/src/lib/security.ts` under test.

**Architecture:** Three files disagree about one status. `security.ts:53` throws `badRequest(...)`, which is 400. `index.ts:26` says the middleware "produces a diagnosable 413". The frozen `/v1` POST contract declares neither. The fix is a `PAYLOAD_TOO_LARGE` entry in `packages/http/src/status.ts`, a `payloadTooLarge` factory beside the other factories in `packages/http/src/errors.ts`, **a matching entry in `ERROR_CODE_BY_STATUS` in `packages/http/src/response.ts` — without which the new status is masked as a 500** — and one added `responses` key on `createProjectRoute`. The coverage half is one new suite, `apps/server/src/lib/security.test.ts`, driving the real `app`.

**Tech Stack:** Bun, bun:test, Hono 4.13.1 (`hono/body-limit`, `hono/secure-headers`), `@hono/zod-openapi`, evlog 2.24.0 (`createError` / `parseError`), zod.

---

## Verified evidence (do not re-litigate)

**CORR-06 is CONFIRMED, and it is a three-way inconsistency.**

1. `apps/server/src/lib/security.ts:50-57` is the middleware, and its rejection is a 400:

   ```ts
   export const requestBodyLimit = bodyLimit({
   	maxSize: env.BODY_LIMIT_BYTES,
   	onError: () => {
   		throw badRequest(
   			`Request body exceeds the ${env.BODY_LIMIT_BYTES} byte limit`
   		);
   	},
   });
   ```

   `badRequest` is `packages/http/src/errors.ts:61-68`, and it carries `status: status.BAD_REQUEST` — 400 (`packages/http/src/status.ts:12`).

2. `apps/server/src/index.ts:22-27` promises the opposite, in a comment explaining why Bun's socket ceiling is deliberately loose:

   ```ts
   	// Socket-level backstop under `requestBodyLimit`. Hono's bodyLimit rejects with
   	// the standard envelope but only after the framework has begun reading; this
   	// ceiling is enforced before that, and without it Bun's default is 128 MB.
   	// Deliberately looser than BODY_LIMIT_BYTES so the middleware — which produces
   	// a diagnosable 413 rather than a dropped socket — stays the one that fires.
   	maxRequestBodySize: env.BODY_LIMIT_BYTES * 2,
   ```

3. The frozen contract declares neither 400 nor 413. `apps/server/src/modules/projects/public/projects.v1.routes.ts:92-105` lists exactly `CREATED, UNAUTHORIZED, FORBIDDEN, CONFLICT, UNPROCESSABLE_ENTITY, TOO_MANY_REQUESTS`, and `projects.v1.routes.contract.test.ts:58` pins that list as `["201", "401", "403", "409", "422", "429"]`.

4. **The middleware genuinely reaches `/v1`.** `apps/server/src/app.ts:117` is `app.use("*", requestBodyLimit)`, and the route mounts are below it at `app.ts:163-166`. It also runs *before* `requireUser`, which is mounted inside the surface at `projects.v1.routes.ts:145` — so an oversized body is rejected without a session, which is what makes Task 2's test database-free.

5. The audit's "minor today" framing is right about the mechanism: `env.BODY_LIMIT_BYTES * 2` means Bun's socket ceiling never fires first, so the middleware is the thing that answers. The status it answers with is the whole problem.

**The trap the audit does not mention.** `packages/http/src/response.ts:177-183` is the only translation from a thrown error to a response:

```ts
	const known =
		parsed.status in ERROR_CODE_BY_STATUS
			? (parsed.status as ErrorStatus)
			: status.INTERNAL_SERVER_ERROR;
```

`ERROR_CODE_BY_STATUS` (`response.ts:24-34`) does not contain 413. Throwing a 413 without adding it there produces a **500 with the message "Something went wrong"** (`response.ts:185-193`) — strictly worse than today's 400. Task 1 makes this failure visible before it fixes it.

**TEST-08 is PARTIAL. Two of its three sub-claims are already covered; do not chase them.**

- *"the masked-500 promise is enforced only by a fixture in `packages/http`"* — **wrong.** `apps/server/src/lib/idempotency.test.ts:115-128` drives a handler that really throws (`idempotency.test.ts:37-39`) to a 500 through an `onError` wired to the identical one-liner `app.ts:171` uses: `app.onError((error, c) => failure(c, error))` (`idempotency.test.ts:43`). It asserts `first.status` and `retry.status` are both 500. The route-level proof the audit asks for exists.
- *"`security.ts` is untested"* — **half wrong.** `apiSecurityHeaders` is asserted through the real app at `apps/server/src/app.test.ts:93-101`: `default-src 'none'`, `x-frame-options: DENY`, `x-content-type-options: nosniff`.
- What is genuinely untested is **exactly two things**: `requestBodyLimit`'s rejection path, and `referenceSecurityHeaders` (`security.ts:29-40`). That is Task 2's whole scope.

**Facts established by reading the installed dependencies, not by assumption:**

- `hono/body-limit` (`node_modules/.bun/hono@4.13.1/.../middleware/body-limit/index.js:13-33`) returns `next()` immediately when `c.req.raw.body` is absent — a GET is never rejected — then takes the `content-length` shortcut only when that header is present, and otherwise streams and counts.
- `new Request(url, { body: "…" })` under Bun sets **no** `content-length` header (`bun -e '[...new Request("http://x/",{method:"POST",body:"a".repeat(1000)}).headers]'` prints `[]`). `app.request` builds exactly such a Request, so the test in Task 2 exercises the streaming branch and needs a genuinely oversized body.
- `auth.api.getSession` returns `null` before any query when no session cookie is present (`better-auth@1.6.25/.../api/routes/session.mjs:44-45`). A cookie-less request through the real `app` touches no database.
- `secureHeaders` applies its headers **after** `await next()` (`.../secure-headers/secure-headers.js:82-88`), and serialises the CSP in the object's own key order with `; ` between directives (`:98-118`). `/reference` is registered at `app.ts:48-52`, above `app.use("*", apiSecurityHeaders)` at `app.ts:56`, and Scalar's handler returns without calling `next`, so the reference page carries only its own policy.
- `evlog`'s `createError` accepts any numeric `status`, and `parseError` returns `{ message, status, code?, why?, fix?, link?, raw }` — so `code` and `status` round-trip through `failure` unchanged.
- `tools/gen-module.ts` scaffolds only a list and a get route for `/v1` (no `method: "post"` anywhere in the file), so no generator template needs the new status.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, 16 architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`; comment lines and multi-line template literal interiors do not count, blank lines do). Measured before this plan: `packages/http/src/response.ts` ≈ 155, `errors.ts` ≈ 76, `status.ts` ≈ 19, `security.ts` ≈ 36, `projects.v1.routes.ts` ≈ 131, and **`projects.v1.routes.contract.test.ts` ≈ 187** — that last one is why Task 1 extends an existing table there instead of adding an `it` block. Test files are not exempt from the rule.
- **No environment variable gets a default.** This plan adds no key. `BODY_LIMIT_BYTES` already exists and is already required in all four places (`packages/env/src/server.ts:51`, `.env.example:84`, `.env.test:42`, `docker-compose.prod.yml:41`). Do not give it a `??`, and do not read it through `process.env`.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts`; test doubles are `<subject>.fixtures.ts` inside `src/`. `tools/check-naming.ts` enforces both. The new suite is therefore `apps/server/src/lib/security.test.ts`, beside `security.ts`.
- Tests live beside the code, never in `__tests__`. Integration suites gate on `testDbReady()` from `apps/server/test-db.ts` — neither suite here is one, because neither touches the database. Never mock Drizzle. Never test Hono itself.
- Never build a response by hand with `c.json`. The GritQL plugin `tools/biome-plugins/no-direct-json.grit` fails the build for it outside `packages/http/src`. An error travels as a thrown value and is rendered once, by `failure`.
- `/v1/*` is the frozen customer contract and the only surface in the OpenAPI document at `/doc`; every status an operation can return must be declared on its `createRoute` and mirrored in `projects.v1.routes.contract.test.ts`.
- This plan owns `apps/server/src/lib/security.ts`. No other plan may edit it; if you need something else from that file, it belongs here.

## Do not

- **Do not "fix" this by declaring 400 on the v1 POST route.** That makes the contract honest about a status the code's own comment calls wrong, and leaves `index.ts:26` a lie. 413 is the status HTTP defines for this, the status Hono's own default emits, and the one already written down.
- **Do not skip the `ERROR_CODE_BY_STATUS` entry in `packages/http/src/response.ts`.** Adding `PAYLOAD_TOO_LARGE` to `status.ts` and `errors.ts` alone silently downgrades the response to a masked 500 (`response.ts:180-193`). Task 1 Step 5 exists to show you this happening.
- **Do not return a `Response` from `bodyLimit`'s `onError`.** The `throw` is deliberate: `app.onError` is the single translation to the envelope (`app.ts:171`), and a hand-built response there would be the one failure in the app that does not carry a `requestId`. `security.ts:47-48` says so.
- **Do not lower `maxRequestBodySize` in `apps/server/src/index.ts`.** The `* 2` is what keeps the middleware — not Bun's socket — the thing that answers. Making them equal replaces a diagnosable envelope with a dropped connection.
- **Do not declare 413 on the GET operations.** `bodyLimit` returns `next()` when there is no body, so a GET cannot reach it. A status declared but unreachable is the same defect as one reachable but undeclared, pointing the other way.
- **Do not add a new `it` block to `projects.v1.routes.contract.test.ts`.** At ≈187 code lines it is 13 from the cap. The expectation belongs in the existing `it.each` table at line 56-63, which costs zero lines.
- **Do not gate `security.test.ts` on `testDbReady()`.** Neither the body-limit path nor `/reference` reaches Postgres, and a needless gate turns a real failure into a silent skip on a machine with no database.

## File structure

| File | Responsibility |
|---|---|
| `packages/http/src/status.ts:19-20` | **Modify.** Add `PAYLOAD_TOO_LARGE: 413`, which also widens `ErrorCode`. |
| `packages/http/src/errors.ts:68-70` | **Modify.** Add the `payloadTooLarge` factory beside the others. |
| `packages/http/src/response.ts:29-30` | **Modify.** Teach `failure` that 413 is a known status, not a masked 500. |
| `packages/http/src/response.fixtures.ts:33-34` | **Modify.** A route that throws the new error, so the translation is testable. |
| `packages/http/src/response.failure.test.ts:19-20` | **Modify.** Pin the translation: 413 out, not 500. |
| `apps/server/src/lib/security.ts:2,52-56` | **Modify.** Throw `payloadTooLarge` instead of `badRequest`. |
| `apps/server/src/modules/projects/public/projects.v1.routes.ts:99-100` | **Modify.** Declare 413 on the one `/v1` write route. |
| `apps/server/src/modules/projects/public/projects.v1.routes.contract.test.ts:58` | **Modify.** Add `"413"` to the POST row. |
| `apps/server/src/lib/security.test.ts` | **Create.** The body-limit rejection path and `referenceSecurityHeaders`, through the real app. |

---

### Task 1: 413, end to end, and declared

**Files:**
- Modify: `packages/http/src/status.ts:19-20`
- Modify: `packages/http/src/errors.ts:68-70`
- Modify: `packages/http/src/response.ts:29-30`
- Modify: `packages/http/src/response.fixtures.ts:33-34`
- Modify: `packages/http/src/response.failure.test.ts:19-20`
- Modify: `apps/server/src/lib/security.ts:2,52-56`
- Modify: `apps/server/src/modules/projects/public/projects.v1.routes.ts:99-100`
- Modify: `apps/server/src/modules/projects/public/projects.v1.routes.contract.test.ts:58`

**Interfaces:**
- Consumes: `createError` from `evlog`; `status` from `packages/http/src/status.ts`; `problemContent(schema, description)` from `@keel/http/openapi`; `errorSchema` from `@keel/http/envelope` — both already imported by `projects.v1.routes.ts:2-8`.
- Produces: `status.PAYLOAD_TOO_LARGE = 413` and the `ErrorCode` member `"PAYLOAD_TOO_LARGE"`; `payloadTooLarge(limitBytes: number): EvlogError` exported from `@keel/http/errors`; `requestBodyLimit` rejecting with 413. Task 2 asserts all three through the real app.

^- [x] **Step 1: Write the failing test**

First the double. In `packages/http/src/response.fixtures.ts`, extend the error import at line 3 and add one route to `testApp`. The import becomes:

```ts
import { notFound as notFoundError, payloadTooLarge } from "./errors";
```

And insert the route after the `/bad-request` line (`response.fixtures.ts:33`), before `.get("/thrown-not-found", …)`:

```ts
	.get("/oversized", () => {
		throw payloadTooLarge(1024);
	})
```

Then the test. In `packages/http/src/response.failure.test.ts`, insert this block after the `unexpected failures` describe (which ends at line 19), before the `wide event severity` comment at line 21:

```ts
// 413 is thrown by `requestBodyLimit` in apps/server, and `failure` maps a
// thrown status to a response through one table. A status missing from that
// table is not a passthrough — it is silently rewritten to 500 and its message
// replaced, which is a worse answer than the 400 this replaced.
describe("a status the app throws", () => {
	it("renders 413 as itself rather than masking it as a 500", async () => {
		const response = await testApp.request("/oversized");
		const body = errorSchema.parse(await response.json());

		expect(response.status).toBe(413);
		expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
		expect(body.status).toBe(413);
		expect(body.title).toBe("Payload too large");
		expect(body.type).toBe("https://keel.dev/errors/payload-too-large");
		expect(body.error.why).toContain("1024");
	});
});
```

^- [x] **Step 2: Run it and watch it fail for the right reason**

```bash
cd packages/http && bun test src/response.failure.test.ts
```

Expected: the file never runs a test. Bun aborts while linking the fixture, with `SyntaxError: Export named 'payloadTooLarge' not found in module '<repo>/packages/http/src/errors.ts'`. If instead you see an assertion failure, the factory already exists and you are not on `39fd32c` — stop and re-read `errors.ts`.

^- [x] **Step 3: Add the status constant**

In `packages/http/src/status.ts`, the object is alphabetical by key. Insert between `OK: 200,` (line 19) and `SERVICE_UNAVAILABLE: 503,` (line 20):

```ts
	PAYLOAD_TOO_LARGE: 413,
```

`ErrorCode` is `keyof typeof status` (`status.ts:27`), so this is also what makes `"PAYLOAD_TOO_LARGE"` a legal code everywhere else.

^- [x] **Step 4: Add the factory**

In `packages/http/src/errors.ts`, insert after `badRequest` (which ends at line 68) and before the `serviceUnavailable` doc block at line 70. Key order inside `createError` is alphabetical, matching every factory above it:

```ts
/**
 * The body is larger than this deployment accepts. Distinct from a 400: the
 * request is not malformed, and distinct from a 422: nothing about its contents
 * was read, let alone rejected. The caller is being told a size, so the size is
 * in the message — an error that says "too large" without saying "than what"
 * leaves them guessing at a number only the server knows.
 *
 * `BODY_LIMIT_BYTES` is a deployment's own setting, so this is a limit the
 * caller can ask to have raised rather than a fact about the protocol.
 */
export const payloadTooLarge = (limitBytes: number) =>
	createError({
		code: "PAYLOAD_TOO_LARGE",
		fix: `Send at most ${limitBytes} bytes, or split the payload across several requests`,
		message: "Request body too large",
		status: status.PAYLOAD_TOO_LARGE,
		why: `The request body exceeds the ${limitBytes} byte limit this deployment accepts`,
	});
```

^- [x] **Step 5: Run it again and watch it fail differently — this is the trap**

```bash
cd packages/http && bun test src/response.failure.test.ts
```

Expected: the suite now links, and the new test fails on its first assertion:

```
error: expect(received).toBe(expected)

Expected: 413
Received: 500
```

The error is thrown correctly and rendered wrongly. `failure` looks the status up in `ERROR_CODE_BY_STATUS` (`packages/http/src/response.ts:180-183`), does not find 413, and takes the mask branch — so the body is `INTERNAL_SERVER_ERROR` / "Something went wrong", and the real message is dropped. Do not proceed until you have seen this output: it is the difference between fixing the status and making it worse.

^- [x] **Step 6: Teach `failure` the status**

In `packages/http/src/response.ts`, the table at lines 24-34 is ordered by status ascending, with 500 kept last. Insert between `[status.CONFLICT]: "CONFLICT",` (line 29) and `[status.UNPROCESSABLE_ENTITY]: "UNPROCESSABLE_ENTITY",` (line 30):

```ts
	[status.PAYLOAD_TOO_LARGE]: "PAYLOAD_TOO_LARGE",
```

^- [x] **Step 7: Run the test and watch it pass**

```bash
cd packages/http && bun test src/response.failure.test.ts
```

Expected: `7 pass, 0 fail` — the six that were already there, plus the new one.

^- [x] **Step 8: Point the middleware at it**

In `apps/server/src/lib/security.ts`, replace the import at line 2:

```ts
import { payloadTooLarge } from "@keel/http/errors";
```

and the rejection at lines 52-56:

```ts
	onError: () => {
		throw payloadTooLarge(env.BODY_LIMIT_BYTES);
	},
```

The doc comment at lines 42-49 stays exactly as it is — it describes the envelope, which has not changed. `badRequest` remains exported and in use elsewhere (`apps/server/src/lib/idempotency.ts:70`, `packages/http/src/response.ts:144-146`); do not remove it.

The behavioural proof of this step runs through the real app in Task 2. What proves it here is the typecheck in Step 11.

^- [x] **Step 9: Make the contract test red**

In `apps/server/src/modules/projects/public/projects.v1.routes.contract.test.ts`, the table at lines 56-59 lists the declared statuses per operation. Change only the POST row (line 58) — the keys of an OpenAPI `responses` object are integer-like, so JavaScript enumerates them in ascending numeric order and 413 sits between 409 and 422:

```ts
		["POST /v1/projects", ["201", "401", "403", "409", "413", "422", "429"]],
```

Then run it:

```bash
cd apps/server && bun test src/modules/projects/public/projects.v1.routes.contract.test.ts
```

Expected: `25 pass, 1 fail`. The failure is `the published v1 contract > POST /v1/projects is behind the session and declares its statuses`, reporting a received array of `["201", "401", "403", "409", "422", "429"]` against the expected array above — the document does not yet declare 413.

^- [x] **Step 10: Declare it on the route, and watch the test pass**

In `apps/server/src/modules/projects/public/projects.v1.routes.ts`, add the response to `createProjectRoute`'s `responses` map. Insert after the `CONFLICT` entry (lines 96-99) and before `UNPROCESSABLE_ENTITY` (line 100):

```ts
		[status.PAYLOAD_TOO_LARGE]: problemContent(
			errorSchema,
			"The body is larger than this deployment's BODY_LIMIT_BYTES"
		),
```

`status`, `problemContent` and `errorSchema` are already imported at lines 2-8; add nothing to the imports. Leave `listProjectsRoute` and `getProjectRoute` untouched — a request with no body never reaches the limiter.

```bash
cd apps/server && bun test src/modules/projects/public/projects.v1.routes.contract.test.ts
```

Expected: `26 pass, 0 fail`. The second test in that file — `POST /v1/projects serves failures as problems` — now also covers 413 and confirms it is published as `application/problem+json` like every other failure.

^- [x] **Step 11: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful, `check-naming` still reporting 33 suites (this task adds no suite file), 16 architecture rules verified, migrations match.

^- [x] **Step 12: Commit**

```bash
git add packages/http/src/status.ts packages/http/src/errors.ts packages/http/src/response.ts packages/http/src/response.fixtures.ts packages/http/src/response.failure.test.ts apps/server/src/lib/security.ts apps/server/src/modules/projects/public/projects.v1.routes.ts apps/server/src/modules/projects/public/projects.v1.routes.contract.test.ts
git commit -m "fix(http): an oversized body is a 413, and the contract says so

Three files disagreed about one status. \`requestBodyLimit\` threw
\`badRequest\` — 400. \`apps/server/src/index.ts\` justifies leaving Bun's socket
ceiling at twice the limit on the grounds that the middleware 'produces a
diagnosable 413 rather than a dropped socket'. The frozen v1 POST contract
declared neither, so the one status an oversized write could actually receive
was the one status no consumer was told about.

413 is the honest answer: the request is not malformed, and nothing in it was
read, let alone rejected. \`payloadTooLarge\` carries the byte limit in both
\`why\` and \`fix\`, because a caller cannot act on 'too large' without the
number, and the number is a deployment's own setting.

The entry in \`ERROR_CODE_BY_STATUS\` is the part that is easy to miss and the
part that matters. \`failure\` maps a thrown status through that one table and
rewrites anything absent from it to a masked 500 — so throwing the new error
without listing it there would have replaced a wrong-but-accurate 400 with
'Something went wrong'. Seen happening before it was fixed, and pinned by a
fixture route that throws it through the same wiring apps/server uses.

Adding a response to a frozen operation is additive: a consumer that had no
413 branch was already receiving an undeclared status for that request. The
list only grows here — removing one is what breaks an SDK. Only the write
route declares it; \`bodyLimit\` returns early when a request has no body, so a
declared 413 on either GET would be unreachable."
```

---

### Task 2: The two untested parts of `security.ts`

**Files:**
- Create: `apps/server/src/lib/security.test.ts`

**Interfaces:**
- Consumes: Task 1's wiring end to end — `payloadTooLarge`, the `ERROR_CODE_BY_STATUS` entry, and `security.ts` throwing it. This task is where Task 1 Step 8 is actually proven; the assertions below fail against `39fd32c`. Also `createClient(): TestClient` and `ErrorEnvelope` from `apps/server/test-http.ts:7-24`, `app` from `@/app`, and `env.BODY_LIMIT_BYTES` from `@keel/env/server`.
- Produces: nothing importable. It is a leaf suite.

^- [ ] **Step 1: Write the failing test**

Create `apps/server/src/lib/security.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { env } from "@keel/env/server";
import { app } from "@/app";
import { createClient, type ErrorEnvelope } from "../../test-http";

/**
 * Both halves are driven through the real `app`, not a throwaway Hono, because
 * both are facts about where the middleware sits. `requestBodyLimit` is mounted
 * at `app.ts:117`, above every route and above `requireUser`; the reference
 * page's policy only holds because `/reference` is registered above
 * `app.use("*", apiSecurityHeaders)`. A local app would assert the middleware
 * and prove nothing about the wiring, which is the part that can regress.
 *
 * No `testDbReady()` gate: neither path reaches Postgres. The oversized request
 * is rejected before any guard runs, and a cookie-less session lookup returns
 * null without a query.
 */
describe("requestBodyLimit", () => {
	// Bun does not set content-length on a Request built from a string body, so
	// hono's bodyLimit takes its streaming branch and counts bytes. That is the
	// branch a real client over a socket also hits when it uses chunked
	// encoding, and it is why this needs a genuinely oversized body rather than
	// a spoofed header.
	const oversized = "x".repeat(env.BODY_LIMIT_BYTES);

	it("answers an oversized write with 413 in the standard envelope", async () => {
		const client = createClient();

		const response = await client.post("/v1/projects", {
			name: oversized,
			slug: "billing",
		});
		const body = await client.body<ErrorEnvelope>(response);

		expect(response.status).toBe(413);
		expect(response.headers.get("content-type")).toContain(
			"application/problem+json"
		);
		expect(body.error.code).toBe("PAYLOAD_TOO_LARGE");
		expect(body.error.why).toContain(String(env.BODY_LIMIT_BYTES));
		expect(body.error.requestId).toBeString();
	});

	// Mounted above `requireUser`, so the limit is not something a caller can
	// spend a session's worth of work getting past. A 401 here would mean the
	// guard ran first and an unauthenticated client could still make the server
	// buffer the whole body.
	it("rejects before the session guard, so no credentials are needed", async () => {
		const client = createClient();

		const body = await client.body<ErrorEnvelope>(
			await client.post("/v1/projects", { name: oversized, slug: "billing" })
		);

		expect(body.error.code).not.toBe("UNAUTHORIZED");
	});

	// The complement: the limiter is not simply refusing every write. An
	// ordinary body reaches the guard and gets the guard's answer.
	it("lets a body under the limit through to the route", async () => {
		const client = createClient();

		const response = await client.post("/v1/projects", {
			name: "Billing",
			slug: "billing",
		});

		expect(response.status).toBe(401);
	});
});

/**
 * `/reference` is the one HTML page this API serves, and Scalar renders it
 * client-side from jsDelivr. Under the API's own `default-src 'none'` it loads
 * a blank page — a failure nothing else here would catch, because the response
 * is still a 200 with a correct-looking body.
 */
describe("referenceSecurityHeaders", () => {
	it("serves the reference page the exact policy Scalar needs", async () => {
		const response = await app.request("/reference");

		expect(response.status).toBe(200);
		expect(response.headers.get("content-security-policy")).toBe(
			"connect-src 'self'; default-src 'none'; font-src 'self' https://cdn.jsdelivr.net data:; img-src 'self' https://cdn.jsdelivr.net data:; script-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'; style-src 'self' https://cdn.jsdelivr.net 'unsafe-inline'"
		);
		expect(response.headers.get("x-frame-options")).toBe("DENY");
		expect(response.headers.get("strict-transport-security")).toBe(
			"max-age=31536000; includeSubDomains"
		);
	});

	// The allowance is written out per route rather than loosened globally, and
	// this is the assertion that keeps it that way: exactly one path may name
	// the CDN.
	it("does not leak the CDN allowance onto the JSON surface", async () => {
		const response = await app.request("/");

		expect(response.headers.get("content-security-policy")).not.toContain(
			"cdn.jsdelivr.net"
		);
	});
});
```

^- [ ] **Step 2: Run it and watch it fail for the right reason**

```bash
cd apps/server && bun test src/lib/security.test.ts
```

Expected: `5 pass, 0 fail` if Task 1 is committed. To confirm the first test would have caught the original bug, temporarily revert `security.ts:53` to `throw badRequest(env.BODY_LIMIT_BYTES.toString())` and re-run:

```
error: expect(received).toBe(expected)

Expected: 413
Received: 400
```

Restore Task 1's line before continuing — `git checkout apps/server/src/lib/security.ts`.

- [ ] **Step 3: Run the whole server suite**

```bash
cd apps/server && bun test
```

Expected: every existing suite still green, five more tests than the run before this task. Nothing here mounts middleware or touches shared state, so no other suite's counts move.

- [ ] **Step 4: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful, `check-naming` reporting **34** suites — one more than Task 1's run, because `security.test.ts` is a new suite named to convention beside the module it covers. 16 architecture rules verified, migrations match.

- [ ] **Step 5: Commit**

```bash
git add apps/server/src/lib/security.test.ts
git commit -m "test(server): cover the body limit and the reference page policy

Two of \`security.ts\`'s three exports were already asserted through the real
app — \`apiSecurityHeaders\` in app.test.ts, and the masked 500 the audit
attributed to a packages/http fixture is in fact driven end to end by
idempotency.test.ts. The two that were not are the ones with a failure mode
nobody would notice.

The body-limit rejection is now pinned at 413 with the byte limit in the
message, and pinned as happening before \`requireUser\` — the ordering is the
point of mounting it where it is mounted, and nothing else in the suite would
notice if it moved below the guard and started letting unauthenticated callers
buffer a megabyte first. The oversized body is real rather than a spoofed
content-length: Bun sets no such header on a Request built from a string, so
this exercises the branch that counts bytes as they stream.

\`referenceSecurityHeaders\` is asserted as a whole policy string. Scalar
renders from jsDelivr, so the reference page under the API's own
\`default-src 'none'\` is a blank page served as a 200 with a plausible body —
there is no status, no log line and no exception to notice. The paired
assertion that the JSON surface never names the CDN is what keeps the
allowance scoped to the one route that needs it.

Driven through the real app, and no database gate: an oversized body is
refused before any guard runs, and a cookie-less session lookup returns null
without a query."
```

---

## Done when

- A POST to `/v1/projects` with a body over `BODY_LIMIT_BYTES` returns `413`, `content-type: application/problem+json`, `error.code: "PAYLOAD_TOO_LARGE"`, and a `why` naming the byte limit.
- `/doc` declares `413` on `POST /v1/projects`, as a `application/problem+json` response, and on no other operation.
- `projects.v1.routes.contract.test.ts` expects `["201", "401", "403", "409", "413", "422", "429"]` for that operation and passes.
- The comment at `apps/server/src/index.ts:26` is a true statement about the code.
- `packages/http/src/response.failure.test.ts` fails if `PAYLOAD_TOO_LARGE` is removed from `ERROR_CODE_BY_STATUS`.
- `apps/server/src/lib/security.test.ts` exists, passes with no database running, and fails if `requestBodyLimit` moves below `requireUser` or if `/reference` loses its own policy.
- `bun run check` is green and `check-naming` reports 34 suites.

## Out of scope

- **The `/api` surface.** `requestBodyLimit` is mounted at `app.ts:117` for `"*"`, so `/api/*` returns the new 413 too. Nothing needs declaring there: `internalProjectRoutes` is a plain Hono, absent from the OpenAPI document by construction (`app.ts:148-150`), and `/api` is unversioned and moves with the frontend. Changing a status on that surface costs a frontend change and no more.
- **Why adding a status to a frozen contract is allowed at all.** A contract's promise is "these are the statuses you may see". Adding one narrows nothing a consumer already relies on: their success path is unchanged, their existing error branches still match, and a generated SDK gains a case for a response it would otherwise have had to fall through on. Removing one is the breaking direction — it tells the generator to drop a branch the server can still take, so a consumer stops handling a response that still arrives. The status *change* here (400 → 413) is safe for the same reason the addition is: the 400 was never declared on `/v1`, so no consumer could have coded against it and still claimed to be following the contract.
- **The undeclared 400 that remains on `POST /v1/projects`.** `idempotent` is mounted at `projects.v1.routes.ts:160`, and `apps/server/src/lib/idempotency.ts:69-73` throws `badRequest` for an `Idempotency-Key` that is empty or over the length cap. That is a second undeclared status on the frozen operation, with the same shape as this finding. Plan 012 owns `idempotency.ts` and should either declare it or stop emitting it; deliberately not folded in here, because it is a different middleware with a different right answer.
- **`tools/gen-module.ts`.** It scaffolds no `/v1` write route (no `method: "post"` in the file — verified), so there is no generated `responses` map to keep in step. Its coverage gaps are TEST-09, owned by plan 015.
- **A route-level masked-500 test.** The audit asks for one; `apps/server/src/lib/idempotency.test.ts:115-128` already is one, through the same `failure(c, error)` wiring `app.ts:171` uses. Adding a second would be duplicate coverage of the repo's most-covered path.
- **`apiSecurityHeaders`.** Already asserted through the real app at `apps/server/src/app.test.ts:93-101`. Task 2's second `it` only adds the negative claim that the CDN allowance stays off that surface.
- **Bun's `maxRequestBodySize`.** The `* 2` ceiling at `apps/server/src/index.ts:27` is correct and this plan depends on it. Any change to it belongs with a plan that also decides what a socket-level rejection should look like to a client, which is not this one.
- **New environment keys.** None are added. `BODY_LIMIT_BYTES` already exists in all four required places; plan 019 owns `docker-compose.prod.yml`'s `x-app-env` list if that ever changes.
