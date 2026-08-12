# Enforcement Coverage for `check-rules` Implementation Plan

> **For agentic workers:** implement this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task ends green and gets its own commit.

**Finding:** TEST-10, TEST-11 (`plans/audit-report.md:271-285`), plus one gap the audit did not find
**Audited commit:** `39fd32c` — before starting, run `git log --oneline -1`. If HEAD differs, re-read every file this plan cites before trusting a line number.

**Goal:** Make `tools/check-rules.ts` cover every rule and every layer-boundary override block the config claims it covers, and make the script clean up after an interrupted run instead of only after a completed one.

**Architecture:** `tools/check-rules.ts` is the repo's meta-guard: for each enforced rule it writes a file that violates it on purpose, lints the real path, and fails if the diagnostic does not appear. Three things are missing. The `noRestrictedImports` override block scoped to `apps/server/src/modules/**` minus services, HTTP layers and tests (`biome.jsonc:187-217`) has **no fixture at all**, even though the comment above it claims otherwise — every module fixture path today ends in `.service.ts` or `.handlers.ts`. Two rules the config sets to error, `useSingleVarDeclarator` and `useExhaustiveDependencies`, have no fixture either, and the second one cannot be fixtured in the existing roots because neither declares React. And the fixture directories are removed only in a `finally`, so a `SIGKILL` leaves deliberate violations in the source tree with nothing announcing them on the next run.

**Tech Stack:** Bun, `@biomejs/biome` 2.5.7, ultracite 7.9.4, `node:fs`/`node:fs/promises`.

---

## Verified evidence (do not re-litigate)

Established by running Biome 2.5.7 against a byte-for-byte copy of `biome.jsonc` with the same `node_modules` and the same relative fixture paths, before this plan was written.

**1. The four rules the repo itself turns on.** `biome.jsonc:35-79` is the whole `linter.rules` block, and it sets exactly four rules to `"error"`:

| Rule | Line |
|---|---|
| `useExhaustiveDependencies` | `biome.jsonc:39` |
| `noExcessiveLinesPerFile` | `biome.jsonc:68-73` |
| `noProcessEnv` | `biome.jsonc:75` |
| `useSingleVarDeclarator` | `biome.jsonc:76` |

`tools/check-rules.fixtures.ts:28-142` holds 16 expectations covering `plugin` (×2, one of them the silent exemption), `noRestrictedImports` (×9 — **not** the seven the audit counted), `noProcessEnv`, `noExcessiveLinesPerFile`, `noUndeclaredDependencies`, `noImportCycles`, `noPrivateImports`. So `useExhaustiveDependencies` and `useSingleVarDeclarator` are unfixtured, exactly as TEST-10 says. The audit undercounted the `noRestrictedImports` fixtures; that does not change the conclusion.

**2. The gap the audit missed, and the reason this plan exists.** `biome.jsonc:175-186` is the banner over the layer-boundary overrides. It says, verbatim:

```jsonc
    // READ THIS BEFORE EDITING: Biome does not merge rule options across
    // overrides. When two overrides configure noRestrictedImports and both match
    // a file, the LAST one wins outright and the earlier patterns vanish — with
    // no diagnostic. The three blocks below are therefore mutually exclusive by
    // path, and each repeats the module-privacy patterns it needs.
    //
    // `bun tools/check-rules.ts` proves every one of them still fires against a
    // deliberate violation. It caught exactly this replacement bug once already.
```

The claim is false for the first of those three blocks. `biome.jsonc:187-217` scopes `noRestrictedImports` to `apps/server/src/modules/**` with `!**/*.service.ts`, `!**/*.routes.ts`, `!**/*.handlers.ts`, `!**/*.test.ts` — i.e. it is the block that polices `*.repository.ts`, `*.schema.ts` and `*.fixtures.ts`, the files that actually touch the database and the wire format. Every module fixture path in `tools/check-rules.fixtures.ts` ends in `.service.ts` or `.handlers.ts`, so not one of them is matched by it.

