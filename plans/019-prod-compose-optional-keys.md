# Production Compose Optional-Key Forwarding Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** DOCS-03 (`plans/audit-report.md:375-381`)
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Goal:** Make `docker-compose.prod.yml` forward every key `packages/env` declares, and make a script — not a paragraph in `AGENTS.md` — the thing that keeps it that way.

**Architecture:** `packages/env/src/server.ts` declares every server key in one object, a majority of them `.optional()` (31 keys / 16 optional at the audited commit `39fd32c`; 32 / 17 at HEAD, since `WEBHOOK_SECRET` landed later). `docker-compose.prod.yml`'s `x-app-env` anchor forwards 21 of them, and eleven schema keys are simply absent from it: `AI_API_KEY`, `AI_MODEL`, `SECRETS_ENCRYPTION_KEY` and all eight `STORAGE_*`. Every service in that file uses `environment: *app-env` with no `env_file`, so the anchor is the entire container boundary — a key it omits is a key the deploy exported and the process never receives. Task 1 adds the eleven in the `${VAR:-}` form the file already uses; Task 2 adds `tools/check-env.ts` so the omission cannot recur silently.

**Tech Stack:** Bun (`Bun.file`, top-level await), Docker Compose v2 interpolation, `@t3-oss/env-core` + zod 4.4.3 (read as text, never imported), Biome/Ultracite.

**Ownership:** This plan owns `docker-compose.prod.yml`'s `x-app-env` key list. Any other plan that needs a new environment key adds it per this plan's pattern and does not restate the block.

---

## Verified evidence (do not re-litigate)

Everything below was checked against the working tree at `39fd32c`, not copied from the audit. The audit's list is exactly right and complete; its impact statement is also correct, and this section only sharpens the mechanism.

1. **The rule is stated in the repo, in prose.** `AGENTS.md:66-69`:

   > Adding `.default(…)` to that schema is how a deployment ends up mailing to stdout or dropping every wide event while looking healthy; add the key to `.env.example`, `apps/server/.env`, `.env.test` and `docker-compose.prod.yml`'s `x-app-env` instead.

   Nothing executes that sentence. `bun run check` runs `check-catalog`, `check-naming`, `check-rules` and `check-migrations` (`package.json:49`) and none of them reads a compose file.

2. **The counts, as measured at the audited commit `39fd32c`.** They are a snapshot, not an invariant — every later plan that adds a key moves all three (at HEAD the first two are 32 and 17, because the webhook work added `WEBHOOK_SECRET` and forwarded it at `docker-compose.prod.yml:99`). What matters below is the *set difference*, which is stable: eleven declared keys the anchor does not forward.

   ```
   grep -cE '^\t\t[A-Z][A-Z0-9_]*:' packages/env/src/server.ts   → 31   schema keys
   grep -cE '\.optional\(\)'        packages/env/src/server.ts   → 16   optional
   sed -n '29,71p' docker-compose.prod.yml | grep -cE '^  [A-Za-z_][A-Za-z0-9_]*:' → 21  forwarded
   ```

   Of the 21 forwarded, 20 are schema keys plus `TZ`, which `@keel/env` does not declare and which is a container concern (`docker-compose.prod.yml:65-68`). Five of the 16 optional keys are forwarded — `OTLP_ENDPOINT` (`:52`), `OTLP_HEADERS` (`:53`), `RESEND_API_KEY` (`:56`), `TRUSTED_IP_HEADER` (`:63`), `TRUSTED_PROXIES` (`:64`).

3. **The eleven absent keys, verified by name against `packages/env/src/server.ts`:**

   | Key | Declared at | Guard that throws |
   |---|---|---|
   | `AI_API_KEY` | `server.ts:35` | `resolveAi`, `apps/server/src/lib/ai.ts:25-29` |
   | `AI_MODEL` | `server.ts:46` | `resolveAi`, `apps/server/src/lib/ai.ts:34-38` |
   | `SECRETS_ENCRYPTION_KEY` | `server.ts:135` | the `@keel/crypto/seal` read path |
   | `STORAGE_ACCESS_KEY_ID` | `server.ts:154` | `resolveStorage`, `apps/server/src/lib/storage.ts:79-94` |
   | `STORAGE_ACCOUNT_ID` | `server.ts:156` | `resolveStorage`, `storage.ts:106-108` |
   | `STORAGE_BUCKET` | `server.ts:157` | `resolveStorage`, `storage.ts:79-94` |
   | `STORAGE_ENDPOINT` | `server.ts:163` | `resolveStorage`, `storage.ts:106-108` |
   | `STORAGE_FORCE_PATH_STYLE` | `server.ts:173` | `resolveStorage`, `storage.ts:106-108` |
   | `STORAGE_PROVIDER` | `server.ts:182` | `resolveStorage`, `storage.ts:79-94` |
   | `STORAGE_REGION` | `server.ts:186` | `resolveStorage`, `storage.ts:106-108` |
   | `STORAGE_SECRET_ACCESS_KEY` | `server.ts:187` | `resolveStorage`, `storage.ts:79-94` |

   Eight `STORAGE_*` keys, counted off `apps/server/src/lib/storage.ts:19-28` (`StorageEnv`) as well as the schema. The two lists agree.

