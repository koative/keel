# Relative `VITE_SERVER_URL` Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** CORR-04 (`plans/audit-report.md:135-141`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Goal:** Make `VITE_SERVER_URL` accept the root-relative value that `.env.example`, the Docker deployment and Vercel previews already document, so the SPA stops throwing at boot on its own documented wiring.

**Architecture:** The bug is one validator disagreeing with one resolver. `packages/env/src/web.ts:13` declares `VITE_SERVER_URL: z.url()`, which rejects any leading-slash value; `apps/web/src/lib/server-url.ts:15` (`serverOrigin`) exists precisely to resolve leading-slash values against `window.location.origin`. The resolver never runs, because `createEnv` throws first. The fix moves the rule into its own side-effect-free module so it can be unit-tested without executing `createEnv` (which validates the whole environment on import), then points `web.ts` at it.

**Tech Stack:** Bun, zod 4.4.3, `@t3-oss/env-core`, Vite 7, bun:test.

---

## Verified evidence (do not re-litigate)

These were confirmed by running things, not by reading:

1. **The crash is real.** Built `apps/web` with `VITE_SERVER_URL=/api`, served `dist/`, and imported the chunk carrying `@keel/env/web` in a real Chromium tab:

   ```
   VITE_SERVER_URL=/api                  →  Error: Invalid environment variables
   VITE_SERVER_URL=http://localhost:3000 →  loads
   ```

2. **`SKIP_ENV_VALIDATION=1` in `apps/web/Dockerfile:4` is inert.** Vite substitutes `process.env` in the client bundle, so the emitted code is literally:

   ```js
   runtimeEnv:{…,VITE_SERVER_URL:`/api`},skipValidation:!!{}.SKIP_ENV_VALIDATION
   ```

   `!!{}.SKIP_ENV_VALIDATION` is `false`. The flag cannot reach the browser. It also does not affect the build: `VITE_SERVER_URL=/api bun run build` succeeds today with the variable unset, because `vite build` never executes the module body. The audit's claim that this flag "keeps the contradiction invisible" is half right — it hides nothing at runtime, and nothing at build either.

3. **The replacement schema behaves as specified.** Every case in Task 1's test table was executed against zod 4.4.3 before this plan was written.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome, catalog drift, naming, architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 code lines (Biome `noExcessiveLinesPerFile`; comments do not count).
- **No environment variable gets a default.** `VITE_SERVER_URL` stays required. Do not add `.default(...)`, do not add a `??` fallback anywhere in the resolution path. This is the rule the repo was refactored around in `2bc6791`.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts` (`tools/check-naming.ts` enforces it).
- An error message states what is wrong **and** what to do instead — see `apps/web/src/lib/server-url.ts:41-43` for the house style.

## Do not

- Do not relax the schema to bare `z.string()`. A typo would then reach the browser and present as a silent fetch failure.
- Do not touch `apps/server/Dockerfile:10`. Its `SKIP_ENV_VALIDATION=1` is load-bearing and commented: the server validates at import, and validating in the builder would force secrets into the image.
- Do not edit `.env.example`. Lines 120-122 already document exactly the behaviour this plan makes true; the absolute default it ships stays correct.
- Do not add a fallback origin to `serverOrigin`. The throw at `server-url.ts:41` is deliberate and was added on purpose in `2bc6791`.

## File structure

| File | Responsibility |
|---|---|
| `packages/env/src/server-url.ts` | **Create.** The one rule for what `VITE_SERVER_URL` may hold. Side-effect free so it is testable without `createEnv`. |
| `packages/env/src/server-url.test.ts` | **Create.** The accept/reject table. |
| `packages/env/package.json` | **Modify.** Add a `test` script so turbo runs the new suite. |
| `packages/env/src/web.ts:13` | **Modify.** Point `VITE_SERVER_URL` at the shared schema. |
| `apps/web/Dockerfile:4` | **Modify.** Delete the inert `SKIP_ENV_VALIDATION=1`. |

---

### Task 1: The schema, and a test that pins it

**Files:**
- Create: `packages/env/src/server-url.ts`
- Create: `packages/env/src/server-url.test.ts`
- Modify: `packages/env/package.json:20-22`
- Modify: `packages/env/src/web.ts:2,13`

**Interfaces:**
- Produces: `export const serverUrlSchema: z.ZodType<string>` from `packages/env/src/server-url.ts`. Task 2 relies on nothing from this task except that a relative value now validates.

- [x] **Step 1: Give the package a test script**

`packages/env` has no `test` script, so `turbo run test` currently skips it entirely. Replace the `scripts` block in `packages/env/package.json`:

```json
  "scripts": {
    "check-types": "tsc --noEmit",
    "test": "bun test"
  }