Proven by deleting `biome.jsonc:187-217` in the copy and re-linting the current fixture set: **not one diagnostic changed.** The block can be deleted outright, `bun tools/check-rules.ts` still prints "16 architecture rules verified", and `bun run check` stays green — while `*.repository.ts` files are free to import another module's internals. This is precisely the last-override-wins footgun the same comment documents, arriving through the other door: not a block that got shadowed, but a block that was never guarded.

**3. `useSingleVarDeclarator` does not fire on an exported declaration.** The audit's fix sketch and the obvious fixture are both wrong. Measured:

```
export const first = 1, second = 2;   →  no diagnostic
const first = 1, second = 2;
export const total = first + second;  →  lint/style/useSingleVarDeclarator "Declare variables separately"
```

An `export const a = 1, b = 2;` fixture would be vacuous — it would sit in the list looking like coverage and report `ok` for a reason that has nothing to do with the rule being alive. Task 2 uses the second form.

**4. `useExhaustiveDependencies` cannot live in the existing fixture roots.** They are `apps/server` and `packages/http` (`tools/check-rules.fixtures.ts:8-10`); neither declares React. That is not an assumption — it is the mechanism the `noUndeclaredDependencies` fixture already relies on: `tools/check-rules.fixtures.ts:112-116` imports `react-dom` from `apps/server` *in order to* be undeclared. Put a React hook fixture there and it trips `noUndeclaredDependencies` rather than proving anything about hooks. `apps/web/package.json:27-28` declares `react` and `react-dom`, so a fourth fixture root at `apps/web/src/rulecheck` is required. Measured there: a `useEffect` reading `count` with an empty dependency array reports `lint/correctness/useExhaustiveDependencies` — "This hook does not specify its dependency on count" — from a plain `.ts` file, with no JSX and no `tsconfig` needed.

**5. TEST-11 is real but cosmetic, and the audit's impact statement overstates it.** `tools/check-rules.ts:74-80` removes the three directories in a `finally`, so anything short of `SIGKILL` cleans up, and the `finally` removes the **whole directories** — meaning re-running the script alone already self-heals. `rulecheck` is not in `.gitignore` (checked: the file lists `dist`, `apps/server/types`, `apps/web/src/routeTree.gen.ts`, `.env`, `.turbo`, `*.bun-build` and friends — no `rulecheck`), so `git status` names any leftovers. The real cost is ordering: `package.json:49` chains

```
turbo run check-types test && bun run lint && bun tools/check-catalog.ts && bun tools/check-naming.ts && bun tools/check-rules.ts && bun tools/check-migrations.ts
```

with `&&`, so a leftover fails typecheck or lint and the self-healing script is never reached. Task 3 does not change that — it makes the script heal at the start of its own run and say so, which turns "know which four directories to delete" into "run the script". Do not write a plan step or a commit message claiming `bun run check` recovers on its own.

---

## Global Constraints

- `bun run check` must pass at the end of every task. It runs typecheck, every suite, Biome/Ultracite, catalog drift, test-naming, the architecture rules and migration drift.
- All code, comments and commit messages in English.
- No file over 200 **code** lines (Biome `noExcessiveLinesPerFile`; comment lines and multi-line template literals do not count). `tools/check-rules.fixtures.ts` is 155 physical lines today and this plan adds four expectations to it; the limit applies to tooling too, and `bun run check` is what proves it still fits.
- Test files are `<subject>[.<aspect>].test.ts` beside `<subject>.ts`; fixtures are `<subject>.fixtures.ts` inside `src/`. `tools/check-naming.ts` scopes itself to `apps/*` and `packages/*`, which is why `tools/check-rules.fixtures.ts` needs no blessing — do not rename it.
- If you genuinely need a new Biome exemption, add a fixture to `tools/check-rules.ts` in the same commit. This plan is the other direction: it adds the fixtures that were already owed.

## Do not

