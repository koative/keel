# `MAIL_DRIVER=log` Production Guard Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** SEC-04 (`plans/audit-report.md:67-73`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Goal:** Make the worker refuse to start on `MAIL_DRIVER=log` when `NODE_ENV=production`, so a deployment cannot print live verification and password-reset links into retained container logs.

**Architecture:** `writeToLog` prints the rendered message, and a rendered verification or reset message is a one-time link — a bearer credential the repo itself already classifies as "a live one-time link at rest" (`apps/server/src/tasks.ts:44-47`). Nothing refuses the combination: `resolveMailConfig` (`apps/server/src/lib/mail.ts:28`) guards `resend`-without-key and the sandbox sender, then returns the `log` config at line 56 without ever reading `NODE_ENV`. The fix adds a third guard to that same function — the repo's established place for "optional-shaped value, guarded at the point of use by a `resolve*` that throws naming it" — and then fixes the three documents that walk an operator into the hazard.

**Tech Stack:** Bun, bun:test, zod 4.4.3, `@t3-oss/env-core`, Docker Compose.

---

## Verified evidence (do not re-litigate)

Every line below was read in the working tree at `39fd32c`, not copied from the audit.

1. **The log driver prints the message bodies unconditionally.** `packages/mail/src/send.ts:25-45` — `writeToLog` writes a fixed array to stdout; `message.text` is line 38 and `message.html` is line 40. There is no truncation, no redaction and no environment check anywhere in the function. (The audit cites `send.ts:26-45`; the function declaration starts at 25.)

2. **Those bodies carry the one-time URL twice each.** `packages/mail/src/templates.ts:66-76` — `render` returns

   ```ts
   html: `…<a href="${url}" style="color:#1d4ed8">${escapeHtml(layout.action)}</a></p><p style="margin:0;font-size:14px;color:#6b7280">${FALLBACK}<br />${url}</p></div>`,
   text: `${layout.heading}\n\n${layout.lines.join("\n\n")}\n\n${layout.action}:\n${layout.url}\n`,
   ```

   and the comment above it (`templates.ts:62-64`) says why the URL is also visible text: "a client that strips anchors leaves a reader with a button-shaped nothing". Both bodies are printed, so a single dump contains the link three times. `verificationEmail` (`templates.ts:79-92`) and `passwordResetEmail` (`templates.ts:95-108`) both go through `render`, and `packages/auth/src/index.ts:161-165` and `:175-180` enqueue them with the URL Better Auth minted. (The audit cites `packages/auth/src/index.ts:174-178`; the verification hook is 175-180.)

3. **`resolveMailConfig` has no `NODE_ENV` reference at all.** `apps/server/src/lib/mail.ts` is 57 lines. The `resend` branch is 29-52, with throws at 31-34 (missing `RESEND_API_KEY`) and 42-45 (sandbox sender). Line 54-56 is the whole `log` path:

   ```ts
   // `log` is the development default: it needs no account, and writing the
   // whole message to stdout is how a developer reads a verification link.
   return { driver: "log", from: source.MAIL_FROM };
   ```

   `MailEnv` (`mail.ts:11-15`) carries three fields; `NODE_ENV` is not one of them.

4. **The env layer permits it.** `packages/env/src/server.ts:76` is a bare `MAIL_DRIVER: z.enum(["log", "resend"])`. `NODE_ENV` is line 88. The philosophy comment at 14-25 is the rule this plan follows: every key is "either required … or optional and guarded at the point of use by a `resolve*` that throws naming it. Nothing in between, and nothing silent."

5. **Production compose accepts it and retains the output.** `docker-compose.prod.yml:49` is `MAIL_DRIVER: ${MAIL_DRIVER:?MAIL_DRIVER is required}` — required, but `log` satisfies it. Line 51 pins `NODE_ENV: production`. Lines 72-76 configure `json-file` logging with `max-file: "5"` and `max-size: 10m`, so up to 50 MB of stdout per service is kept on disk and scraped by whatever collects container logs.

