#!/usr/bin/env bun
import { existsSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
/**
 * Proves the architecture rules actually fire.
 *
 * Every layer boundary in this repo is enforced by a Biome rule rather than a
 * paragraph of documentation, which raises a second question: what enforces the
 * enforcement? A rule that silently stops matching — a renamed option, a preset
 * that turns it off, a resolver regression in a patch release — looks exactly
 * like a clean codebase. Two such regressions already happened here while this
 * config was being written.
 *
 * So each rule gets a fixture that violates it on purpose. The fixture is
 * written at a real repo path, because the rules are scoped by path globs and a
 * copy of the config in a temp directory would only test the copy.
 */
import { $ } from "bun";

import {
	EXPECTATIONS,
	HELPER_DIR,
	LIB_DIR,
	MODULE_DIR,
	WEB_DIR,
} from "./check-rules.fixtures";

const DIRS = [LIB_DIR, MODULE_DIR, HELPER_DIR, WEB_DIR];

/**
 * The second halves of two fixtures: files that have to exist for a cycle and a
 * private export to be reachable, but that assert nothing themselves. They live
 * with the run rather than with the expectations because nothing checks them.
 */
const SUPPORT: { path: string; source: string }[] = [
	{
		path: `${MODULE_DIR}/cycle-b.service.ts`,
		source:
			'import { a } from "./cycle-a.service";\nexport const b = () => a;\n',
	},
	{
		path: `${MODULE_DIR}/hidden.service.ts`,
		source: "/** @private */\nexport const secret = 1;\n",
	},
];

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

try {
	await Promise.all(
		[...EXPECTATIONS, ...SUPPORT].map(({ path, source }) => write(path, source))
	);

	// One invocation for both fixture trees: the goal is to observe which rules
	// Biome reports, not to isolate each file.
	//
	// Both streams are read. Biome sends pretty diagnostics to stderr and the
	// github reporter to stdout, and a tool that only reads one of them reports
	// "no violations found" when it is really looking at the wrong pipe — the
	// exact silent success this script exists to rule out.
	const result =
		await $`bunx biome lint --max-diagnostics=200 --reporter=github ${MODULE_DIR} ${HELPER_DIR} ${LIB_DIR} ${WEB_DIR}`
			.nothrow()
			.quiet();
	const lines =
		`${result.stdout.toString()}\n${result.stderr.toString()}`.split("\n");

	for (const { path, rule, silent, why } of EXPECTATIONS) {
		const fired = lines.some(
			(line) => line.includes(`file=${path}`) && line.includes(rule)
		);

		if (fired !== Boolean(silent)) {
			console.log(
				`  ok   ${(silent ? `${rule} (silent)` : rule).padEnd(42)} ${why}`
			);
			continue;
		}

		failures += 1;
		if (silent) {
			console.error(`  LOUD ${rule.padEnd(42)} ${why}`);
			console.error(`       fixture ${path} was flagged but must be exempt`);
		} else {
			console.error(`  DEAD ${rule.padEnd(42)} ${why}`);
			console.error(`       fixture ${path} produced no ${rule} diagnostic`);
		}
	}
} finally {
	await cleanup();
}

if (failures > 0) {
	console.error(
		`\ncheck-rules: ${failures} rule(s) no longer fire. The architecture is unguarded.`
	);
	process.exit(1);
}

console.log(
	`\ncheck-rules: ${new Set(EXPECTATIONS.map((e) => e.rule)).size} rules verified against ${EXPECTATIONS.length} deliberate fixtures.`
);