- **Do not "fix" the unguarded override block by merging it into another one.** The blocks are mutually exclusive by path on purpose, because Biome does not merge `noRestrictedImports` *options* across overrides — the last matching block wins outright and the earlier patterns vanish with no diagnostic (`biome.jsonc:177-182`). Merging blocks is how that bug gets reintroduced. The block is correct; only its fixture is missing.
- **Do not use `export const a = 1, b = 2;` for `useSingleVarDeclarator`.** It produces no diagnostic (evidence 3). A fixture that does not violate its rule is worse than no fixture: it reports `ok` forever and hides the death it was written to catch.
- **Do not put the React fixture in `apps/server` or `packages/http`.** It would trip `noUndeclaredDependencies` instead, and the resulting `ok` line would be a lie about a different rule (evidence 4).
- **Do not add `rulecheck` to `.gitignore`.** Its absence is what makes a leaked fixture visible in `git status`. Ignoring the directory would make TEST-11 genuinely dangerous instead of cosmetic.
- **Do not move the fixtures to a temp directory.** The rules are scoped by path globs against the repo layout; a copy elsewhere tests the copy. `tools/check-rules.ts:12-15` says this and it is correct.
- **Do not add a signal handler to the script.** `SIGKILL` cannot be trapped, which is the only case the `finally` misses. Cleaning up at the start of the run covers it without pretending otherwise.
- **Do not weaken any rule to make a fixture pass.** If a fixture reports `DEAD`, the fixture source is wrong, not the config.

## File structure

| File | Responsibility |
|---|---|
| `tools/check-rules.fixtures.ts` | **Modify.** Add the two fixtures for the unguarded module override block, the two for the unfixtured rules, and the fourth fixture root. |
| `tools/check-rules.ts` | **Modify.** Lint the fourth root, and remove every fixture directory at start as well as in `finally`, announcing what it removed. |

---

### Task 1: Fixture the module override block the config claims is proven

**Files:**
- Modify: `tools/check-rules.fixtures.ts:88-89` (insert two expectations after the `queue.handlers.ts` entry)

**Interfaces:**
- Consumes: `Expectation` from `tools/check-rules.fixtures.ts:12-22`, and `MODULE_DIR = "apps/server/src/modules/rulecheck"` from `:8`.
- Produces: two more entries in `EXPECTATIONS`, so `EXPECTATIONS.length` goes 16 → 18 and the script's closing line reads `18 architecture rules verified`.

- [x] **Step 1: Watch the block die without a single test noticing**

This is the failing test, and it fails by *passing*. Temporarily delete the override block at `biome.jsonc:187-217` — the one whose `includes` is `["apps/server/src/modules/**", "!**/*.service.ts", "!**/*.routes.ts", "!**/*.handlers.ts", "!**/*.test.ts"]`, ending at the `},` immediately before the block whose `includes` is `["apps/server/src/modules/*/*.service.ts"]`:

```bash
sed -i '' '187,217d' biome.jsonc
bun tools/check-rules.ts
```

Expected output: sixteen `ok` lines and

```
check-rules: 16 architecture rules verified against deliberate violations.
```

Exit code 0. A whole layer boundary was just deleted and the guard that exists to catch exactly that said nothing. Restore the config before going on:

```bash
git checkout biome.jsonc
```

- [x] **Step 2: Add the two fixtures**

In `tools/check-rules.fixtures.ts`, insert these two entries into `EXPECTATIONS` directly after the `${MODULE_DIR}/queue.handlers.ts` entry that ends at line 89, before the `${LIB_DIR}/reach.ts` entry:

```ts
	{
		// The nine noRestrictedImports fixtures above all end in .service.ts or
		// .handlers.ts, so every one of them lands in a different override block.
		// These two are the only files that reach the block scoped to everything
		// in a module that is NOT a service, an HTTP layer or a test — the block
		// that polices *.repository.ts, *.schema.ts and *.fixtures.ts, which is
		// to say the files that touch the database and the wire format.
		path: `${MODULE_DIR}/rulecheck.repository.ts`,
		rule: "lint/style/noRestrictedImports",
		source:
			'import { projectStore } from "@/modules/projects/projects.repository";\nexport const store = projectStore;\n',
		why: "a repository reaches into another module's internals",
	},
	{
		path: `${MODULE_DIR}/internal/escape.schema.ts`,
		rule: "lint/style/noRestrictedImports",
		source:
			'import { projectStore } from "../../projects/projects.repository";\nexport const store = projectStore;\n',
		why: "a schema escapes its module directory relatively",
	},
```