6. **The realistic path is worse than the audit argues, and this is the correction.** The audit frames this as an operator choosing `log`. Nobody has to choose it. `.env.example:74` ships `MAIL_DRIVER=log`, and `README.md:57` documents `cp .env.example .env # docker compose reads this one`. Following the repository's own quickstart and then running the production compose file yields a deployment that prints every magic link into retained logs, with **no error, no warning, and no failing check** — the deployment looks completely healthy. The audit's fix sketch also proposes "an explicit opt-out key"; this plan rejects that, for the reasons in **Do not**.

7. **The blast radius of the guard is the worker, and that is sufficient.** `resolveMailConfig` has exactly one non-test caller: `apps/server/src/worker.ts:45`, at module scope, commented "Resolved once, at startup, so a deployment that asked for `resend` without a key fails to boot" (`worker.ts:43-44`). The API never resolves a mail config — it only enqueues. So the guard stops `dist/worker.mjs`, which is precisely the process that would have printed the links; the leak is impossible without it. This is the same blast radius the two existing guards already have, and `README.md:278` already describes that stance as "**stops the worker at startup**".

8. **No suite is at risk.** `apps/server/test-setup.ts:30` assigns `process.env.NODE_ENV = "test"` unconditionally, and `.env.test:33` sets `MAIL_DRIVER=log`. A guard keyed on `production` cannot fire in a test run.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, 16 architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`; comment lines do not count). `apps/server/src/lib/mail.ts` is 57 lines total today and stays far under.
- **No environment variable gets a default.** This plan adds no key at all — see **Do not**. If a later change disagrees, a new key must be `.optional()`, listed in `.env.example`, and added to `apps/server/.env`, `.env.test` and `docker-compose.prod.yml`'s `x-app-env` per plan 019's pattern.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts` (`tools/check-naming.ts` enforces it). `apps/server/src/lib/mail.test.ts` already exists and is the only place these cases belong.
- An error message states what is wrong **and** what to do instead. The house style for this file is `mail.ts:32` and `mail.ts:43`: name the variable, state the consequence, give the two ways out.

## Do not

- **Do not add an opt-out key.** The audit's fix sketch asks for one and it is wrong here. A key whose only function is to disarm a security guard has to be documented in `.env.example` and `docker-compose.prod.yml` to be usable, which means the repository would ship instructions for putting credentials in its logs — and a key that exists gets copied between environments by whoever is unblocking a deploy at 2 a.m. The repo has no precedent for one: `resolveMailConfig`, `resolveAi`, `resolveStorage` and `resolveDrain` all throw unconditionally. A staging host that reports `production` and must not mail real people uses `resend` with its own key and its own verified domain — which has the second virtue of exercising the delivery path staging exists to exercise. `log` on staging means delivery is first tested in production.
- **Do not put the rule in `packages/env/src/server.ts`.** Three reasons, and the third is fatal. That layer validates *shape*, not deployment policy — every policy rule in this repo lives in a `resolve*`. A cross-field `superRefine` cannot be exercised without mutating `process.env` and re-importing a module that validates the entire environment at import (`server.ts:26-237`), which is exactly the untestability plan 001 moved a rule out of `web.ts` to avoid; `resolveMailConfig` takes its input as a parameter *specifically* so the guard can be seen firing (`mail.ts:6-9`). And it would fire at import for every process that imports `@keel/env/server` — including the `migrate` one-shot in `docker-compose.prod.yml`, which shares `x-app-env` and would then fail before applying a migration, over a driver it never uses.
- **Do not put the check in `packages/mail`.** `@keel/mail` reads no environment by design — `README.md:295-296`: "it reads no environment, so the app owns the one place `MAIL_DRIVER` becomes a config". A `NODE_ENV` read inside `writeToLog` would break that boundary and hide the refusal from startup, moving it to the first send.
- **Do not soften `writeToLog` instead.** Redacting the URL, truncating the body or printing only a subject defeats the driver's entire purpose: `send.ts:15-20` exists so a contributor can open a verification link from their terminal. The dump is correct on a laptop; the deployment is what is wrong.
- **Do not downgrade to a warning.** A warning in a container log is read by nobody, and the failure it warns about is a credential already in that same log. `mail.ts:22-26` states the house position: "Refusing to boot is louder and cheaper than either silent alternative."
- **Do not change `MAIL_DRIVER=log` in `.env.example` or `.env.test`.** Both files sit at `NODE_ENV=development` (`.env.example:61`) and `NODE_ENV=test` (`apps/server/test-setup.ts:30`) respectively, where `log` is correct and required for a fresh checkout to work. Only their comments change.
- **Do not touch the counts in `README.md`** (test/file/suite numbers) or the length of `AGENTS.md` — plan 021 owns those. Editing the prose of the mail section is in scope; editing a count is not.
- **Do not add or remove a key in `docker-compose.prod.yml`'s `x-app-env`.** Plan 019 owns that key list. This plan adds no key; it edits the comment above `MAIL_DRIVER` and the text inside that key's existing `:?` message.

