# Client-IP Posture Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** SEC-03 (`plans/audit-report.md:59-65`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Goal:** Refuse to start the API in production when Better Auth cannot tell two callers apart, and delete the four places where the repository tells its operator that an unset `TRUSTED_IP_HEADER` is coarse but unforgeable — which is false.

**Architecture:** Two of these are one problem seen from two sides. Better Auth's `getIp` reads `x-forwarded-for` by *default*, before any keel configuration, so the "leave it unset and everyone shares one bucket" posture the repo documents does not exist: on a directly reachable deployment a caller supplies its own `X-Forwarded-For` and gets a private bucket, and a caller that varies it has no credential limit at all. Behind a proxy that *appends*, the header holds two addresses, resolves to nothing, and the whole user base really does share one bucket per path. Both ends are bad and neither is refused today. The fix is a `resolve*` guard in the repo's existing style — `apps/server/src/lib/client-ip.ts`, called from the API entrypoint — plus honest comments where the false claim is written down.

**Tech Stack:** Bun, better-auth 1.6.25 (`@better-auth/core` 1.6.25), `@keel/env` (zod 4 + `@t3-oss/env-core`), bun:test.

---

## Verified evidence (do not re-litigate)

Everything below was read out of the working tree at `39fd32c`, including the installed dependency. Where it contradicts `plans/audit-report.md`, this section is the ground truth.

**1. The compose file does ship both keys empty.** `docker-compose.prod.yml:63-64`, inside the `x-app-env` anchor that also sets `NODE_ENV: production` at line 51:

```yaml
  TRUSTED_IP_HEADER: ${TRUSTED_IP_HEADER:-}
  TRUSTED_PROXIES: ${TRUSTED_PROXIES:-}
```

`packages/env/src/server.ts:27` sets `emptyStringAsUndefined: true`, so both arrive as `undefined`. `packages/auth/src/index.ts:71-80` then spreads nothing:

```ts
			...(env.TRUSTED_IP_HEADER
				? {
						ipAddress: {
							ipAddressHeaders: [env.TRUSTED_IP_HEADER],
							...(env.TRUSTED_PROXIES
								? { trustedProxies: env.TRUSTED_PROXIES }
								: {}),
						},
					}
				: {}),
```

No startup guard for either key exists anywhere in the repository.

**2. The audit's arithmetic is wrong.** It says "six legitimate sign-ins in a minute exhaust it". The rule is ten, per path, per 60 seconds — `packages/auth/src/index.ts:26`:

```ts
const CREDENTIAL_RULE = { max: 10, window: 60 };
```

applied at `packages/auth/src/index.ts:264-268` to `/forget-password`, `/sign-in/email` and `/sign-up/email`. Do not repeat the six.

**3. The audit says "the failure is silent". It is not.** Better Auth warns, once, on the first affected request. `packages/auth/node_modules/better-auth/dist/api/rate-limiter/index.mjs:274-287`:

```js
let ipWarningLogged = false;
const NO_TRUSTED_IP_KEY = "no-trusted-ip";
…
	if (!ip && !ipWarningLogged) {
		ctx.logger.warn("Rate limiting could not determine a client IP and is falling back to a single shared per-path bucket. Ensure your runtime forwards a trusted client IP header, then set `advanced.ipAddress.ipAddressHeaders` or `advanced.ipAddress.trustedProxies` so the address can be resolved.");
		ipWarningLogged = true;
	}
	const key = createRateLimitKey(ip ?? NO_TRUSTED_IP_KEY, path);
```

`createAuth()` in `packages/auth/src/index.ts:28-283` passes no `logger` option, and `@better-auth/core`'s `createLogger` defaults to `level: "warn"` writing through `console.warn`, so the warning reaches stdout. What this plan adds is therefore a *promotion*: an existing runtime warning, emitted once, after the deployment is already serving, becomes a refusal to boot. Write it that way. Do not claim to be inventing a signal from nothing.

**4. The thing the audit missed, which is worse.** `getIp` defaults to `x-forwarded-for` when `ipAddressHeaders` is absent, and `getIPFromHeader` trusts a single-value header with no proxy list at all. `node_modules/.bun/@better-auth+core@1.6.25+*/node_modules/@better-auth/core/dist/utils/ip.mjs:188-217`:

```js
	if (forwardedIps.length !== 1) return null;
	const selectedIp = forwardedIps[0];
	if (!selectedIp || !isValidIP(selectedIp)) return null;
	return normalizeIP(selectedIp, { ipv6Subnet: options.ipv6Subnet });
}
const LOCALHOST_IP = "127.0.0.1";
const DEFAULT_IP_HEADERS = ["x-forwarded-for"];
…
function getIp(req, options) {
	if (options.advanced?.ipAddress?.disableIpTracking) return null;
	const headers = "headers" in req ? req.headers : req;
	const ipHeaders = options.advanced?.ipAddress?.ipAddressHeaders || DEFAULT_IP_HEADERS;
	…
	if (isTest() || isDevelopment()) return LOCALHOST_IP;
	return null;
}
```