Why each one trips, precisely:

- `rulecheck.repository.ts` matches `apps/server/src/modules/**` and none of the four negations, so the block at `biome.jsonc:187-217` applies. Its import matches that block's first pattern group `["@/modules/*/*", "@/modules/*/**"]` (`biome.jsonc:204`), producing "A module's internals are private."
- `internal/escape.schema.ts` matches the same block. Its import matches the second group `["../../*", "../../**"]` (`biome.jsonc:208`), producing "A relative import may not escape its module directory." It has to sit one directory deeper than the module root for a `../../` specifier to be the natural way to write the violation, which is why it goes in `internal/`.

Neither import needs to resolve: `noRestrictedImports` matches the specifier text, and `noUnresolvedImports` is off (`biome.jsonc:48`). The nine existing fixtures already rely on this.

- [x] **Step 3: Run the script and watch both fixtures fire**

```bash
bun tools/check-rules.ts
```

Expected: eighteen `ok` lines, including

```
  ok   lint/style/noRestrictedImports              a repository reaches into another module's internals
  ok   lint/style/noRestrictedImports              a schema escapes its module directory relatively
```

and the closing line

```
check-rules: 18 architecture rules verified against deliberate violations.
```

- [x] **Step 4: Prove the fixtures are not vacuous**

An `ok` line only means a diagnostic appeared; it does not prove *that block* produced it. Delete the block again and confirm the script now notices:

```bash
sed -i '' '187,217d' biome.jsonc
bun tools/check-rules.ts
echo "exit=$?"
```

Expected: exactly two failures, naming exactly the two new paths, and nothing else changing —

```
  DEAD lint/style/noRestrictedImports              a repository reaches into another module's internals
       fixture apps/server/src/modules/rulecheck/rulecheck.repository.ts produced no lint/style/noRestrictedImports diagnostic
  DEAD lint/style/noRestrictedImports              a schema escapes its module directory relatively
       fixture apps/server/src/modules/rulecheck/internal/escape.schema.ts produced no lint/style/noRestrictedImports diagnostic

check-rules: 2 rule(s) no longer fire. The architecture is unguarded.
exit=1
```

If any of the other seven module `noRestrictedImports` fixtures also goes `DEAD`, you deleted the wrong lines — restore and re-check the range. Then restore:

```bash
git checkout biome.jsonc
```

- [x] **Step 5: Prove the whole gate is green**

```bash
bun run check
```

Expected: every turbo task successful, `check-naming` still reporting 33 suites, and `check-rules: 18 architecture rules verified against deliberate violations.`

- [x] **Step 6: Commit**

```bash
git add tools/check-rules.fixtures.ts
git commit -m "test(tools): the repository layer boundary was never guarded

biome.jsonc says \`bun tools/check-rules.ts\` proves every layer-boundary
override still fires. For one of the three it did not. The block scoped to
everything in a module that is not a service, an HTTP layer or a test — the
one policing *.repository.ts, *.schema.ts and *.fixtures.ts — had no fixture,
because all nine noRestrictedImports fixtures end in .service.ts or
.handlers.ts and each of those lands in a different block.

Measured before the fix: deleting that override outright changed not one
diagnostic, the script still printed \"16 architecture rules verified\", and
\`bun run check\` stayed green while a repository was free to import another
module's internals. This is the last-override-wins footgun the comment above
the blocks warns about, arriving through the other door — not a block that got
shadowed, but a block that was never proven.

Two fixtures, one per pattern group in that block: a .repository.ts importing
@/modules/projects/projects.repository, and an internal/*.schema.ts escaping
with ../../. Verified in both directions — both report ok with the block
present, and exactly those two report DEAD with it removed."
```

---

### Task 2: Fixture the two enabled rules that had none

**Files:**
- Modify: `tools/check-rules.fixtures.ts:10` (add `WEB_DIR`), and `EXPECTATIONS` (two more entries)
- Modify: `tools/check-rules.ts:19-25` (import `WEB_DIR`), `:47` (lint it), `:75-79` (remove it)