```

No `bunfig.toml` and no `test-setup.ts` are needed: `server-url.ts` imports only zod and touches no environment.

- [x] **Step 2: Write the failing test**

Create `packages/env/src/server-url.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import { serverUrlSchema } from "./server-url";

/**
 * The accept set is not a style preference: it is the union of what
 * `apps/web/src/lib/server-url.ts` can resolve. An absolute origin is used as
 * given; a root-relative path is resolved against `window.location.origin`,
 * which is how the Docker and Vercel deployments are wired. Anything this
 * schema accepts and that resolver cannot resolve is a boot crash, and
 * anything it rejects that the resolver handles is this bug again.
 */
describe("VITE_SERVER_URL", () => {
	it.each(["http://localhost:3000", "https://api.example.com"])(
		"accepts the absolute origin %p",
		(value) => {
			expect(serverUrlSchema.safeParse(value).success).toBe(true);
		}
	);

	it.each(["/api", "/"])(
		"accepts the root-relative path %p that the Docker and Vercel wiring uses",
		(value) => {
			expect(serverUrlSchema.safeParse(value).success).toBe(true);
		}
	);

	// A protocol-relative value looks root-relative and is not: the browser would
	// resolve `//evil.example` to another origin entirely.
	it.each(["//evil.example", "//evil.example/api"])(
		"rejects the protocol-relative %p",
		(value) => {
			expect(serverUrlSchema.safeParse(value).success).toBe(false);
		}
	);

	it.each(["javascript:alert(1)", "file:///etc/passwd"])(
		"rejects the non-http scheme %p",
		(value) => {
			expect(serverUrlSchema.safeParse(value).success).toBe(false);
		}
	);

	it.each(["not a url", "", "localhost:3000"])(
		"rejects %p, which resolves to nothing",
		(value) => {
			expect(serverUrlSchema.safeParse(value).success).toBe(false);
		}
	);

	it("names both accepted shapes when it rejects", () => {
		const result = serverUrlSchema.safeParse("not a url");

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues[0]?.message).toContain("/api");
			expect(result.error.issues[0]?.message).toContain("https://");
		}
	});
});
```

- [x] **Step 3: Run it and watch it fail for the right reason**

```bash
cd packages/env && bun test
```

Expected: the run aborts resolving `./server-url` — `Cannot find module './server-url'`. If it fails any other way, stop and re-read Step 2.

- [x] **Step 4: Write the schema**

Create `packages/env/src/server-url.ts`:

```ts
import { z } from "zod";

/**
 * What `VITE_SERVER_URL` may hold.
 *
 * Its own module, rather than an inline schema in `web.ts`, because importing
 * `web.ts` executes `createEnv` — which validates the whole client environment
 * and throws before a test can reach the rule it wants to check. The rule is
 * the thing worth testing, so it lives where it can be imported alone.
 *
 * Two shapes, because there are two deployments. An absolute origin is used as
 * given. A root-relative path is resolved against the page origin by
 * `serverOrigin` in `apps/web/src/lib/server-url.ts`, which is how the Docker
 * image and Vercel previews are wired — the API answers on the same origin as
 * the app, and hard-coding a host into a static bundle would make the build
 * environment-specific.
 *
 * `z.url()` alone rejected the second shape, so a deployment following the
 * documented wiring shipped an SPA that threw at module import. The resolver
 * that exists to handle the value never ran.
 *
 * Protocol-relative is rejected on purpose: `//evil.example` reads as
 * root-relative and is not — the browser resolves it to another origin. Schemes
 * other than http(s) are rejected for the same reason a fetch base has no
 * business being `javascript:` or `file:`.
 */