So on a production deployment reachable without a proxy — which is exactly the deployment the repo tells you to leave the header unset for — `curl -H 'X-Forwarded-For: 1.2.3.4'` is keyed `1.2.3.4|/sign-in/email`, and a fresh address per request means unlimited password guesses. The shared `no-trusted-ip` bucket only happens when the caller sends *no* forwarding header, or one with two or more entries.

These four places assert the opposite, and all four are false:

- `packages/auth/src/index.ts:51-53` — "with nothing configured every caller shares one rate-limit bucket per path"
- `packages/env/src/server.ts:193-195` — "leaving it unset means every caller shares one bucket per path, which is coarse but not forgeable"
- `.env.example:146-147` — "Unset means every caller shares one rate-limit bucket per path — coarse, but not forgeable"
- `docker-compose.prod.yml:60` — "unset means one shared rate-limit bucket, set-but-forgeable means none at all"

**5. One nearby comment is imprecise rather than false.** `packages/auth/src/index.ts:269-274` explains `enabled: env.NODE_ENV !== "test"` (line 275) by saying the key "falls back to a single shared per-path value when there is no client IP". The conclusion holds, the mechanism does not: under `NODE_ENV=test` — which `apps/server/test-setup.ts` sets unconditionally — `getIp` returns `127.0.0.1` from the `isTest()` branch above, so the shared key is `127.0.0.1|<path>`, not `no-trusted-ip|<path>`. Task 3 corrects the mechanism in one sentence while it is in the file.

**6. The worker does not import auth.** This matters for placement and the task brief's assumption is wrong here. `apps/server/src/worker.ts:1-10` imports `@keel/ai/generate`, `@keel/db`, `@keel/env/server`, `@keel/mail/send`, `zod`, `@/lib/ai`, `@/lib/ai.repository`, `@/lib/jobs`, `@/lib/mail` — and nothing reaches `@keel/auth`. Grep confirms only two importers: `apps/server/src/app.ts:2` and `apps/server/src/lib/auth.ts:1`. The worker serves no HTTP surface and runs no limiter, so it must keep booting.

**7. `migrate` shares the same environment.** `docker-compose.prod.yml:90`, `:114` and `:131` all say `environment: *app-env`, and `server` gates on migrate completing (`:126-128`). Anything that refuses at `@keel/env` import time refuses `bun dist/migrate.mjs` too, and a failed migration stops the deploy (`restart: "no"`, line 94). This is why the guard is a called function at one entrypoint, not schema validation.

**8. Which part is the security fix.** Tasks 1 and 2 are the security fix: a production API that cannot identify a caller stops booting. Tasks 3 and 4 are documentation honesty: no runtime behaviour changes, and the reason they are in this plan rather than deferred is that the false sentences are precisely what would talk a future operator out of setting the variables the guard now demands.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, 16 architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`; comment lines do not count).
- **No environment variable gets a default.** `TRUSTED_IP_HEADER` and `TRUSTED_PROXIES` stay `.optional()` in `packages/env/src/server.ts` and stay guarded at the point of use by a `resolve*` that throws naming them. Do not add `.default(…)`, do not add a `??` fallback, do not invent a header name.
- No new environment key is introduced by this plan, so nothing is added to `.env.example`'s uncommented list, `apps/server/.env`, `.env.test` or `docker-compose.prod.yml`'s `x-app-env`.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts` (`tools/check-naming.ts` enforces it). `client-ip.test.ts` beside `client-ip.ts` satisfies it.
- An error message states what is wrong **and** what to do instead — see `apps/server/src/lib/mail.ts:31-44` for the house style.

## Do not