**Interfaces:**
- Consumes: Task 1's fixture list — this task appends to it and its expected counts assume Task 1 landed (18 → 20).
- Produces: `export const WEB_DIR = "apps/web/src/rulecheck"` from `tools/check-rules.fixtures.ts`. Task 3 folds it into the shared cleanup list.

- [x] **Step 1: Add the `useSingleVarDeclarator` fixture in the form the audit suggests**

Append to `EXPECTATIONS` in `tools/check-rules.fixtures.ts`, after the `${HELPER_DIR}/exempt.ts` entry that ends at line 141:

```ts
	{
		path: `${MODULE_DIR}/pair.service.ts`,
		rule: "lint/style/useSingleVarDeclarator",
		source: "export const first = 1, second = 2;\n",
		why: "one declaration declares two variables",
	},
```

- [x] **Step 2: Run it and watch it fail for the right reason**

```bash
bun tools/check-rules.ts
echo "exit=$?"
```

Expected:

```
  DEAD lint/style/useSingleVarDeclarator           one declaration declares two variables
       fixture apps/server/src/modules/rulecheck/pair.service.ts produced no lint/style/useSingleVarDeclarator diagnostic

check-rules: 1 rule(s) no longer fire. The architecture is unguarded.
exit=1
```

The rule is enabled at `biome.jsonc:76` and it is alive — it simply does not report an *exported* declaration. This is the whole reason the fixture list is worth auditing: written the obvious way, this entry would have reported `ok` for a reason unrelated to the rule.

- [x] **Step 3: Fix the fixture source**

Replace the `source` of the entry you just added:

```ts
	{
		// Not `export const first = 1, second = 2;` — measured, that produces no
		// diagnostic at all, and a fixture that does not violate its rule reports
		// ok forever while the rule it claims to guard is dead. The declaration
		// has to be unexported; the export below keeps both bindings used.
		path: `${MODULE_DIR}/pair.service.ts`,
		rule: "lint/style/useSingleVarDeclarator",
		source:
			"const first = 1, second = 2;\nexport const total = first + second;\n",
		why: "one declaration declares two variables",
	},
```

`export const total = first + second;` is not decoration: without it both bindings are unused and the file collects unrelated diagnostics that make the run harder to read.

- [x] **Step 4: Run the script and watch it pass**

```bash
bun tools/check-rules.ts
```

Expected:

```
  ok   lint/style/useSingleVarDeclarator           one declaration declares two variables

check-rules: 19 architecture rules verified against deliberate violations.
```

- [x] **Step 5: Declare the fourth fixture root and the React fixture**

`useExhaustiveDependencies` needs a workspace that declares React, and neither existing root does — putting it in `apps/server` would trip `noUndeclaredDependencies` instead, which is exactly how the fixture at `tools/check-rules.fixtures.ts:112-116` works. `apps/web/package.json:27-28` declares `react` and `react-dom`.

Add the constant beside the other three at `tools/check-rules.fixtures.ts:8-10`:

```ts
export const MODULE_DIR = "apps/server/src/modules/rulecheck";
export const HELPER_DIR = "packages/http/src/rulecheck";
export const LIB_DIR = "apps/server/src/lib/rulecheck";
export const WEB_DIR = "apps/web/src/rulecheck";
```

and append the expectation after the `pair.service.ts` entry:

```ts
	{
		// The only React root among the fixtures. apps/server and packages/http
		// do not declare react, so a hook fixture there would report
		// noUndeclaredDependencies and prove nothing about hooks — that is the
		// mechanism the noUndeclaredDependencies fixture above depends on.
		// A plain .ts file is enough: Biome matches the hook by name, so no JSX
		// and no tsconfig are involved.
		path: `${WEB_DIR}/deps.ts`,
		rule: "lint/correctness/useExhaustiveDependencies",
		source:
			'import { useEffect, useState } from "react";\nexport function useRulecheck() {\n\tconst [count, setCount] = useState(0);\n\tuseEffect(() => {\n\t\tsetCount(count + 1);\n\t}, []);\n\treturn count;\n}\n',
		why: "a hook omits a value its effect reads",
	},
```