4. **There is no mitigation in the production file.** Measured:

   ```
   grep -c "env_file" docker-compose.prod.yml            → 0
   grep -c "environment: \*app-env" docker-compose.prod.yml → 3
   ```

   The development file is the contrast, and it is why this is easy to miss: `docker-compose.yml:67-70`, `:106-109` and `:123-126` pair `environment: *app-env` with `env_file: apps/server/.env`, so a key missing from that anchor still arrives. The production file has no such second channel.

5. **The failure end to end.** With a deploy environment that exports `AI_API_KEY` and the storage keys:

   ```bash
   docker compose -f docker-compose.prod.yml --env-file <deploy.env> config \
     | grep -cE "AI_API_KEY|STORAGE_|SECRETS_ENCRYPTION_KEY"
   → 0
   ```

   Compose is not warning about anything; it resolves cleanly and produces a container that never sees the variables. `resolveAi` then throws `AI_API_KEY is required to run an ai.generate job…` (`ai.ts:27`) on the first such job, naming a key the operator did set — the silent-failure mode the whole `resolve*`-guard design exists to prevent.

6. **`.env.example` is already complete.** Every schema key appears there, the optional ones commented out under the `── Optional ──` heading (`.env.example:124-209`). This plan changes nothing in it, and Task 2's guard passes that half of the check on the current tree.

7. **`.env.test` is not a mirror of the schema and must not be treated as one.** It holds 13 keys and omits `NODE_ENV` and `DATABASE_URL`, which both test preloads assign themselves (`.env.test:14-46`). Task 2's guard deliberately does not check it.

8. **There is no YAML library to parse the compose file with.** `yaml@2.9.0` and `js-yaml@4.3.1` are in the lockfile, but `grep -rn '"yaml"\|"js-yaml"' --include=package.json apps packages package.json` returns nothing: both are transitive dependencies of tooling, declared by no manifest in this workspace. Task 2's hand-rolled parser is a consequence of that fact, not a shortcut.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, the architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`; comment lines do not count).
- **No environment variable gets a default** — not in `packages/env`, not in a compose file, not behind a `??`. `${VAR:-}` is not a default: it forwards an absent variable as the empty string, and `emptyStringAsUndefined: true` (`packages/env/src/server.ts:27`) turns it back into `undefined` on the other side. `${VAR:-something}` would be a default and is prohibited.
- Adding a key means adding it to `.env.example`, `apps/server/.env`, `.env.test` **and** `docker-compose.prod.yml`'s `x-app-env`. This plan adds no key; it forwards keys that already exist.
- Scripts in `tools/` are `package.json` entry points named after the command they implement. `tools/check-naming.ts` scopes itself to `apps/*` and `packages/*`, so `tools/` is outside it by definition — a new script there needs no blessing and gets no `.test.ts`.
- `tools/**` is covered by the Biome override at `biome.jsonc:155-174`, which turns off `noProcessEnv` there. No new exemption is needed by this plan, so no fixture is added to `tools/check-rules.ts`.

## Do not

- **Do not use the `${VAR:?message}` form for any of the eleven keys.** All eleven are `.optional()` in the schema because the features behind them are opt-in. `:?` makes Compose refuse the deploy when the variable is unset, so every deployment that does not use AI, sealed secrets or object storage would stop deploying. The file's own header comment states the split at `docker-compose.prod.yml:35-38`: required keys use `:?`, `:-` appears only where `@keel/env` says `.optional()`.
- **Do not give any of them a value.** `${STORAGE_PROVIDER:-r2}` is exactly the class of change `2bc6791` removed from this repository.
- **Do not add `env_file:` to `docker-compose.prod.yml` as a shortcut.** It would work, and it would import the development file's mechanism into the file that exists to be different from it: the header at `:10-13` states that the prod file takes every value from the deploy's own environment so the two never share a value by accident. A `.env` sitting on a server next to a checkout is how a staging secret reaches production.
- **Do not add a YAML dependency to the root catalog for Task 2.** `x-app-env` is a flat map of scalars; `check-catalog.ts` would then also demand a workspace consume the new catalog entry (`tools/check-catalog.ts:69-75`), and reading a transitive `yaml` that no manifest declares breaks on the next `bun update`.
- **Do not import `packages/env/src/server.ts` from the guard.** It calls `createEnv` at module scope and validates the whole environment on import, so a CI run with no `apps/server/.env` throws before the script gets a key list. Read it as text.
- **Do not extend Task 2's guard to `.env.test` or `apps/server/.env`.** The first is a fixture holding only what a test run needs (evidence 7); the second is untracked, so a check that reads it fails in CI.
- **Do not touch `README.md` or `AGENTS.md`.** Plan 021 owns README counts and AGENTS.md length. `AGENTS.md:66-69` stays as written — Task 2 makes that sentence executable, it does not replace it.

## File structure