- **Do not put this in `packages/env/src/server.ts` as a cross-field `superRefine`.** The schema is validated at import (`packages/env/src/server.ts:14-26`), and every process shares one `x-app-env`: `bun dist/migrate.mjs` would then refuse to apply a migration over a rate-limiting question, and `server` never starts because it gates on migrate. The repo's rule is a `resolve*` at the point of use, not cross-field validation in the schema.
- **Do not put the throw at module scope in `packages/auth/src/index.ts`.** `export const auth = createAuth()` (line 285) runs on import in every consumer, including `apps/server/src/lib/auth.ts` and the whole server suite. A package cannot import app code, and a library that decides its host's deployment policy is the inversion `resolveMailConfig`/`resolveAi`/`resolveStorage` exist to avoid.
- **Do not make the worker refuse.** It never imports `@keel/auth` (evidence 6) and runs no limiter. Refusing there would take mail and AI jobs down for a misconfiguration that cannot affect them.
- **Do not "fix" this inside `packages/auth` by passing `disableIpTracking: true` or an empty `ipAddressHeaders`.** `getIp` returns `null` immediately under `disableIpTracking`, and `resolveRateLimitConfig` then returns `null`, which skips the limiter entirely — `packages/auth/node_modules/better-auth/dist/api/rate-limiter/index.mjs:282`. That converts a weak limit into no limit.
- **Do not change `CREDENTIAL_RULE`.** Ten per minute per path is not the bug, and the audit's "six sign-ins" number that might tempt you to retune it is simply wrong (evidence 2).
- **Do not mount the repo's own `rateLimit` middleware on `/api/auth/*`.** It keys on `actorId`, which `requireUser` sets and which does not exist before sign-in — `apps/server/src/lib/rate-limit.ts:48-57` and `apps/server/src/app.ts:119-136` both say so. IP is the only key available on the credential endpoints, which is the whole reason its quality matters.
- **Do not touch `docker-compose.prod.yml`'s `x-app-env` key list.** Plan 019 owns it. Task 4 rewrites comment lines 58-62 only and leaves lines 63-64 exactly as they are — `${VAR:-}` is deliberate here, because a compose-level `:?` would block `migrate` and `worker` for a reason that concerns neither.
- **Do not touch README counts or `AGENTS.md`.** Plan 021 owns those. Task 4 rewrites one existing table row and adds none, so the "Five of those choices" sentence at `README.md:94` stays true.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/client-ip.ts` | **Create.** The one place that decides whether this deployment can identify a caller, and refuses if it cannot. |
| `apps/server/src/lib/client-ip.test.ts` | **Create.** Both refusals, both empty-string cases, and the two postures that are allowed to boot. |
| `apps/server/src/index.ts` | **Modify.** Call the guard before the socket opens, and print the resolved posture. |
| `packages/auth/src/index.ts` | **Modify.** Comments only: the IP block's rationale (50-70) and the limiter's test-mode note (269-274). |
| `packages/env/src/server.ts` | **Modify.** Comments only: the two key docs at 188-197 and 199-212. |
| `.env.example` | **Modify.** Comments only: the block at 146-157. |
| `docker-compose.prod.yml` | **Modify.** Comments only: lines 58-62. The key list is untouched. |
| `README.md` | **Modify.** One row of the production table, line 100. |

---

### Task 1: The guard, and the tests that fire it

**Files:**
- Create: `apps/server/src/lib/client-ip.ts`
- Create: `apps/server/src/lib/client-ip.test.ts`

**Interfaces:**
- Consumes: `env` from `@keel/env/server`, specifically `NODE_ENV: "development" | "production" | "test"` (`packages/env/src/server.ts:88`), `TRUSTED_IP_HEADER?: string` (`:198`) and `TRUSTED_PROXIES?: string[]` (`:213-217`, already split and trimmed by the schema's `.transform`).
- Produces: `export interface ClientIpEnv` and `export function resolveClientIpPosture(source?: ClientIpEnv): string` from `apps/server/src/lib/client-ip.ts`. Task 2 calls exactly this.

- [x] **Step 1: Write the failing test**

Create `apps/server/src/lib/client-ip.test.ts`. It mirrors `mail.test.ts` exactly: a named regex per guard, one `envWith` builder, throw cases first, then the configurations allowed to boot.

```ts
import { describe, expect, it } from "bun:test";
import { type ClientIpEnv, resolveClientIpPosture } from "./client-ip";

/** Each guard is identified by the variable it names, which is its whole job. */
const MISSING_HEADER = /TRUSTED_IP_HEADER/;
const MISSING_PROXIES = /TRUSTED_PROXIES/;

function envWith(overrides: Partial<ClientIpEnv>): ClientIpEnv {
	return { NODE_ENV: "development", ...overrides };
}

describe("resolveClientIpPosture", () => {
	it("refuses a production boot with no trusted header", () => {
		expect(() => resolveClientIpPosture(envWith({ NODE_ENV: "production" }))).toThrow(
			MISSING_HEADER
		);
	});

	it("treats an empty header as absent", () => {
		// `emptyStringAsUndefined` covers an unset variable, but the prod compose
		// writes `TRUSTED_IP_HEADER: ${TRUSTED_IP_HEADER:-}`, and a deployment that
		// exports the name with no value must not slip past the guard.
		expect(() =>
			resolveClientIpPosture(
				envWith({ NODE_ENV: "production", TRUSTED_IP_HEADER: "" })
			)
		).toThrow(MISSING_HEADER);
	});

	it("refuses a named header with no proxy list", () => {
		// Not production-only: a header nobody rewrites is taken at face value in
		// every environment, so the mistake is worth learning about on a laptop.
		expect(() =>
			resolveClientIpPosture(envWith({ TRUSTED_IP_HEADER: "x-forwarded-for" }))
		).toThrow(MISSING_PROXIES);
	});

	it("treats an empty proxy list as absent", () => {
		expect(() =>
			resolveClientIpPosture(
				envWith({ TRUSTED_IP_HEADER: "x-forwarded-for", TRUSTED_PROXIES: [] })
			)
		).toThrow(MISSING_PROXIES);
	});

	it("names the forgeable default when it lets a laptop boot unconfigured", () => {
		// A fresh checkout has neither key and has to start. What it must not do is
		// stay quiet about what Better Auth does instead.
		const posture = resolveClientIpPosture(envWith({}));

		expect(posture).toContain("x-forwarded-for");
		expect(posture).toContain("127.0.0.1");
	});

	it("reports the header and the number of trusted ranges when configured", () => {
		expect(
			resolveClientIpPosture(
				envWith({
					NODE_ENV: "production",
					TRUSTED_IP_HEADER: "x-forwarded-for",
					TRUSTED_PROXIES: ["10.0.0.0/8", "172.16.0.0/12"],
				})
			)
		).toBe("client IP from `x-forwarded-for`, past 2 trusted range(s)");
	});
});
```

- [x] **Step 2: Run it and watch it fail for the right reason**

```bash
cd apps/server && bun test src/lib/client-ip.test.ts
```

Expected: the run aborts resolving the import — `Cannot find module './client-ip'`. Any other failure means Step 1 was mistyped; fix that before continuing.

- [x] **Step 3: Write the guard**

Create `apps/server/src/lib/client-ip.ts`:

```ts
import { env } from "@keel/env/server";