The effect body reads `count` while the dependency array is empty, which is what `useExhaustiveDependencies` (`biome.jsonc:39`) reports as "This hook does not specify its dependency on count".

Now wire the directory into the runner's cleanup only — not yet into the lint invocation. In `tools/check-rules.ts`, extend the import at `:19-25`:

```ts
import {
	EXPECTATIONS,
	HELPER_DIR,
	LIB_DIR,
	MODULE_DIR,
	SUPPORT,
	WEB_DIR,
} from "./check-rules.fixtures";
```

and the `finally` at `:75-79`:

```ts
	await Promise.all([
		rm(LIB_DIR, { force: true, recursive: true }),
		rm(MODULE_DIR, { force: true, recursive: true }),
		rm(HELPER_DIR, { force: true, recursive: true }),
		rm(WEB_DIR, { force: true, recursive: true }),
	]);
```

Cleanup first, on purpose: the next step is a deliberate failure, and a failure that leaves a violating file under `apps/web/src` would break the next `bun run check` for an unrelated reason.

- [x] **Step 6: Run it and watch the new fixture fail for the right reason**

```bash
bun tools/check-rules.ts
echo "exit=$?"
```

Expected:

```
  DEAD lint/correctness/useExhaustiveDependencies  a hook omits a value its effect reads
       fixture apps/web/src/rulecheck/deps.ts produced no lint/correctness/useExhaustiveDependencies diagnostic

check-rules: 1 rule(s) no longer fire. The architecture is unguarded.
exit=1
```

The file is written and the rule is alive; Biome is never pointed at the directory. Confirm the tree is clean anyway — the `finally` you just extended is what makes that true:

```bash
git status --short
```

Expected: only `tools/check-rules.ts` and `tools/check-rules.fixtures.ts` modified, and no `apps/web/src/rulecheck` entry.

- [x] **Step 7: Lint the fourth root**

In `tools/check-rules.ts`, extend the invocation at `:46-49`:

```ts
	const result =
		await $`bunx biome lint --max-diagnostics=200 --reporter=github ${MODULE_DIR} ${HELPER_DIR} ${LIB_DIR} ${WEB_DIR}`
			.nothrow()
			.quiet();
```

- [x] **Step 8: Run the script and watch it pass**

```bash
bun tools/check-rules.ts
```

Expected:

```
  ok   lint/correctness/useExhaustiveDependencies  a hook omits a value its effect reads

check-rules: 20 architecture rules verified against deliberate violations.
```

- [x] **Step 9: Prove both new fixtures are not vacuous**

Turn both rules off in `biome.jsonc` — change `"useExhaustiveDependencies": "error"` at line 39 to `"useExhaustiveDependencies": "off"`, and `"useSingleVarDeclarator": "error"` at line 76 to `"useSingleVarDeclarator": "off"` — then:

```bash
bun tools/check-rules.ts
echo "exit=$?"
```

Expected: exactly two failures and no others —

```
  DEAD lint/style/useSingleVarDeclarator           one declaration declares two variables
       fixture apps/server/src/modules/rulecheck/pair.service.ts produced no lint/style/useSingleVarDeclarator diagnostic
  DEAD lint/correctness/useExhaustiveDependencies  a hook omits a value its effect reads
       fixture apps/web/src/rulecheck/deps.ts produced no lint/correctness/useExhaustiveDependencies diagnostic

check-rules: 2 rule(s) no longer fire. The architecture is unguarded.
exit=1
```

This is the assertion that matters: it says each fixture's `ok` is caused by the rule it names, not by some neighbouring diagnostic that happens to mention it. Restore:

```bash
git checkout biome.jsonc
```

- [x] **Step 10: Prove the whole gate is green**

```bash
bun run check
```

Expected: every turbo task successful, `check-naming` still reporting 33 suites, and `check-rules: 20 architecture rules verified against deliberate violations.`

- [x] **Step 11: Commit**