| File | Responsibility |
|---|---|
| `docker-compose.prod.yml:39-70` | **Modify.** The `x-app-env` key list gains the eleven absent keys, alphabetically, in the `${VAR:-}` form. |
| `tools/check-env.ts` | **Create.** Asserts every schema key is documented in `.env.example` and forwarded by `x-app-env`, and that an optional key is never forwarded with `:?`. |
| `package.json:49` | **Modify.** Wire `check-env` into `bun run check`. |

---

### Task 1: Forward the eleven absent keys

**Files:**
- Modify: `docker-compose.prod.yml:39-70`

**Interfaces:**
- Consumes: nothing.
- Produces: an `x-app-env` block containing every key `packages/env/src/server.ts` declares, plus `TZ`. Task 2's guard asserts exactly this — key for key, not by count.

- [x] **Step 1: Watch the keys vanish at the container boundary**

Write a throwaway deploy environment. Everything the file marks `:?` has to be present or Compose refuses to render at all, which is the point of that form:

```bash
cat > /tmp/keel-deploy.env <<'EOF'
BETTER_AUTH_SECRET=0123456789012345678901234567890123
BETTER_AUTH_URL=https://api.example.com
BODY_LIMIT_BYTES=1048576
CORS_ORIGIN=https://app.example.com
DATABASE_POOL_MAX=10
POSTGRES_DB=keel
POSTGRES_PASSWORD=secret
LOG_DRAIN=otlp
MAIL_DRIVER=log
MAIL_FROM=Keel <hi@example.com>
RATE_LIMIT_READ_PER_MINUTE=600
RATE_LIMIT_WRITE_PER_MINUTE=60
STATEMENT_TIMEOUT_MS=15000
WORKER_BATCH_SIZE=10
WORKER_POLL_MS=1000
VITE_SERVER_URL=/api
AI_API_KEY=sk-or-test
AI_MODEL=openai/gpt-4o-mini
STORAGE_PROVIDER=r2
STORAGE_BUCKET=keel-files
EOF

docker compose -f docker-compose.prod.yml --env-file /tmp/keel-deploy.env config \
  | grep -cE "AI_API_KEY|STORAGE_|SECRETS_ENCRYPTION_KEY"
```

Expected: `0`, and `grep` exits 1. The four keys the deploy set are not in the rendered configuration and Compose said nothing about it. If you get a non-zero count, someone has already applied this task — stop and re-read `docker-compose.prod.yml:39-70`.

- [x] **Step 2: Work out the ordering before editing**

The block is strictly alphabetical by key name, across required and optional alike — `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`, `BODY_LIMIT_BYTES`, `CORS_ORIGIN`, … , `TZ`, `WORKER_BATCH_SIZE`, `WORKER_POLL_MS`. It is not grouped by subsystem and not ordered required-first. `packages/env/src/server.ts` uses the same order, which is what makes the two readable side by side.

That fixes all eleven placements: `AI_*` above `BETTER_AUTH_SECRET`; `SECRETS_ENCRYPTION_KEY` between `RESEND_API_KEY` and `STATEMENT_TIMEOUT_MS` (`SE` < `ST`); the eight `STORAGE_*` between `STATEMENT_TIMEOUT_MS` and `TRUSTED_IP_HEADER` (`STA` < `STO`). Confirm with:

```bash
sed -n '39,70p' docker-compose.prod.yml | grep -oE '^  [A-Z][A-Z0-9_]*' | sort -c && echo "alphabetical"
```

Expected: `alphabetical`.

- [x] **Step 3: Replace the key list**

Replace lines 39-70 of `docker-compose.prod.yml` — the keys only. Leave the anchor and its header comment at lines 29-38 exactly as they are; they already explain the `:?` / `:-` split and this task does not change that rule, it applies it. The replacement begins with a blank line so the AI note reads as its own paragraph rather than a continuation of the header:

```yaml

  # AI is opt-in and both halves are guarded together by `resolveAi`, which throws
  # on the first `ai.generate` job naming whichever is unset. Forwarded in the `:-`
  # form so a deployment that never enqueues one still deploys.
  AI_API_KEY: ${AI_API_KEY:-}
  AI_MODEL: ${AI_MODEL:-}
  BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?BETTER_AUTH_SECRET is required}
  BETTER_AUTH_URL: ${BETTER_AUTH_URL:?BETTER_AUTH_URL is required}
  BODY_LIMIT_BYTES: ${BODY_LIMIT_BYTES:?BODY_LIMIT_BYTES is required}
  CORS_ORIGIN: ${CORS_ORIGIN:?CORS_ORIGIN is required}
  DATABASE_POOL_MAX: ${DATABASE_POOL_MAX:?DATABASE_POOL_MAX is required}
  DATABASE_URL: postgresql://postgres:${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}@postgres:5432/${POSTGRES_DB:?POSTGRES_DB is required}
  LOG_DRAIN: ${LOG_DRAIN:?LOG_DRAIN is required, and on a server it is otlp}
  # `resend` also needs RESEND_API_KEY, and a MAIL_FROM on a domain verified with
  # Resend — the sandbox sender in .env.example reaches nobody but the account
  # owner, and the server refuses to start on it.
  MAIL_DRIVER: ${MAIL_DRIVER:?MAIL_DRIVER is required}
  MAIL_FROM: ${MAIL_FROM:?MAIL_FROM is required}
  NODE_ENV: production
  OTLP_ENDPOINT: ${OTLP_ENDPOINT:-}
  OTLP_HEADERS: ${OTLP_HEADERS:-}
  RATE_LIMIT_READ_PER_MINUTE: ${RATE_LIMIT_READ_PER_MINUTE:?RATE_LIMIT_READ_PER_MINUTE is required}
  RATE_LIMIT_WRITE_PER_MINUTE: ${RATE_LIMIT_WRITE_PER_MINUTE:?RATE_LIMIT_WRITE_PER_MINUTE is required}
  RESEND_API_KEY: ${RESEND_API_KEY:-}
  # Keys the AES-256-GCM cipher in `@keel/crypto/seal`. A deployment that stores no
  # third-party secrets needs none, and the code path that reads it refuses rather
  # than writing plaintext.
  SECRETS_ENCRYPTION_KEY: ${SECRETS_ENCRYPTION_KEY:-}
  STATEMENT_TIMEOUT_MS: ${STATEMENT_TIMEOUT_MS:?STATEMENT_TIMEOUT_MS is required}
  # An S3-compatible bucket. Every key is optional, provider included: nothing in the
  # starter stores a file yet, so `resolveStorage()` is the guard and it throws naming
  # whichever is missing the first time storage is asked for. Which of these a
  # deployment sets depends on STORAGE_PROVIDER — see .env.example.
  STORAGE_ACCESS_KEY_ID: ${STORAGE_ACCESS_KEY_ID:-}
  STORAGE_ACCOUNT_ID: ${STORAGE_ACCOUNT_ID:-}
  STORAGE_BUCKET: ${STORAGE_BUCKET:-}
  STORAGE_ENDPOINT: ${STORAGE_ENDPOINT:-}
  STORAGE_FORCE_PATH_STYLE: ${STORAGE_FORCE_PATH_STYLE:-}
  STORAGE_PROVIDER: ${STORAGE_PROVIDER:-}
  STORAGE_REGION: ${STORAGE_REGION:-}
  STORAGE_SECRET_ACCESS_KEY: ${STORAGE_SECRET_ACCESS_KEY:-}
  # Better Auth resolves the client IP from headers only. Leave this unset unless a
  # proxy you control rewrites the header, and read the README before setting it:
  # unset means one shared rate-limit bucket, set-but-forgeable means none at all.
  # TRUSTED_PROXIES is required alongside it whenever the header can hold more than
  # one address, which is the normal case.
  TRUSTED_IP_HEADER: ${TRUSTED_IP_HEADER:-}
  TRUSTED_PROXIES: ${TRUSTED_PROXIES:-}
  # Pinned rather than inherited from the base image, because the Better Auth tables
  # use `timestamp` without a zone while domain tables use `timestamptz`. A base
  # image that changes its default would silently desync the two.
  TZ: UTC
  WORKER_BATCH_SIZE: ${WORKER_BATCH_SIZE:?WORKER_BATCH_SIZE is required}
  WORKER_POLL_MS: ${WORKER_POLL_MS:?WORKER_POLL_MS is required}
```

- [x] **Step 4: Prove the YAML still parses**

```bash
docker compose -f docker-compose.prod.yml config --no-interpolate --quiet && echo "YAML OK"
```

Expected: `YAML OK`. `--no-interpolate` is what lets this run without a deploy environment; it validates structure and the anchor without substituting anything.

- [x] **Step 5: Prove the keys now cross the boundary**

Re-run Step 1's command against the edited file:

```bash
docker compose -f docker-compose.prod.yml --env-file /tmp/keel-deploy.env config \
  | grep -cE "^ +(AI_API_KEY|AI_MODEL|SECRETS_ENCRYPTION_KEY|STORAGE_[A-Z_]+):"
```

Expected: `44` — eleven keys, once in the rendered `x-app-env` extension field and once in each of the three services that use `environment: *app-env` (`migrate`, `worker`, `server`).

Then look at the values:

```bash
docker compose -f docker-compose.prod.yml --env-file /tmp/keel-deploy.env config \
  | grep -E "^ +(AI_API_KEY|AI_MODEL|SECRETS_ENCRYPTION_KEY|STORAGE_[A-Z_]+):" | sort -u
```

Expected, exactly:

```
      AI_API_KEY: sk-or-test
      AI_MODEL: openai/gpt-4o-mini
      SECRETS_ENCRYPTION_KEY: ""
      STORAGE_ACCESS_KEY_ID: ""
      STORAGE_ACCOUNT_ID: ""
      STORAGE_BUCKET: keel-files
      STORAGE_ENDPOINT: ""
      STORAGE_FORCE_PATH_STYLE: ""
      STORAGE_PROVIDER: r2
      STORAGE_REGION: ""
      STORAGE_SECRET_ACCESS_KEY: ""
```

The four keys the deploy set arrive with their values; the seven it did not arrive as `""`, which `emptyStringAsUndefined: true` (`packages/env/src/server.ts:27`) turns back into `undefined`. That is the whole reason the `:-` form is safe here and a `:-value` form would not be.