export const serverUrlSchema = z.string().refine(
	(value) => {
		if (value.startsWith("/")) {
			return !value.startsWith("//");
		}

		try {
			const parsed = new URL(value);
			return parsed.protocol === "http:" || parsed.protocol === "https:";
		} catch {
			return false;
		}
	},
	{
		message:
			"VITE_SERVER_URL must be an absolute http(s) origin (https://api.example.com) or a root-relative path resolved against the page origin (/api). See .env.example.",
	}
);
```

- [x] **Step 5: Run the test and watch it pass**

```bash
cd packages/env && bun test
```

Expected: `12 pass, 0 fail`.

- [x] **Step 6: Point the client schema at it**

In `packages/env/src/web.ts`, add the import and replace the field. Before:

```ts
import { createEnv } from "@t3-oss/env-core";
import { z } from "zod";
```
```ts
	client: {
		VITE_SERVER_URL: z.url(),
	},
```

After:

```ts
import { createEnv } from "@t3-oss/env-core";
import { serverUrlSchema } from "./server-url";
```
```ts
	client: {
		VITE_SERVER_URL: serverUrlSchema,
	},
```

The `z` import is now unused in `web.ts` — remove it, or Biome's `noUnusedImports` will fail the lint.

- [x] **Step 7: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful, `check-naming` counts one more suite than before (34), 16 architecture rules verified, migrations match.

- [x] **Step 8: Commit**

```bash
git add packages/env/src/server-url.ts packages/env/src/server-url.test.ts packages/env/src/web.ts packages/env/package.json
git commit -m "fix(env): VITE_SERVER_URL rejected the wiring it documents

\`z.url()\` refuses a leading-slash value, and a leading-slash value is what
\`.env.example\`, the Docker image and Vercel previews are documented to use —
the API answers on the app's own origin, so the bundle must not carry a host.
\`serverOrigin\` in apps/web exists to resolve exactly that, and never ran:
\`createEnv\` threw at module import first. Verified in a browser before the fix,
a \`/api\` build died with \"Invalid environment variables\" while an absolute
build loaded.

The rule moves to its own module because importing \`web.ts\` validates the whole
client environment, so the rule could not be tested where it lived. Protocol-
relative and non-http schemes are rejected on the way past: \`//evil.example\`
reads as root-relative and resolves to another origin."
```

---

### Task 2: Delete the flag that made this look configured

**Files:**
- Modify: `apps/web/Dockerfile:4`

**Interfaces:**
- Consumes: Task 1's schema — a relative value must already validate before this task's end-to-end check can pass.
- Produces: nothing other code depends on.

- [x] **Step 1: Confirm the flag is inert before removing it**

```bash
cd apps/web && env -u SKIP_ENV_VALIDATION VITE_SERVER_URL=/api bun run build
```

Expected: the build succeeds. It has always succeeded — `vite build` bundles the module, it does not execute it, so the flag never gated anything on this path. Confirm rather than assume, because `apps/server/Dockerfile` sets the same variable for a real reason and the two must not be conflated.

- [x] **Step 2: Remove the line**

In `apps/web/Dockerfile`, delete line 4:

```dockerfile
ENV SKIP_ENV_VALIDATION=1
```

Leave every other line untouched. The file should go straight from `WORKDIR /app` to the blank line before `COPY . .`.

- [x] **Step 3: Prove the image still builds**

```bash
docker build -f apps/web/Dockerfile --build-arg VITE_SERVER_URL=/api -t keel-web-probe .
```