```bash
git add tools/check-rules.ts tools/check-rules.fixtures.ts
git commit -m "test(tools): fixture the last two rules this repo turns on

linter.rules enables exactly four rules: useExhaustiveDependencies,
noExcessiveLinesPerFile, noProcessEnv and useSingleVarDeclarator. Two had a
fixture. A Biome upgrade that renamed or dropped either of the other two would
have unguarded it in silence, which is the one failure mode this script exists
to make impossible.

useSingleVarDeclarator does not report an exported declaration — measured,
\`export const first = 1, second = 2;\` produces nothing at all. Written that
way the fixture would have reported ok forever, so it declares unexported and
exports the sum.

useExhaustiveDependencies needed a fourth fixture root. apps/server and
packages/http do not declare react, which is not incidental: the
noUndeclaredDependencies fixture works precisely by importing react-dom from
apps/server. A hook fixture there would have proven something about a different
rule, so it lives in apps/web, which declares react. A plain .ts file is
enough — Biome matches the hook by name.

Both verified in both directions: ok with the rule on, DEAD with it off, and
nothing else moving. 20 architecture rules verified."
```

---

### Task 3: Heal a leaked fixture tree at the start of the run, and say so

**Files:**
- Modify: `tools/check-rules.ts:2` (add an import), `:27-33` (add the cleanup helper and call it), `:74-80` (reuse it)

**Interfaces:**
- Consumes: `WEB_DIR` from Task 2 — the cleanup list is all four roots, so this task must land after it.
- Produces: nothing other code imports.

- [ ] **Step 1: Simulate the leak and watch the script say nothing about it**

`SIGKILL` cannot be trapped, so a hard kill during the lint leaves the fixture tree behind. Reproduce that state deterministically:

```bash
mkdir -p apps/server/src/modules/rulecheck
printf 'import type { Context } from "hono";\nexport const list = (c: Context) => c.json({ data: [] }, 200);\n' > apps/server/src/modules/rulecheck/stale.handlers.ts
bun tools/check-rules.ts
```

Expected: twenty `ok` lines, `check-rules: 20 architecture rules verified`, exit 0, and **no mention of the leftover** — even though `stale.handlers.ts` was sitting in `apps/server/src` and was linted alongside the real fixtures. It is gone afterwards only because the `finally` removes whole directories; nothing told the operator that happened, and nothing would have told them the run was polluted.

Confirm the tree is clean before continuing:

```bash
git status --short
```

Expected: no `apps/server/src/modules/rulecheck` entry.

- [ ] **Step 2: Extract the cleanup and run it up front**

In `tools/check-rules.ts`, add the `node:fs` import above the existing `node:fs/promises` one at line 2:

```ts
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
```

Then replace the `write` helper and the `let failures = 0;` line — lines 27 to 32 — with:

```ts
const DIRS = [LIB_DIR, MODULE_DIR, HELPER_DIR, WEB_DIR];

async function write(path: string, source: string) {
	await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	await Bun.write(path, source);
}

/**
 * Removes every fixture directory and reports which ones were there.
 *
 * Called at the start of the run as well as in the `finally`, because SIGKILL
 * cannot be trapped: a CI timeout or an OOM kill during the lint leaves
 * deliberate violations in the source tree. The `finally` alone already meant a
 * rerun cleaned up, but only after linting whatever the previous run left — and
 * silently, so the operator never learned the tree had been dirty.
 *
 * This does not rescue `bun run check`. That chain is `&&`-joined and this
 * script runs fifth, so a leftover fails typecheck or lint long before it is
 * reached. What it changes is the recovery instruction: run the script, rather
 * than know which four directories to delete.
 */
async function cleanup() {
	const leftovers = DIRS.filter((dir) => existsSync(dir));

	await Promise.all(
		DIRS.map((dir) => rm(dir, { force: true, recursive: true }))
	);

	return leftovers;
}

const leftovers = await cleanup();

if (leftovers.length > 0) {
	console.log(
		`check-rules: removed fixtures left by an interrupted run — ${leftovers.join(", ")}.`
	);
}

let failures = 0;
```

- [ ] **Step 3: Reuse it in the `finally`**

Replace the body of the `finally` block:

```ts
} finally {
	await cleanup();
}
```