/**
 * The three deployment inputs `resolveClientIpPosture` reads.
 *
 * Taken as a parameter rather than closed over for the same reason `MailEnv` is:
 * the guard is the only reason this function exists, and a guard nobody has seen
 * fire is not a guard. `TRUSTED_PROXIES` arrives already split and trimmed by the
 * schema's own transform.
 */
export interface ClientIpEnv {
	NODE_ENV: "development" | "production" | "test";
	TRUSTED_IP_HEADER?: string | undefined;
	TRUSTED_PROXIES?: string[] | undefined;
}

/**
 * Whether this deployment can tell two callers apart, stated as the line the
 * entry point prints — and refused when the answer is no.
 *
 * Better Auth keys its limiter on the client IP, because on `/sign-in/email`,
 * `/sign-up/email` and `/forget-password` there is no actor yet to key on. It
 * resolves that IP from headers only, and its `getIp` reads `x-forwarded-for`
 * whether or not anything is configured. That default is what makes silence
 * unsafe rather than merely coarse: unconfigured and directly reachable, a caller
 * sends its own `X-Forwarded-For` and gets a private bucket, and a caller that
 * varies it per request has no credential limit at all.
 *
 * Better Auth does warn — once, through `ctx.logger.warn`, on the first request
 * that could not be resolved. That is a line in a log during traffic, hours after
 * the deploy that caused it. This turns the same fact into a refusal to boot, at
 * the moment someone is watching.
 *
 * The API is the only process that answers this question: `worker.ts` never
 * imports `@keel/auth` and runs no limiter, and `migrate.ts` shares the same
 * environment but must never be blocked by a rate-limiting concern.
 */
export function resolveClientIpPosture(source: ClientIpEnv = env): string {
	if (!source.TRUSTED_IP_HEADER) {
		if (source.NODE_ENV === "production") {
			throw new Error(
				"NODE_ENV=production requires TRUSTED_IP_HEADER. Better Auth reads x-forwarded-for by default, so with no header named this deployment trusts whatever a caller sends: a client that supplies its own single-value X-Forwarded-For gets a private rate-limit bucket, and the 10-per-60s rule on /sign-in/email, /sign-up/email and /forget-password stops applying to it. Set TRUSTED_IP_HEADER to the header the proxy in front of this app rewrites (x-forwarded-for, cf-connecting-ip), together with TRUSTED_PROXIES."
			);
		}

		// Outside production `getIp` ends at `isTest() || isDevelopment()` and
		// returns 127.0.0.1, so a laptop boots with one shared bucket and no
		// pretence that the bucket is per-caller.
		return "client IP unresolved: Better Auth reads `x-forwarded-for` by default and falls back to 127.0.0.1 outside production";
	}

	if (!source.TRUSTED_PROXIES?.length) {
		throw new Error(
			`TRUSTED_IP_HEADER=${source.TRUSTED_IP_HEADER} requires TRUSTED_PROXIES. With no proxy list Better Auth accepts the header at face value whenever it holds exactly one address, so a caller that sends its own ${source.TRUSTED_IP_HEADER} chooses its own rate-limit bucket. Set TRUSTED_PROXIES to every hop in front of this app, as IPs or CIDR ranges, e.g. 10.0.0.0/8,172.16.0.0/12.`
		);
	}

	return `client IP from \`${source.TRUSTED_IP_HEADER}\`, past ${source.TRUSTED_PROXIES.length} trusted range(s)`;
}
```

- [x] **Step 4: Run the test and watch it pass**

```bash
cd apps/server && bun test src/lib/client-ip.test.ts
```

Expected: `6 pass, 0 fail`.

- [x] **Step 5: Prove the whole gate is green**

```bash
bun run check
```

Expected: every turbo task successful; `check-naming` reports one more suite than before (33 at `39fd32c`, so 34 — higher if another plan's suite has already landed; the exit code is the gate, not the number); `check-rules` reports 16 architecture rules verified; migrations match.

- [x] **Step 6: Commit**

```bash
git add apps/server/src/lib/client-ip.ts apps/server/src/lib/client-ip.test.ts
git commit -m "feat(server): refuse a production boot with no client-IP source