- [x] **Step 6: Prove an unset deployment still deploys**

```bash
grep -vE '^(AI_|STORAGE_)' /tmp/keel-deploy.env > /tmp/keel-deploy-minimal.env
docker compose -f docker-compose.prod.yml --env-file /tmp/keel-deploy-minimal.env config --quiet \
  && echo "deploys without AI or storage"
```

Expected: `deploys without AI or storage`. This is the check that would fail if any of the eleven had been written with `:?`.

- [x] **Step 7: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful. Nothing in `bun run check` reads a compose file yet — that is what Task 2 fixes — so this step is confirming the edit broke nothing, not that it is correct. Steps 4-6 are this task's correctness evidence.

- [x] **Step 8: Clean up the throwaway files**

```bash
rm -f /tmp/keel-deploy.env /tmp/keel-deploy-minimal.env
```

- [x] **Step 9: Commit**

```bash
git add docker-compose.prod.yml
git commit -m "fix(deploy): prod compose dropped eleven keys the schema declares

\`packages/env\` declares 31 keys and \`x-app-env\` forwarded 20 of them, so
AI_API_KEY, AI_MODEL, SECRETS_ENCRYPTION_KEY and all eight STORAGE_* never
crossed the container boundary. Every service in this file uses
\`environment: *app-env\` and, unlike docker-compose.yml, none of them has an
\`env_file\` to arrive by — so the anchor is the whole boundary and a key absent
from it is a key the deploy exported into nothing.

Compose does not complain about that; it renders cleanly. The variable is set on
the host, the container starts, and \`resolveAi\` or \`resolveStorage\` throws hours
later naming a key the operator did set. That is the failure the guards were
written to make loud, arriving as its opposite.

All eleven use the \`\${VAR:-}\` pass-through the five already-forwarded optional
keys use, never \`:?\`: each belongs to an opt-in feature, and demanding them
would stop every deployment that does not use AI, sealed secrets or object
storage. An absent variable arrives as the empty string and
\`emptyStringAsUndefined\` turns it back into \`undefined\`, so nothing is defaulted.

Verified against \`docker compose config\` with a deploy environment: 0 of the
eleven rendered before, all eleven after, four carrying their values and seven
as \"\"; and a deploy environment with no AI or storage keys still renders."
```

---

### Task 2: Make the rule executable

**Files:**
- Create: `tools/check-env.ts`
- Modify: `package.json:49`

**Interfaces:**
- Consumes: Task 1's completed `x-app-env` block. Run before Task 1 this script reports eleven problems, which is correct but makes it impossible to land green.
- Produces: `bun tools/check-env.ts`, exit 0 with a one-line summary or exit 1 with one line per problem. Nothing imports it.

- [x] **Step 1: Decide how to read the schema, and why not to import it**

`packages/env/src/server.ts:26` calls `createEnv` at module scope, which validates the whole server environment. Importing it from a check that CI runs without `apps/server/.env` throws before the script sees a single key name. So the schema is read as text.

A regex over the text is sound here because Biome fixes the shape: every key in the `server: {}` object sits at exactly two tabs (`/^\t\t([A-Z][A-Z0-9_]*):/`), and every continuation line of a multi-line declaration — `STORAGE_PROVIDER`, `TRUSTED_PROXIES` — sits at three or more. Confirm the count before writing anything that depends on it:

```bash
grep -cE '^\t\t[A-Z][A-Z0-9_]*:' packages/env/src/server.ts
grep -cE '\.optional\(\)' packages/env/src/server.ts
```

Expected: two numbers, the second smaller than the first, and both matching what you can count by eye in `packages/env/src/server.ts` — `31` and `16` at the audited commit, `32` and `17` at HEAD. Do not hard-code either into the script you are about to write; Step 3 derives them from the file.

- [x] **Step 2: Decide how to read the compose file, and confirm no YAML library exists**

```bash
grep -rn '"yaml"\|"js-yaml"' --include=package.json apps packages package.json || echo "no manifest declares one"
bun pm ls --all | grep -E "^├── (yaml|js-yaml)@"
```

Expected: `no manifest declares one`, then `├── js-yaml@4.3.1` and `├── yaml@2.9.0` — both present in the lockfile as transitive dependencies of tooling and owned by nobody here. Importing one would work today and break on the next `bun update`; adding one to the root catalog would also require a workspace to consume it or `tools/check-catalog.ts:69-75` fails the build.

So the block is parsed by hand, which is proportionate: `x-app-env` is a flat map of scalars, indented two spaces, with no nesting, no lists and no anchors of its own. Reading it is "take the lines after `x-app-env:` until the next line that starts at column 0".

- [x] **Step 3: Write the script**

Create `tools/check-env.ts`:

```ts
#!/usr/bin/env bun
/**
 * Guards the server env schema against the two files that must agree with it.
 *
 * `packages/env` validates the whole schema at import, so a key it declares is a
 * key every deployment has to be able to supply. Two files carry that contract
 * outward: `.env.example` tells an operator the key exists, and
 * `docker-compose.prod.yml`'s `x-app-env` is the only thing that carries it
 * across the container boundary — every service there uses `environment:
 * *app-env` and no `env_file`, so a key missing from that block is a key the
 * deploy exported and the process never sees.
 *
 * That failure is silent in the worst way: the variable is set on the host, the
 * container starts, and a `resolve*` guard throws hours later naming a key the
 * operator did set. `AGENTS.md` states the rule — a new key goes in
 * `.env.example`, `apps/server/.env`, `.env.test` and `x-app-env` — and a rule
 * stated in prose is a rule that drifts. This is the same rule, executable.
 *
 * `.env.test` is deliberately not checked: it is a fixture holding only what a
 * test run needs, not a mirror of the schema.
 */
import { file } from "bun";

const SCHEMA = "packages/env/src/server.ts";
const EXAMPLE = ".env.example";
const COMPOSE = "docker-compose.prod.yml";

/**
 * The schema is read as text, never imported: importing it runs `createEnv`,
 * which validates the whole environment and throws in CI. A regex is enough
 * because Biome fixes the shape — every key in the `server: {}` object sits at
 * exactly two tabs, and every continuation line of a multi-line declaration sits
 * at three or more.
 */
const SCHEMA_KEY = /^\t\t([A-Z][A-Z0-9_]*):(.*)$/;
const SCHEMA_CONTINUATION = /^\t\t\t/;

/** `KEY=value` or the commented `# KEY=value` an optional key ships as. */
const EXAMPLE_KEY = /^#?\s*([A-Z][A-Z0-9_]*)=/;

/**
 * The compose file is parsed by hand rather than with a YAML library, because
 * this repository has no YAML dependency — `yaml` and `js-yaml` exist in the
 * lockfile only as transitive dependencies of tooling, and reaching into a
 * package no manifest declares is a break waiting for the next `bun update`.
 * Adding one to the catalog to read a flat map of scalars is not worth it:
 * `x-app-env` has no nesting, no lists and no anchors of its own.
 */
const COMPOSE_ANCHOR = /^x-app-env:/;
const COMPOSE_ENTRY = /^ {2}([A-Za-z_][A-Za-z0-9_]*): *(.*)$/;

/**
 * Forwarded on purpose and absent from the schema. `TZ` is a container concern —
 * it pins the clock the Postgres client and Better Auth's `timestamp` columns
 * agree on — not a value `@keel/env` reads.
 */
const NOT_IN_SCHEMA: Record<string, true> = { TZ: true };

function schemaKeys(source: string): Map<string, boolean> {
	const keys = new Map<string, boolean>();
	let name: string | undefined;
	let declaration = "";

	for (const line of source.split("\n")) {
		const match = SCHEMA_KEY.exec(line);

		if (match?.[1]) {
			if (name) {
				keys.set(name, declaration.includes(".optional()"));
			}
			name = match[1];
			declaration = match[2] ?? "";
			continue;
		}

		if (name && SCHEMA_CONTINUATION.test(line)) {
			declaration += line;
			continue;
		}

		if (name) {
			keys.set(name, declaration.includes(".optional()"));
			name = undefined;
		}
	}

	if (name) {
		keys.set(name, declaration.includes(".optional()"));
	}

	return keys;
}

function documentedKeys(source: string): Set<string> {
	const keys = new Set<string>();

	for (const line of source.split("\n")) {
		const match = EXAMPLE_KEY.exec(line);

		if (match?.[1]) {
			keys.add(match[1]);
		}
	}

	return keys;
}

function forwardedKeys(source: string): Map<string, string> {
	const keys = new Map<string, string>();
	let inside = false;

	for (const line of source.split("\n")) {
		if (COMPOSE_ANCHOR.test(line)) {
			inside = true;
			continue;
		}

		if (!inside) {
			continue;
		}

		// The next top-level key ends the block. Comments and blank lines inside it
		// are indented or empty and simply do not match COMPOSE_ENTRY.
		if (/^\S/.test(line)) {
			break;
		}

		const match = COMPOSE_ENTRY.exec(line);

		if (match?.[1]) {
			keys.set(match[1], (match[2] ?? "").trim());
		}
	}

	return keys;
}

const [schemaSource, exampleSource, composeSource] = await Promise.all([
	file(SCHEMA).text(),
	file(EXAMPLE).text(),
	file(COMPOSE).text(),
]);

const declared = schemaKeys(schemaSource);
const documented = documentedKeys(exampleSource);
const forwarded = forwardedKeys(composeSource);
const problems: string[] = [];

if (declared.size === 0 || forwarded.size === 0) {
	console.error(
		`check-env: parsed ${declared.size} schema keys and ${forwarded.size} x-app-env keys. One of the two files changed shape — fix this script before trusting it.`
	);
	process.exit(1);
}

for (const [key, optional] of declared) {
	if (!documented.has(key)) {
		problems.push(
			`${EXAMPLE}: ${key} is declared in ${SCHEMA} but documented nowhere here. Add it${optional ? " commented out, under the Optional heading" : ""}.`
		);
	}

	const value = forwarded.get(key);

	if (value === undefined) {
		problems.push(
			`${COMPOSE}: x-app-env does not forward ${key}. Every service there uses \`environment: *app-env\` and no env_file, so the deploy would export it and the container would never see it. Add \`${key}: ${optional ? `\${${key}:-}` : `\${${key}:?${key} is required}`}\`.`
		);
		continue;
	}

	if (optional && value.includes(":?")) {
		problems.push(
			`${COMPOSE}: x-app-env forwards the optional key ${key} as \`${value}\`. The \`:?\` form refuses the deploy when it is unset, which turns an opt-in feature into a requirement. Use \`\${${key}:-}\`.`
		);
	}
}