- [ ] **Step 4: Run the script against a leaked tree and watch it announce the heal**

```bash
mkdir -p apps/server/src/modules/rulecheck
printf 'import type { Context } from "hono";\nexport const list = (c: Context) => c.json({ data: [] }, 200);\n' > apps/server/src/modules/rulecheck/stale.handlers.ts
bun tools/check-rules.ts
```

Expected, as the first line of output:

```
check-rules: removed fixtures left by an interrupted run — apps/server/src/modules/rulecheck.
```

followed by the twenty `ok` lines and `check-rules: 20 architecture rules verified against deliberate violations.`

- [ ] **Step 5: Confirm a clean run stays quiet**

```bash
bun tools/check-rules.ts
```

Expected: no `removed fixtures` line at all — only the twenty `ok` lines and the closing count. A message on every run would be noise, and worse, would stop meaning anything when it mattered.

- [ ] **Step 6: Prove the whole gate is green**

```bash
bun run check
```

Expected: every turbo task successful, `check-naming` reporting 33 suites, and `check-rules: 20 architecture rules verified against deliberate violations.`

- [ ] **Step 7: Commit**

```bash
git add tools/check-rules.ts
git commit -m "fix(tools): check-rules now heals a tree an interrupted run dirtied

The fixtures are written to real repo paths on purpose — the rules are scoped
by path globs, so a copy in a temp directory would only test the copy. Cleanup
lived solely in a finally, and SIGKILL cannot be trapped: a CI timeout or an
OOM kill during the lint leaves deliberately-violating files under
apps/server/src, apps/web/src and packages/http/src.

Removing the directories at the start as well means the next run lints exactly
what it wrote instead of that plus whatever survived, and it prints which
directories it removed so a dirty tree is a fact the operator is told rather
than one they infer. A clean run stays silent.

To be clear about what this does not do: \`bun run check\` is an && chain and
this script runs fifth, so a leftover still fails typecheck or lint first. The
recovery is now \"run the script\" instead of \"know which four directories to
delete\". \`rulecheck\` stays out of .gitignore for the same reason — a leaked
fixture should show up in git status."
```

---

## Done when

- `bun tools/check-rules.ts` prints `check-rules: 20 architecture rules verified against deliberate violations.` and exits 0.
- Deleting the override block at `biome.jsonc:187-217` makes the script exit 1 with exactly two `DEAD` lines, naming `apps/server/src/modules/rulecheck/rulecheck.repository.ts` and `apps/server/src/modules/rulecheck/internal/escape.schema.ts`. Before this plan, deleting that block changed nothing.
- Setting `useSingleVarDeclarator` or `useExhaustiveDependencies` to `"off"` makes the script exit 1 with a `DEAD` line naming that rule and nothing else.
- Every rule set to `"error"` in `biome.jsonc:35-79` has an expectation in `tools/check-rules.fixtures.ts`, and every `noRestrictedImports` override block in `biome.jsonc` has at least one fixture whose path only that block matches.
- `bun tools/check-rules.ts` run against a tree containing `apps/server/src/modules/rulecheck/` prints a line naming the directory it removed, and run against a clean tree prints no such line.
- `bun run check` passes, and `git status --short` is clean after every run of the script.

## Out of scope

- **`useExhaustiveDependencies` violations in real `apps/web` code.** This plan proves the rule fires; it does not audit whether any shipped component trips it. The rule is already `"error"`, so `bun run lint` would have caught one.
- **Any change to the layer-boundary override blocks themselves.** They are correct. Only the fixture coverage was missing.
- **`tools/gen-module.ts` generating untested surfaces (TEST-09).** Different tool, different finding; owned by plan 015.
- **Stale counts in `README.md` and `AGENTS.md`.** This plan takes the architecture-rule count from 16 to 20. `README.md:49` already says `tools/check-rules.ts` "violates all thirteen on purpose" — stale before this plan and staler after it. `AGENTS.md:79` states no number and stays correct. Plan 021 owns both files; do not touch either here, and hand the new count to whoever executes 021.
- **Adding `rulecheck` to `.gitignore`.** Deliberately rejected; see "Do not".