Better Auth keys its limiter on the client IP because the credential endpoints
have no actor yet, and it resolves that IP from headers only. What the repo
never checked is whether the deployment gave it one. Unconfigured, \`getIp\`
still reads \`x-forwarded-for\` — its documented default — so a directly
reachable production app does not get the coarse shared bucket the comments
promised: a caller sends its own X-Forwarded-For, gets a private bucket, and a
caller that varies it has no credential limit at all. Behind a proxy that
appends, the header holds two entries, resolves to nothing, and the whole user
base shares one bucket per path instead. Neither end is a limiter.

Better Auth already warns about the second case, once, on the first affected
request. This promotes that warning to a refusal, at the moment someone is
watching a deploy. A header with no TRUSTED_PROXIES is refused in every
environment, not only production: a forwarding header nobody rewrites is
forgeable wherever it is trusted.

It is a called resolver in the mail/ai/storage style rather than a rule in the
env schema, because \`migrate\`, \`worker\` and \`server\` share one x-app-env
and a schema that throws would stop a migration over a rate-limiting question."
```

---

### Task 2: Run it before the socket opens

**Files:**
- Modify: `apps/server/src/index.ts:1-14`

**Interfaces:**
- Consumes: `resolveClientIpPosture(source?: ClientIpEnv): string` from Task 1.
- Produces: nothing other code imports. The observable output is a `[server] …` line on stdout and a non-zero exit when the guard throws.

- [x] **Step 1: Add the import**

`apps/server/src/index.ts` lines 1-5 are currently:

```ts
import { closePool } from "@keel/db";
import { env } from "@keel/env/server";
import { initLogger } from "evlog";
import { resolveDrain } from "@/lib/observability";
import { app } from "./app";
```

Insert the new import before `@/lib/observability` — Biome sorts the `@/` group alphabetically and `client-ip` precedes `observability`:

```ts
import { closePool } from "@keel/db";
import { env } from "@keel/env/server";
import { initLogger } from "evlog";
import { resolveClientIpPosture } from "@/lib/client-ip";
import { resolveDrain } from "@/lib/observability";
import { app } from "./app";
```

- [x] **Step 2: Call it between the logger and the socket**

After the `initLogger({ … })` block that ends at line 14, and before the `const server = Bun.serve({` comment that starts at line 16, insert:

```ts
// Before the socket opens, and after the logger so the failure is observable.
// One statement does both jobs: it throws when this deployment cannot identify a
// caller, and otherwise states on stdout what the auth limiter is keyed on — the
// answer is invisible from outside the process, and getting it wrong is only
// noticeable during the attack it was supposed to bound.
process.stdout.write(`[server] ${resolveClientIpPosture()}\n`);
```

- [x] **Step 3: Watch a production boot refuse**

`apps/server/.env` carries `NODE_ENV=development` and neither trusted key. `dotenv` does not override a variable already in the environment, so the shell can promote just this one:

```bash
cd apps/server && NODE_ENV=production bun src/index.ts
```

Expected: no `[server] listening` line, a non-zero exit, and a stack trace whose message begins `NODE_ENV=production requires TRUSTED_IP_HEADER.` If the process instead prints `[server] listening`, the call was inserted below `Bun.serve` — move it up.

- [x] **Step 4: Watch a configured production boot succeed**

```bash
cd apps/server && NODE_ENV=production TRUSTED_IP_HEADER=x-forwarded-for TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12 BUN_PORT=3099 bun src/index.ts
```

Expected, in this order:

```
[server] client IP from `x-forwarded-for`, past 2 trusted range(s)
[server] listening on http://localhost:3099/ (port 3099)
```

`BUN_PORT` keeps this off 3000 in case a dev server is already running. Stop it with Ctrl-C; the existing SIGINT handler prints `[server] SIGINT received, draining` then `[server] drained`.

- [x] **Step 5: Watch the unconfigured development boot still work, and say what it does**

```bash
cd apps/server && BUN_PORT=3099 bun src/index.ts
```

Expected first line:

```
[server] client IP unresolved: Better Auth reads `x-forwarded-for` by default and falls back to 127.0.0.1 outside production
```

followed by the listening line. Ctrl-C to stop. A fresh checkout must keep booting; this is the whole reason the header guard is scoped to production.

- [x] **Step 6: Prove the whole gate is green**

```bash
bun run check
```

Expected: unchanged from Task 1 — every task successful, same suite count, 16 architecture rules, migrations match. Nothing in the suite imports `src/index.ts`, so no test result moves.

- [x] **Step 7: Commit**