for (const key of forwarded.keys()) {
	if (!(declared.has(key) || NOT_IN_SCHEMA[key])) {
		problems.push(
			`${COMPOSE}: x-app-env forwards ${key}, which ${SCHEMA} does not declare. Nothing reads it — check the spelling, or add it to NOT_IN_SCHEMA in this script if it is a container concern.`
		);
	}
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(problem);
	}
	console.error(`\ncheck-env: ${problems.length} problem(s).`);
	process.exit(1);
}

console.log(
	`check-env: ${declared.size} schema keys documented in ${EXAMPLE} and forwarded by ${COMPOSE}.`
);
```

Three notes on choices a reviewer will ask about:

- **The `import { file } from "bun"` is load-bearing, not decoration.** The script uses top-level `await`, and TypeScript only permits that in a module. With no import the file has no imports or exports, and `tsc` reports `TS1375: 'await' expressions are only allowed at the top level of a file when that file is a module`. `tools/check-catalog.ts` is a module for the same reason (`import { Glob } from "bun"`).
- **The reverse check earns its five lines.** A forward-only check passes a compose file that says `STORAGE_REGIONS`, because the typo is not a schema key and the real key looks absent for an unrelated reason. Checking both directions reports the typo as a typo.
- **The `declared.size === 0 || forwarded.size === 0` bail-out is the script guarding itself.** Both parsers are regexes over a file shape. If either file is reformatted past what they match, a silent "everything is fine" is the worst outcome; refusing to run is the right one.

- [x] **Step 4: Run it against the fixed tree**

```bash
bun tools/check-env.ts
```

Expected, exit 0 and one line of this shape — the count is whatever
`packages/env/src/server.ts` declares on the tree you are standing on, `31` at
the audited commit and `32` at HEAD, and is not the thing being asserted:

```
check-env: <n> schema keys documented in .env.example and forwarded by docker-compose.prod.yml.
```

If it reports eleven problems naming `AI_API_KEY` and the `STORAGE_*` keys, Task 1 is not applied — go back and apply it.

- [x] **Step 5: Prove it actually fires, in all four directions**

A check nobody has seen fail is not a check — the reasoning `tools/check-rules.ts:4-16` was written around. Break the tree four ways and put it back each time:

```bash
# 1. A key missing from x-app-env.
cp docker-compose.prod.yml /tmp/compose.bak
grep -v '^  STORAGE_BUCKET: ' /tmp/compose.bak > docker-compose.prod.yml
bun tools/check-env.ts
cp /tmp/compose.bak docker-compose.prod.yml
```

Expected:

```
docker-compose.prod.yml: x-app-env does not forward STORAGE_BUCKET. Every service there uses `environment: *app-env` and no env_file, so the deploy would export it and the container would never see it. Add `STORAGE_BUCKET: ${STORAGE_BUCKET:-}`.

check-env: 1 problem(s).
```

```bash
# 2. An optional key demanded with `:?`.
sed 's|AI_API_KEY: ${AI_API_KEY:-}|AI_API_KEY: ${AI_API_KEY:?AI_API_KEY is required}|' \
  /tmp/compose.bak > docker-compose.prod.yml
bun tools/check-env.ts
cp /tmp/compose.bak docker-compose.prod.yml
```

Expected:

```
docker-compose.prod.yml: x-app-env forwards the optional key AI_API_KEY as `${AI_API_KEY:?AI_API_KEY is required}`. The `:?` form refuses the deploy when it is unset, which turns an opt-in feature into a requirement. Use `${AI_API_KEY:-}`.

check-env: 1 problem(s).
```

```bash
# 3. A misspelled key. Both directions report, which is the point of the reverse check.
sed 's|STORAGE_REGION: ${STORAGE_REGION:-}|STORAGE_REGIONS: ${STORAGE_REGIONS:-}|' \
  /tmp/compose.bak > docker-compose.prod.yml
bun tools/check-env.ts
cp /tmp/compose.bak docker-compose.prod.yml
```

Expected two problems: `x-app-env does not forward STORAGE_REGION` and `x-app-env forwards STORAGE_REGIONS, which packages/env/src/server.ts does not declare.`

```bash
# 4. A key undocumented in .env.example.
cp .env.example /tmp/example.bak
sed 's|^# SECRETS_ENCRYPTION_KEY=|# (removed)|' /tmp/example.bak > .env.example
bun tools/check-env.ts
cp /tmp/example.bak .env.example
```

Expected:

```
.env.example: SECRETS_ENCRYPTION_KEY is declared in packages/env/src/server.ts but documented nowhere here. Add it commented out, under the Optional heading.