## File structure

| File | Responsibility |
|---|---|
| `apps/server/src/lib/mail.ts` | **Modify.** Add `NODE_ENV` to `MailEnv` and the third guard that refuses `log` in production. |
| `apps/server/src/lib/mail.test.ts` | **Modify.** Prove the new refusal fires, and that `log` still resolves everywhere it must. |
| `.env.example` | **Modify.** Comment only: say `log` is refused in production and that there is no opt-out. |
| `docker-compose.prod.yml` | **Modify.** Comment plus the `:?` message on the existing `MAIL_DRIVER` key. No key added. |
| `README.md` | **Modify.** The production checklist row and the transactional-email section state the refusal. |

---

### Task 1: Refuse the log driver in production

**Files:**
- Modify: `apps/server/src/lib/mail.ts:4-15` (the `MailEnv` doc comment and interface), `apps/server/src/lib/mail.ts:28-29` (insert the guard at the top of the function body)
- Test: `apps/server/src/lib/mail.test.ts:7-13` (constants and `envWith`), then append cases inside the existing `describe`

**Interfaces:**
- Consumes: `resolveMailConfig(source: MailEnv = env): MailConfig` and `MailEnv { MAIL_DRIVER, MAIL_FROM, RESEND_API_KEY? }` from `apps/server/src/lib/mail.ts`; `SANDBOX_MAIL_FROM: string` from `@keel/env/server`.
- Produces: `MailEnv` gains `NODE_ENV: "development" | "production" | "test"` — a required field, so every constructor of a `MailEnv` literal must supply it. The only ones are `apps/server/src/lib/mail.test.ts:11-13` and the `env` default parameter, which already has the field (`packages/env/src/server.ts:88`).

- [x] **Step 1: Write the failing test**

In `apps/server/src/lib/mail.test.ts`, extend the guard-identifier block and the `envWith` helper. Replace lines 7-13:

```ts
/** Each guard is identified by the variable it names, which is its whole job. */
const MISSING_KEY = /RESEND_API_KEY/;
const SANDBOX_SENDER = /MAIL_FROM/;

function envWith(overrides: Partial<MailEnv>): MailEnv {
	return { MAIL_DRIVER: "log", MAIL_FROM: SANDBOX_MAIL_FROM, ...overrides };
}
```

with:

```ts
/** Each guard is identified by the variable it names, which is its whole job. */
const MISSING_KEY = /RESEND_API_KEY/;
const SANDBOX_SENDER = /MAIL_FROM/;
const LOG_IN_PRODUCTION = /NODE_ENV=production/;

// `development` is what `.env.example` ships, so this is the shape a fresh
// checkout resolves and the baseline every case here departs from by one field.
function envWith(overrides: Partial<MailEnv>): MailEnv {
	return {
		MAIL_DRIVER: "log",
		MAIL_FROM: SANDBOX_MAIL_FROM,
		NODE_ENV: "development",
		...overrides,
	};
}
```

Then append these four cases inside the existing `describe("resolveMailConfig", …)`, after the `"accepts the sandbox address on the log driver"` case that currently ends at line 61:

```ts
	it("refuses to boot when the log driver would print into production logs", () => {
		// The log driver prints `message.text` and `message.html`, and a
		// verification or password-reset body holds a live one-time link. On a
		// server that dump lands in retained, aggregated container logs — a
		// credential store nobody chose. The deployment that does this looks
		// completely healthy, which is why it has to be refused rather than warned
		// about.
		expect(() => resolveMailConfig(envWith({ NODE_ENV: "production" }))).toThrow(
			LOG_IN_PRODUCTION
		);
	});

	it.each(["development", "test"] as const)(
		"keeps the log driver working on NODE_ENV=%s",
		(nodeEnv) => {
			// The guard is about one deployment, not about the driver. A laptop and
			// a CI run both need this path: it is how a contributor opens a
			// verification link, and it is what `.env.test` selects.
			expect(resolveMailConfig(envWith({ NODE_ENV: nodeEnv }))).toEqual({
				driver: "log",
				from: SANDBOX_MAIL_FROM,
			});
		}
	);

	it("resolves resend in production, which is the way out of the refusal", () => {
		expect(
			resolveMailConfig(
				envWith({
					MAIL_DRIVER: "resend",
					MAIL_FROM: VERIFIED_FROM,
					NODE_ENV: "production",
					RESEND_API_KEY: "re_test",
				})
			)
		).toEqual({ apiKey: "re_test", driver: "resend", from: VERIFIED_FROM });
	});

	it("names the way out, not just the problem", () => {
		// The message is the whole interface of a startup refusal: whoever reads it
		// is holding a crashed worker and a compose file, and has to know both which
		// variable is wrong and what to write instead.
		expect(() => resolveMailConfig(envWith({ NODE_ENV: "production" }))).toThrow(
			/set MAIL_DRIVER to resend/
		);
	});
```

- [x] **Step 2: Run it and watch it fail for the right reason**

```bash
cd apps/server && bun test src/lib/mail.test.ts
```

Expected: `2 fail, 8 pass`. The two failures are `refuses to boot when the log driver would print into production logs` and `names the way out, not just the problem`, both reporting `expect(received).toThrow(expected)` with `Received function did not throw`. The two `it.each` cases and the `resend`-in-production case pass already — that is the point of including them: they pin behaviour that must not change.

If a failure names anything else, stop and re-read Step 1. In particular, `bun test` does not typecheck, so `NODE_ENV` in a `Partial<MailEnv>` runs fine here while `tsc --noEmit` would reject it; do not try to fix that by running the typechecker now. Step 3 is what resolves it.

- [x] **Step 3: Teach `MailEnv` about the deployment**

In `apps/server/src/lib/mail.ts`, replace lines 4-15 — the doc comment and the interface — because the comment counts the fields and would be wrong otherwise. Before:

```ts
/**
 * The three deployment inputs `resolveMailConfig` reads.
 *
 * Taken as a parameter rather than closed over so the startup guard below can be
 * exercised without a process-wide environment: the guard is the only reason
 * this function exists, and a guard nobody has seen fire is not a guard.
 */
export interface MailEnv {
	MAIL_DRIVER: "log" | "resend";
	MAIL_FROM: string;
	RESEND_API_KEY?: string | undefined;
}
```

After:

```ts
/**
 * The four deployment inputs `resolveMailConfig` reads.
 *
 * Taken as a parameter rather than closed over so the startup guard below can be
 * exercised without a process-wide environment: the guard is the only reason
 * this function exists, and a guard nobody has seen fire is not a guard.
 *
 * NODE_ENV is here because one of the guards is about the deployment rather than
 * the driver: `log` is correct on a laptop and a credential leak on a server.
 */
export interface MailEnv {
	MAIL_DRIVER: "log" | "resend";
	MAIL_FROM: string;
	NODE_ENV: "development" | "production" | "test";
	RESEND_API_KEY?: string | undefined;
}
```

- [x] **Step 4: Add the guard**

Still in `apps/server/src/lib/mail.ts`, insert the refusal as the first statement of the function body — immediately after `export function resolveMailConfig(source: MailEnv = env): MailConfig {` (line 28 before this edit) and before the existing `if (source.MAIL_DRIVER === "resend") {`:

```ts
	// The log driver prints `message.text` and `message.html` in full, and a
	// verification or password-reset body is a live one-time link — the same
	// payload `tasks.ts` sweeps out of the job table early because it is "a live
	// one-time link at rest". Container logs are retained and aggregated far more
	// widely than the database, so on a server that dump is a credential store
	// nobody decided to run. Nothing else refuses it: `.env.example` ships
	// MAIL_DRIVER=log, the production compose file accepts it, and the deployment
	// that results looks completely healthy.
	//
	// No opt-out key. A key whose only job is to disarm this would have to be
	// documented to be usable, and a documented way to log credentials is one that
	// gets used. A host that reports production and must not mail real people uses
	// `resend` with its own key and its own verified domain — which is also the
	// only way to find out whether delivery works before real users do.
	if (source.NODE_ENV === "production" && source.MAIL_DRIVER === "log") {
		throw new Error(
			"MAIL_DRIVER=log is refused when NODE_ENV=production. The log driver prints every message to stdout, and a verification or password-reset message holds a live one-time link, so each one would be written to the container logs. Set MAIL_DRIVER to resend with a RESEND_API_KEY and a verified MAIL_FROM, or set NODE_ENV to the environment this deployment actually is."
		);
	}

```

The message names the variable, the reason and both fixes, matching `mail.ts:32` and `mail.ts:43`.

- [x] **Step 5: Run the test and watch it pass**

```bash
cd apps/server && bun test src/lib/mail.test.ts
```

Expected: `10 pass, 0 fail`, all in `resolveMailConfig`.

- [x] **Step 6: Prove the refusal reaches the process it is meant to stop**

The unit test proves the function. This proves the worker, which is the only caller (`apps/server/src/worker.ts:45`):

```bash
cd apps/server && NODE_ENV=production MAIL_DRIVER=log bun run src/worker.ts
```

Expected: the process exits non-zero before polling, printing the `MAIL_DRIVER=log is refused when NODE_ENV=production` message. It must not print a `[mail]` banner and must not reach the poll loop. Environment note: this run reads `apps/server/.env`, and the two variables set on the command line win over it. `new Pool` in `packages/db/src/index.ts:17` is constructed at import but issues no query, so the throw at `worker.ts:45` lands before the worker touches the database — a running Postgres is not required for this check.

- [x] **Step 7: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful. No new suite file, so the `check-naming` suite count is unchanged; 16 architecture rules verified; migrations match.

- [x] **Step 8: Commit**

```bash
git add apps/server/src/lib/mail.ts apps/server/src/lib/mail.test.ts
git commit -m "fix(server): refuse MAIL_DRIVER=log when NODE_ENV=production

The log driver prints \`message.text\` and \`message.html\` in full, and both
bodies carry the one-time URL — \`render\` puts it in the href, in visible text
beside it, and in the plain-text body, on purpose, so a client that strips
anchors still leaves the reader a way to continue. On a laptop that dump is the
feature: it is how a contributor opens a verification link without a provider
account. On a server it writes a bearer credential into json-file logs that
\`docker-compose.prod.yml\` retains at five files of ten megabytes and that
something is almost certainly scraping. This repo already classifies that
payload as \"a live one-time link at rest\" in tasks.ts, which is why a settled
mail job is swept within three days — and then the same bytes were printed to
stdout with nothing to sweep them.

Nothing refused it. \`.env.example\` ships MAIL_DRIVER=log, the README documents
\`cp .env.example .env\` as the compose input, and the production compose file
requires the variable but accepts that value while pinning NODE_ENV=production.
So the quickstart, followed exactly, produced a deployment leaking every magic
link with no error, no warning and nothing failing.

The guard goes in \`resolveMailConfig\` beside the two that already throw there:
it is the repo's place for a deployment-policy check, it takes its environment
as a parameter so the guard can be seen firing, and it runs at worker startup —
which is the only process that would have printed anything. A cross-field rule
in \`packages/env\` would instead fire at import for every process sharing
\`x-app-env\`, including the migrate one-shot, over a driver it never uses.

No opt-out key, deliberately. A key whose only function is to disarm this would
have to be documented to be usable, and a documented way to write credentials
into a log is one that gets used. A staging host that reports production and
must not mail real people uses resend with its own key and domain, which is also
how it finds out whether delivery works before real users do.

Verified both halves: the suite covers the refusal, that \`log\` still resolves on
development and test, and that resend still resolves under production; and
\`NODE_ENV=production MAIL_DRIVER=log bun run src/worker.ts\` now exits naming the
variable instead of starting to poll."
```

---

### Task 2: Stop the documents from walking an operator into it