```bash
git add apps/server/src/index.ts
git commit -m "feat(server): state the client-IP posture before the socket opens

The guard has to run somewhere, and the API entry point is the only process the
answer concerns: worker.ts never imports @keel/auth and runs no limiter, and
migrate.ts shares the same x-app-env but must not be stopped by a rate-limiting
question — the server service gates on it completing.

Placed after initLogger, so the failure is observable, and before Bun.serve, so
a deployment that cannot tell two callers apart never accepts a request. The
same statement prints the posture on the way past, because what the auth limiter
is keyed on is otherwise invisible from outside the process.

Verified all three paths against apps/server/.env: NODE_ENV=production alone
exits naming TRUSTED_IP_HEADER and never listens; with the header and
TRUSTED_PROXIES it prints the header and range count, then listens; an
unconfigured development boot still starts and says out loud that Better Auth
falls back to 127.0.0.1."
```

---

### Task 3: Stop the code comments claiming an unset header is unforgeable

**Files:**
- Modify: `packages/auth/src/index.ts:50-70`, `packages/auth/src/index.ts:269-274`
- Modify: `packages/env/src/server.ts:188-197`, `packages/env/src/server.ts:199-212`

**Interfaces:**
- Consumes: nothing. No executable line changes in this task.
- Produces: nothing. Comment text only.

- [ ] **Step 1: Replace the IP-resolution rationale in `packages/auth`**

`packages/auth/src/index.ts:50-70` is the block comment directly above the conditional spread at line 71. Replace those 21 lines — the comment only, leaving `...(env.TRUSTED_IP_HEADER` at line 71 untouched — with:

```ts
			/**
			 * Better Auth resolves the client IP from headers only — it has no socket
			 * access through a `Request` — and it does not wait to be told which
			 * header: `getIp` falls back to `DEFAULT_IP_HEADERS`, which is
			 * `["x-forwarded-for"]`, whenever `ipAddressHeaders` is absent. So an
			 * unset header is not the coarse-but-unforgeable bucket it reads like.
			 * On a directly reachable deployment a caller that sends a single-value
			 * `X-Forwarded-For` is keyed on it, and a caller that sends a different
			 * one per request has no credential limit at all. Only a caller sending
			 * no forwarding header, or one with two or more entries, lands in the
			 * shared `no-trusted-ip` bucket. Outside production the question is moot:
			 * `getIp` ends at `isTest() || isDevelopment()` and returns 127.0.0.1.
			 *
			 * Naming the header is not enough, and this was measured rather than
			 * assumed. `getIPFromHeader` returns null unless the header holds exactly
			 * ONE address, so behind anything that appends — Traefik, nginx's
			 * `proxy_add_x_forwarded_for`, a CDN, any second hop — the value has two
			 * entries and resolution falls back to the shared bucket. Only
			 * `trustedProxies` changes that: with it, Better Auth walks the list from
			 * the right, skips every address inside a trusted range, and takes the
			 * first one that is not. That is the only order that resists spoofing,
			 * because a client controls what it prepends and nothing more.
			 *
			 * Both are optional here because only a deployment knows what sits in
			 * front of it — but a production deployment has to answer.
			 * `resolveClientIpPosture` in `apps/server/src/lib/client-ip.ts` refuses
			 * to start the API on `NODE_ENV=production` without a header, and refuses
			 * a header without a proxy list in any environment.
			 */
```

- [ ] **Step 2: Correct the limiter's test-mode note in the same file**

`packages/auth/src/index.ts:269-274` sits inside the `rateLimit` block, above `enabled: env.NODE_ENV !== "test"` at line 275. Its conclusion is right and its mechanism is not — under `test`, `getIp` returns 127.0.0.1 rather than failing to resolve. Replace those six lines with:

```ts
			/**
			 * Off under test: `getIp` returns 127.0.0.1 for every request when
			 * NODE_ENV is `test`, so every test user in every run would draw from one
			 * `127.0.0.1|<path>` budget and a second `bun test` inside the window
			 * would start returning 429.
			 */
```

- [ ] **Step 3: Replace the `TRUSTED_IP_HEADER` doc in `packages/env`**

`packages/env/src/server.ts:188-197` is the block comment above `TRUSTED_IP_HEADER: z.string().min(1).optional(),` at line 198. Replace the comment, leaving line 198 untouched:

```ts
		/**
		 * The header a trusted proxy uses to report the real client IP, e.g.
		 * `x-forwarded-for` or `cf-connecting-ip`.
		 *
		 * Optional because a laptop needs no answer, not because skipping it is
		 * safe. Better Auth reads `x-forwarded-for` by default whether or not this
		 * is set, so an unset header on a directly reachable app does not mean one
		 * coarse shared bucket — it means each caller can send an address and pick
		 * its own. `resolveClientIpPosture` in `apps/server/src/lib/client-ip.ts` is
		 * the guard: it refuses to start the API on `NODE_ENV=production` without
		 * this, and refuses this without `TRUSTED_PROXIES` alongside it.
		 */
```