check-env: 1 problem(s).
```

Then confirm the tree is clean again:

```bash
git diff --stat && bun tools/check-env.ts
rm -f /tmp/compose.bak /tmp/example.bak
```

Expected: only `package.json` and the new `tools/check-env.ts` differ once Step 6 has run — at this point in the task, nothing at all — and the script prints its one-line summary and exits 0.

- [x] **Step 6: Wire it into the gate**

In `package.json`, replace the `check` script on line 49. Before:

```json
    "check": "turbo run check-types test && bun run lint && bun tools/check-catalog.ts && bun tools/check-naming.ts && bun tools/check-rules.ts && bun tools/check-migrations.ts",
```

After:

```json
    "check": "turbo run check-types test && bun run lint && bun tools/check-catalog.ts && bun tools/check-env.ts && bun tools/check-naming.ts && bun tools/check-rules.ts && bun tools/check-migrations.ts",
```

Alphabetical among the `tools/check-*` scripts, which is the order they are already in.

- [x] **Step 7: Prove the whole gate is green**

```bash
bun run check
```

Expected: every task successful, and one new line in the output between `check-catalog` and `check-naming`, of the same shape Step 4 printed:

```
check-env: <n> schema keys documented in .env.example and forwarded by docker-compose.prod.yml.
```

- [x] **Step 8: Commit**

```bash
git add tools/check-env.ts package.json
git commit -m "feat(tools): the env-key rule now runs instead of being written down

AGENTS.md says a new key goes in .env.example, apps/server/.env, .env.test and
docker-compose.prod.yml's x-app-env. Nothing executed that sentence, and the
previous commit is what it costs: eleven keys reached the schema and never
reached the compose file, and the gap was invisible because Compose renders a
container missing a variable without complaint.

check-env reads packages/env/src/server.ts as text — importing it runs createEnv,
which validates the whole environment and throws in a CI job that has no
apps/server/.env — and asserts each declared key is documented in .env.example
and forwarded by x-app-env, that an optional key is never forwarded with the :?
form that would make an opt-in feature mandatory, and that x-app-env forwards
nothing the schema does not declare. That last direction is what turns a
misspelled key from an absence into a named typo. .env.test is out of scope on
purpose: it is a fixture holding what a test run needs, not a mirror.

The compose block is parsed by hand. No manifest in this workspace declares a
YAML dependency — yaml and js-yaml are transitive only — and adding one to the
catalog to read a flat map of scalars would need a workspace to consume it or
check-catalog fails. x-app-env has no nesting, no lists and no anchors of its own.

Proven the way check-rules proves its rules: four deliberate breakages — a
dropped key, an optional key demanded with :?, a misspelling, and a key removed
from .env.example — each reported with the fix to make, and the tree clean
again afterwards."
```

---

## Done when

- `docker compose -f docker-compose.prod.yml --env-file <a deploy env> config` renders `AI_API_KEY`, `AI_MODEL`, `SECRETS_ENCRYPTION_KEY` and all eight `STORAGE_*` inside every service that uses `environment: *app-env`.
- A deploy environment that sets none of those eleven still renders: `docker compose -f docker-compose.prod.yml --env-file <that env> config --quiet` exits 0.
- None of the eleven carries a value in the file: `grep -E '^  (AI_|SECRETS_|STORAGE_)' docker-compose.prod.yml` shows only the `${VAR:-}` form.
- `bun tools/check-env.ts` exits 0 and prints one line of the form `check-env: <n> schema keys documented in .env.example and forwarded by docker-compose.prod.yml.` The count is deliberately not pinned: it was 31 when this plan landed and is 32 at HEAD, because `WEBHOOK_SECRET` was added afterwards and correctly forwarded at `docker-compose.prod.yml:99` — the guard doing its job, not the plan being violated.
- Deleting any single key line from `x-app-env` makes `bun run check` fail naming that key and the file it belongs in.
- `bun run check` passes.

## Out of scope

- **Adding new environment keys.** This plan forwards keys that already exist. Any plan that introduces one adds it to `.env.example`, `apps/server/.env`, `.env.test` and `x-app-env` in the form this plan establishes — `${VAR:?VAR is required}` when the schema requires it, `${VAR:-}` when the schema says `.optional()` — and Task 2's guard will fail its `bun run check` if it forgets.
- **`README.md` and `AGENTS.md`.** Plan 021 owns README counts and AGENTS.md length. `AGENTS.md:66-69` is quoted here and left unchanged; Task 2 makes it executable rather than replacing it.
- **Giving `SECRETS_ENCRYPTION_KEY` or the `STORAGE_*` keys a consumer.** DIR-04 (`plans/audit-report.md:403-406`) covers the sealed-secrets cipher having no caller, and PERF/DIR findings cover the missing upload endpoint. This plan makes the keys reachable; whether anything reads them is a different question with a different acceptance test.
- **A local object store in `docker-compose.yml`.** `apps/server/src/lib/storage.ts:56-61` argues against it explicitly, and adding one would be a service to keep healthy for a feature that does not exist.
- **`apps/server/.env` and the root `.env`.** Both are untracked. `.env.example:124-209` already documents all eleven keys, which is the tracked half of the contract.