Run from the repository root — the Dockerfile copies the whole workspace. Expected: the build completes. Then `docker image rm keel-web-probe`.

- [x] **Step 4: Prove the relative build boots in a browser**

This is the check that would have caught the bug, and it is the only one that exercises the real failure.

```bash
cd apps/web && VITE_SERVER_URL=/api bun run build && bun run serve
```

Open `http://localhost:4173/` and check the console. Two things matter:

- **Must not appear:** `Invalid environment variables`.
- **Expected:** network errors for `/api/...` (`404` from the preview server, or connection refused). The API is not running; the app reaching for it is the proof the env module loaded.

If the page renders nothing at all with an empty console, a stale service worker is serving a cached shell — DevTools → Application → Service Workers → Unregister, clear storage, hard reload. This is a preview artefact, not a regression.

Stop the server with Ctrl-C.

- [x] **Step 5: Prove the gate is still green**

```bash
bun run check
```

- [x] **Step 6: Commit**

```bash
git add apps/web/Dockerfile
git commit -m "fix(web): drop a SKIP_ENV_VALIDATION that never skipped anything

Set with no comment, unlike the one in apps/server/Dockerfile that guards a
real import-time validation. It cannot work here in either direction: Vite
substitutes \`process.env\` in the client bundle, so the emitted code reads
\`skipValidation:!!{}.SKIP_ENV_VALIDATION\` — always false — and \`vite build\`
never executes the module body, so there is nothing to skip at build time
either. Confirmed by building with the variable unset.

What it did do was read like the client environment was deliberately exempt
from validation, which is the opposite of true and is why a schema that
rejected the documented deployment value went unnoticed."
```

---

## Done when

- `VITE_SERVER_URL=/api bun run build` produces an SPA that boots in a browser with no `Invalid environment variables`.
- `packages/env` has a suite, and it runs under `turbo run test`.
- `bun run check` is green, and `bun tools/check-naming.ts` exits 0 with the new `packages/env` suite among the files it counted.
  > This bullet used to name a total — "`check-naming` reports 34 suites". A repository-wide total is not this plan's to promise: it stopped being true the moment the next plan landed a suite, and it reads at HEAD as 51. What this plan can be held to is that the suite it adds is on-convention and counted, which is what the assertion above says.
- `apps/web/Dockerfile` carries no `SKIP_ENV_VALIDATION`.
- `.env.example:120-122` is now a true statement about the code, with no edit to `.env.example`.

## Out of scope

- `serverOrigin` itself has no test, because `apps/web` has no test infrastructure at all. Bootstrapping it is a separate piece of work (TEST-04/TEST-08 territory). Task 1's schema test defends only the schema boundary — which values `VITE_SERVER_URL` may hold — and never executes the resolver, so nothing here proves what `serverOrigin` does with a value the schema let through.
  > Correction (post-execution): this note originally claimed "Task 1's schema test already defends the contract that broke." For one input it asserted the opposite. The suite as shipped pinned `"/"` as accepted, and `"/"` is the single relative value the resolver cannot resolve — `apps/web/src/lib/server-url.ts` strips the trailing slash, `"/"` becomes `""`, and `apps/web/src/lib/auth-client.ts` throws `TypeError: Invalid URL` on `new URL("/api/auth", "")`. The test therefore certified the boot crash this plan exists to prevent, against the rule stated in its own comment ("Anything this schema accepts and that resolver cannot resolve is a boot crash"). Closed in `24507b7`: the relative branch now requires a path segment (`value.length > 1 && !value.startsWith("//")`), and `packages/env/src/server-url.test.ts:29-31` asserts `"/"` is rejected. The schema test now defends the accept set and that one rejection; the resolver's own behaviour — the trailing-slash strip and the `window.location.origin` branch — is still untested.
- SEC-01 (`?redirect=` open redirect) also lives in `apps/web` and also concerns URL validation. Deliberately not folded in: it is a different bug with a different acceptance test, and a reviewer should be able to reject one without the other.