- [ ] **Step 4: Replace the `TRUSTED_PROXIES` doc**

`packages/env/src/server.ts:199-212` is the block comment above `TRUSTED_PROXIES: z` at line 213. Replace the comment, leaving lines 213-217 untouched:

```ts
		/**
		 * The addresses of the proxies in front of this app, as IPs or CIDR ranges,
		 * comma separated — e.g. `10.0.0.0/8,172.16.0.0/12`.
		 *
		 * Required whenever `TRUSTED_IP_HEADER` is set, and the guard enforces it.
		 * Without a proxy list Better Auth accepts a forwarding header holding
		 * exactly one address at face value, which is a caller choosing its own
		 * bucket; with two or more entries — Traefik, nginx's
		 * `proxy_add_x_forwarded_for` and every CDN append rather than replace — it
		 * refuses to guess which entry is the client and falls back to one shared
		 * per-path bucket. The header alone is therefore either forgeable or inert.
		 *
		 * List every hop. Better Auth scans from the right and returns the first
		 * address outside these ranges, so a hop left out of the list becomes the
		 * answer — and a range that is too wide lets a caller inside it choose.
		 */
```

- [ ] **Step 5: Prove nothing executable moved**

```bash
git diff --stat packages/auth/src/index.ts packages/env/src/server.ts
```

Expected: two files changed. Then confirm the diff contains no line that is not inside a block comment:

```bash
git diff -U0 packages/auth/src/index.ts packages/env/src/server.ts
```

Expected: every added and removed line begins with `+`/`-` followed by whitespace and `*`, `/**` or `*/`. If any other line appears, a code line was caught in the replacement — revert it.

- [ ] **Step 6: Prove the whole gate is green**

```bash
bun run check
```

Expected: unchanged from Task 2. `noExcessiveLinesPerFile` counts code lines, so the longer comments cannot trip it.

- [ ] **Step 7: Commit**

```bash
git add packages/auth/src/index.ts packages/env/src/server.ts
git commit -m "docs(auth): an unset TRUSTED_IP_HEADER was never unforgeable

Both files told the same reassuring story: name no header and every caller
shares one coarse bucket per path, which is imprecise but safe. Better Auth's
\`getIp\` reads \`x-forwarded-for\` from \`DEFAULT_IP_HEADERS\` when
\`ipAddressHeaders\` is absent, and \`getIPFromHeader\` trusts a single-value
header with no proxy list, so the unconfigured posture on a directly reachable
app is the opposite of unforgeable — the caller picks the bucket. The shared
bucket only happens when no forwarding header arrives or the header carries two
or more entries.

That sentence is the reason an operator would leave the variable unset, so it
had to go before the guard could mean anything. Comments only; the conditional
spread and the schema fields are unchanged and still correct.

The limiter's test-mode note is corrected in the same pass. Its conclusion held
but its mechanism did not: under NODE_ENV=test \`getIp\` returns 127.0.0.1, so
the shared key is \`127.0.0.1|<path>\`, not \`no-trusted-ip|<path>\`."
```

---

### Task 4: Say the same true thing to the operator

**Files:**
- Modify: `.env.example:146-157`
- Modify: `docker-compose.prod.yml:58-62`
- Modify: `README.md:100`

**Interfaces:**
- Consumes: nothing.
- Produces: nothing. Operator-facing text only.

- [ ] **Step 1: Rewrite the `.env.example` block**

Lines 146-157 currently document both keys as commented examples. Keep them commented — neither is required to boot a laptop — and replace the prose:

```
# The header a trusted proxy uses to report the real client IP. Better Auth reads
# x-forwarded-for by default whether or not this is set, so unset does not mean one
# coarse shared bucket: on a directly reachable app each caller can send its own
# address and pick its own rate-limit bucket. The server refuses to start with
# NODE_ENV=production until this is set.
# TRUSTED_IP_HEADER=x-forwarded-for

# The proxies in front of this app, as IPs or CIDR ranges. REQUIRED alongside
# TRUSTED_IP_HEADER, in every environment, and the server refuses to start without
# it: a header no proxy rewrites is accepted at face value whenever it holds one
# address. It is also what makes the header work behind Traefik, nginx's
# proxy_add_x_forwarded_for and every CDN, which append rather than replace — with
# two entries and no list, Better Auth refuses to guess and falls back to the shared
# bucket. List every hop: one left out becomes the answer, and a range too wide lets
# a caller inside it choose its own bucket.
# TRUSTED_PROXIES=10.0.0.0/8,172.16.0.0/12
```

- [ ] **Step 2: Rewrite the compose comment, and only the comment**

`docker-compose.prod.yml` lines 58-62 are the comment above the two keys. Replace those five lines with:

```yaml
  # Better Auth reads x-forwarded-for by default even when nothing is configured, so
  # an unset header is not a coarse shared bucket — it is a bucket the caller picks.
  # The server refuses to start with NODE_ENV=production unless TRUSTED_IP_HEADER
  # names the header the proxy in front of it rewrites and TRUSTED_PROXIES lists
  # every hop as IPs or CIDR ranges. Left `:-` rather than `:?` on purpose: migrate
  # and worker share this block and neither serves an authenticated request.
```

Lines 63-64 keep `${TRUSTED_IP_HEADER:-}` and `${TRUSTED_PROXIES:-}` byte for byte. Plan 019 owns the key list.

- [ ] **Step 3: Rewrite the README row**

`README.md:100` is the `TRUSTED_IP_HEADER` row of the "Going to production" table. Replace that one line with:

```markdown
| `TRUSTED_IP_HEADER=x-forwarded-for` + `TRUSTED_PROXIES` | Better Auth resolves the client IP from headers only, and reads `x-forwarded-for` by default whether or not you configure one. Unset on a directly reachable app, a caller sends its own address and gets a private bucket, so the 10-per-60s limit on `/sign-in/email` stops applying; set without a proxy list, the same forgery works through the header you named; behind a proxy that appends, the header holds two addresses, resolves to nothing, and your whole user base shares one bucket per path. None of the three is a rate limiter, so the server refuses to start on `NODE_ENV=production` without the header and refuses the header without the proxy list. |
```

Add no row and remove none: the sentence at `README.md:94` still says "Five of those choices", and it stays true. Plan 021 owns README counts.

- [ ] **Step 4: Prove the gate is green**

```bash
bun run check
```

Expected: unchanged. None of these three files is compiled, linted as source, or imported by a test; this run is confirming that, not measuring it.

- [ ] **Step 5: Commit**

```bash
git add .env.example docker-compose.prod.yml README.md
git commit -m "docs: production requires a trusted IP header, and why

The three operator-facing files repeated the claim the code comments just lost:
that leaving TRUSTED_IP_HEADER unset buys a coarse but unforgeable bucket. It
buys a bucket the caller names, because Better Auth reads x-forwarded-for by
default. Each file now states the three postures and which of them the server
now refuses to start in.

The compose keys stay \`\${VAR:-}\` rather than \`:?\`: x-app-env is shared with
migrate and worker, neither of which serves an authenticated request, so the
refusal belongs in the API process and not in the file that would also stop a
migration. Comment lines only there — the key list is untouched.

One README row is rewritten and none added, so the table is still the five
choices its introduction promises."
```

---

## Done when

- `cd apps/server && NODE_ENV=production bun src/index.ts` exits non-zero with a message naming `TRUSTED_IP_HEADER`, and never prints `[server] listening`.
- `cd apps/server && NODE_ENV=production TRUSTED_IP_HEADER=x-forwarded-for bun src/index.ts` exits non-zero with a message naming `TRUSTED_PROXIES`.
- `cd apps/server && NODE_ENV=production TRUSTED_IP_HEADER=x-forwarded-for TRUSTED_PROXIES=10.0.0.0/8 BUN_PORT=3099 bun src/index.ts` prints the posture line, then listens.
- An unconfigured development boot still starts, and its first line says Better Auth falls back to 127.0.0.1.
- `bun test src/lib/client-ip.test.ts` reports 6 passing tests, and `bun run check` is green.
- `grep -rn "not forgeable\|unforgeable\|coarse, but" .env.example README.md docker-compose.prod.yml packages/auth/src/index.ts packages/env/src/server.ts` returns nothing.
- `packages/auth/src/index.ts` and `packages/env/src/server.ts` have no executable change: `git diff -U0` over the pair shows comment lines only.

## Out of scope

- **`TRUSTED_PROXIES` set without `TRUSTED_IP_HEADER`** is not refused. `packages/auth/src/index.ts:75-77` only spreads `trustedProxies` inside the header branch, so the value is inert rather than dangerous — and in production the missing header is already a refusal, which covers the only case where it could matter.
- **Routing Better Auth's own `logger` into evlog** so its warnings become wide events. A real improvement, unrelated to whether the deployment boots, and it would need a decision about every other Better Auth warning.
- **SEC-02, unverified accounts signing in** (`plans/audit-report.md:51-57`) touches `emailAndPassword` in the same file and belongs to plan 007. Note that `plans/audit-report.md:25` mislabels the summary row for SEC-03 with SEC-02's title; the detail section at 59-65 is the finding this plan implements.
- **SEC-04, `MAIL_DRIVER=log` in production** (`plans/audit-report.md:67-74`). Same shape of fix — a production refusal in a `resolve*` — but `resolveMailConfig` is called from `worker.ts:45`, not from the API entry point, so it is a different guard in a different process.
- **`docker-compose.prod.yml`'s `x-app-env` key list** belongs to plan 019. **README counts and `AGENTS.md`** belong to plan 021.
- **Tuning `CREDENTIAL_RULE` or the `rateLimit` defaults.** The limits are not the finding; the key they are counted against is.