**Files:**
- Modify: `.env.example:69-74`
- Modify: `docker-compose.prod.yml:46-49`
- Modify: `README.md:103` and `README.md:281-283`
- Test: none. This task changes no code; `bun run check` is the gate, and Task 1's suite already covers the behaviour these documents describe.

**Interfaces:**
- Consumes: the guard and its exact error text from Task 1. Do not start this task before Task 1 is committed — every sentence below asserts a refusal that must already exist.
- Produces: nothing other code depends on.

- [ ] **Step 1: Say it where the value is chosen**

`.env.example:74` is the line that puts `log` into a deployment. Replace lines 69-74:

```
# How transactional mail leaves the process: log | resend. `log` prints the whole
# message to stdout and sends nothing, so a clone of this repo can sign up, verify
# an address and accept an invitation with no provider account. A deployment that
# wants mail delivered says `resend` and sets RESEND_API_KEY below; `resend` without
# a key fails at startup rather than at the first send.
MAIL_DRIVER=log
```

with:

```
# How transactional mail leaves the process: log | resend. `log` prints the whole
# message to stdout and sends nothing, so a clone of this repo can sign up, verify
# an address and accept an invitation with no provider account. A deployment that
# wants mail delivered says `resend` and sets RESEND_API_KEY below; `resend` without
# a key fails at startup rather than at the first send.
#
# `log` is refused outright when NODE_ENV=production, and the worker will not
# start: the message it prints holds a live verification or password-reset link,
# and container logs are retained and read far more widely than the database.
# There is no opt-out key. A host that should not mail real people uses `resend`
# with a key and a verified domain of its own.
MAIL_DRIVER=log
```

The value stays `log`. This file sits at `NODE_ENV=development` (line 61), where `log` is right and required for `bun run dev` to work.

- [ ] **Step 2: Say it where the value is required**

In `docker-compose.prod.yml`, replace lines 46-49:

```yaml
  # `resend` also needs RESEND_API_KEY, and a MAIL_FROM on a domain verified with
  # Resend — the sandbox sender in .env.example reaches nobody but the account
  # owner, and the server refuses to start on it.
  MAIL_DRIVER: ${MAIL_DRIVER:?MAIL_DRIVER is required}
```

with:

```yaml
  # `resend` is the only value that boots here. This file pins NODE_ENV=production
  # below, and the worker refuses `log` there — it prints every verification and
  # reset link into the json-file logs this file then retains. `resend` also needs
  # RESEND_API_KEY, and a MAIL_FROM on a domain verified with Resend — the sandbox
  # sender in .env.example reaches nobody but the account owner, and the server
  # refuses to start on it too.
  MAIL_DRIVER: ${MAIL_DRIVER:?MAIL_DRIVER is required, and on a server it is resend}
```

No key is added or removed — plan 019 owns the `x-app-env` key list. The `:?` text now matches the `LOG_DRAIN` line above it (line 45), which already reads "and on a server it is otlp".

- [ ] **Step 3: Say it in the production checklist**

`README.md:103` currently frames `log` in production as delivery failure only. Replace that table row:

```
| `MAIL_DRIVER=resend` + `RESEND_API_KEY` + `MAIL_FROM` | `log` writes every message to stdout and sends nothing. That is right on a laptop and silent data loss on a server: verification and password reset both stop working while the deployment looks healthy. `MAIL_FROM` has to be an address on a domain verified with Resend — the sandbox sender `.env.example` ships reaches nobody but the account owner, so `resend` refuses to start on it. |
```

with:

```
| `MAIL_DRIVER=resend` + `RESEND_API_KEY` + `MAIL_FROM` | `log` writes every message to stdout and sends nothing. That is right on a laptop and two failures on a server: verification and password reset stop working, and every one-time link they printed is now in the container logs. So the worker refuses `log` when `NODE_ENV=production`, with no opt-out key. `MAIL_FROM` has to be an address on a domain verified with Resend — the sandbox sender `.env.example` ships reaches nobody but the account owner, so `resend` refuses to start on it. |
```

Leave every count in this file alone — plan 021 owns those.

- [ ] **Step 4: Say it in the section that explains the adapter**

In `README.md`, the mail paragraph ends at line 283 with "…so a verified domain has to replace it." Insert a new paragraph immediately after it, before the blank line preceding `**Every send goes through the queue.**`:

```
**`log` is refused when `NODE_ENV=production`, and that is the third startup
guard.** The banner is honest about not sending, but the dump under it is the
message, and a verification or reset message is a one-time link — a bearer
credential. Printing it is the entire point on a laptop, where it is how a
contributor opens the link; on a server it writes that credential into logs that
are retained, shipped and read far more widely than the database. There is no
opt-out key: a key whose only job is to disarm a guard is a key that gets copied
into production. A host that reports `production` and should not mail real people
uses `resend` with its own key and its own verified domain, which is also the only
way to learn whether delivery works before a user does.
```

- [ ] **Step 5: Prove the compose file still parses**

```bash
docker compose -f docker-compose.prod.yml config >/dev/null
```

Expected: it fails naming a *missing variable*, not a YAML error — with no deploy environment exported, the first unsatisfied `:?` key is reported. `error while interpolating` on a key name is the pass condition here; a parser error mentioning a line number is not. If Docker is unavailable on the machine, skip this step and rely on Step 6.

- [ ] **Step 6: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful, unchanged from Task 1 — no source file was touched.

- [ ] **Step 7: Commit**

```bash
git add .env.example docker-compose.prod.yml README.md
git commit -m "docs: say that production refuses the log mail driver

The guard landed in the previous commit; these are the three documents that used
to walk an operator into the thing it now refuses. \`.env.example\` ships
MAIL_DRIVER=log and the README tells you to copy that file to the one compose
reads, so the quickstart itself selected the driver. The prod compose file
required the variable without saying which value it would actually accept, and
the production checklist framed \`log\` on a server as delivery failure only —
true, and the smaller half. The other half is that every printed message holds a
live one-time link.

The value in \`.env.example\` stays \`log\`: that file sits at
NODE_ENV=development, where the driver is correct and a fresh checkout needs it.
Only the comment changes. The compose \`:?\` message now names the value that
boots, matching the LOG_DRAIN line directly above it. No key was added to
x-app-env.

Verified with \`docker compose -f docker-compose.prod.yml config\`, which still
fails on a missing variable rather than on parsing, and \`bun run check\`."
```

---

## Done when

- `NODE_ENV=production MAIL_DRIVER=log bun run src/worker.ts` in `apps/server` exits non-zero with a message naming `MAIL_DRIVER`, `NODE_ENV=production` and `resend`, before any `[mail]` output.
- `apps/server/src/lib/mail.test.ts` reports `10 pass, 0 fail`, covering the refusal, its message, `log` on `development` and `test`, and `resend` on `production`.
- `resolveMailConfig` returns the `log` config unchanged for every non-production `NODE_ENV`, so `bun run dev`, `bun test` and a fresh `cp .env.example apps/server/.env` checkout behave exactly as before.
- No new environment variable exists anywhere: `MAIL_DRIVER`, `MAIL_FROM` and `RESEND_API_KEY` are still the only mail keys in `packages/env/src/server.ts`, `.env.example`, `.env.test`, `apps/server/.env` and `docker-compose.prod.yml`.
- `.env.example`, `docker-compose.prod.yml` and `README.md` each state that `log` is refused in production and that there is no opt-out.
- `bun run check` passes.

## Out of scope

- **Redacting the URL from the log driver.** `writeToLog` keeps printing the whole message, because that is what the driver is for and the driver is now unreachable in production.
- **Making the API server refuse too.** `resolveMailConfig` has one non-test caller, `apps/server/src/worker.ts:45`, and the worker is the only process that can print a message. Resolving a mail config in the API purely to refuse would add a second call site with no delivery behind it.
- **SEC-03, the `TRUSTED_IP_HEADER` production guard** (`plans/audit-report.md:59-65`). The same shape of fix in the same style, on a different variable with a different acceptance test; a reviewer should be able to reject one without the other.
- **The `x-app-env` key list in `docker-compose.prod.yml`** — plan 019 owns it. This plan edits one comment and one `:?` message and adds no key.
- **`README.md` counts and `AGENTS.md` length** — plan 021 owns those.
- **Mail payload retention in the `job` table.** `apps/server/src/tasks.ts:44-47` already sweeps settled mail rows for exactly this reason; nothing here changes it.
