#!/usr/bin/env bun
/**
 * Fails when a test file or a test helper is named or placed off-convention.
 *
 * Colocation is already the rule here — a suite sits next to the code it covers,
 * never in `__tests__`. What was never enforced is the *name*, and a name is what
 * makes colocation useful: `packages/http/src/test-app.ts` sat beside two suites
 * looking like application source, because nothing said a helper inside `src/` is
 * spelled `<subject>.fixtures.ts`. A convention that lives only in a skill file is
 * a convention that drifts on the next module.
 *
 * Three shapes, and nothing else:
 *
 *   <subject>[.<aspect>].test.ts   a suite, beside the module it covers
 *   <subject>.fixtures.ts          test doubles, inside src/, beside that module
 *   test-<what>.ts                 package-wide harness, at the package root
 *
 * The first two must name something real: the stem has to be a module in the same
 * directory, or the prefix that directory already namespaces its files with. That
 * is what rejects `failure.test.ts` sitting next to `response.ts` — the suite
 * covers `failure` from `response.ts`, so it is `response.failure.test.ts` and
 * reads as the second suite over that module, the way
 * `projects.repository.paging.test.ts` already does.
 *
 * Scope is `apps/*` and `packages/*`: code that runs under `bun test`. `tools/`
 * is deliberately outside it — these scripts are `package.json` entry points named
 * after the command they implement, and none of them is loaded by a test run.
 */
import { Glob } from "bun";

const ROOTS = ["apps", "packages"];
const IGNORED = /(^|\/)(node_modules|dist|types)\//;
const HELPER = /\.(test|fixtures)\.tsx?$/;
const SUITE = /^(.+)\.test\.tsx?$/;
const FIXTURES = /^(.+)\.fixtures\.tsx?$/;
const SPEC = /\.spec\.tsx?$/;
const EXT = /\.tsx?$/;

interface Entry {
	base: string;
	dir: string;
	path: string;
}

interface Violation {
	fix: string;
	path: string;
	problem: string;
}

const files: Entry[] = [];
const packageRoots = new Set<string>();

for (const root of ROOTS) {
	for (const found of new Glob("**/*.{ts,tsx}").scanSync(root)) {
		const path = `${root}/${found}`;
		if (IGNORED.test(path)) {
			continue;
		}
		const cut = path.lastIndexOf("/");
		files.push({ base: path.slice(cut + 1), dir: path.slice(0, cut), path });
	}
	for (const found of new Glob("*/package.json").scanSync(root)) {
		packageRoots.add(`${root}/${found.slice(0, found.lastIndexOf("/"))}`);
	}
}

/** Every plain module per directory: what a test or a fixture may name itself after. */
const modules = new Map<string, string[]>();
for (const { base, dir } of files) {
	if (HELPER.test(base)) {
		continue;
	}
	const name = base.replace(EXT, "");
	const siblings = modules.get(dir);
	if (siblings) {
		siblings.push(name);
	} else {
		modules.set(dir, [name]);
	}
}

/**
 * `response` names `response.ts`; `projects.service.tenancy` extends
 * `projects.service.ts`; `projects` is the prefix `projects.service.ts` and
 * `projects.repository.ts` share. Anything else names nothing in its directory.
 */
const namesSomething = (dir: string, stem: string) =>
	(modules.get(dir) ?? []).some(
		(name) =>
			name === stem ||
			name.startsWith(`${stem}.`) ||
			stem.startsWith(`${name}.`)
	);

const violations: Violation[] = [];

for (const { base, dir, path } of files) {
	if (path.includes("/__tests__/") || SPEC.test(base)) {
		violations.push({
			fix: "Move it beside the module it covers and name it <subject>.test.ts.",
			path,
			problem: "a suite kept away from the code it covers",
		});
		continue;
	}

	const test = base.match(SUITE);
	if (test?.[1]) {
		if (!namesSomething(dir, test[1])) {
			violations.push({
				fix: `Name it after the module it covers — <subject>[.<aspect>].test.ts, where ${dir}/<subject>.ts exists.`,
				path,
				problem: `"${test[1]}" is not a module in this directory`,
			});
		}
		continue;
	}

	const fixtures = base.match(FIXTURES);
	if (fixtures?.[1]) {
		if (!path.includes("/src/")) {
			violations.push({
				fix: "Test doubles belong beside the code, in src/. A package-wide harness goes at the package root as test-<what>.ts.",
				path,
				problem: "a fixtures file outside src/",
			});
		} else if (!namesSomething(dir, fixtures[1])) {
			violations.push({
				fix: `Name it after what it fakes — <subject>.fixtures.ts, where ${dir}/<subject>.ts exists.`,
				path,
				problem: `"${fixtures[1]}" is not a module in this directory`,
			});
		}
		continue;
	}

	if (base.startsWith("test-") && !packageRoots.has(dir)) {
		violations.push({
			fix: "A harness lives at the package root, beside package.json. Inside src/, test doubles are <subject>.fixtures.ts.",
			path,
			problem: "test-* outside a package root",
		});
	}
}

const SHAPES =
	"  <subject>[.<aspect>].test.ts  a suite, beside the module it covers\n  <subject>.fixtures.ts         test doubles, inside src/, beside that module\n  test-<what>.ts                package-wide harness, at the package root";

if (violations.length > 0) {
	for (const { fix, path, problem } of violations) {
		console.error(`  ${path}\n    ${problem}. ${fix}`);
	}
	console.error(
		`\ncheck-naming: ${violations.length} file(s) off-convention.\n\n${SHAPES}\n`
	);
	process.exit(1);
}

const suites = files.filter(({ base }) => SUITE.test(base)).length;
console.log(
	`check-naming: ${suites} suites and their helpers are named and placed to convention.`
);
