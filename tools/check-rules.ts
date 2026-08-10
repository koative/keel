#!/usr/bin/env bun
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
	SUPPORT,
} from "./check-rules.fixtures";

async function write(path: string, source: string) {
	await mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
	await Bun.write(path, source);
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
		await $`bunx biome lint --max-diagnostics=200 --reporter=github ${MODULE_DIR} ${HELPER_DIR} ${LIB_DIR}`
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
	await Promise.all([
		rm(LIB_DIR, { force: true, recursive: true }),
		rm(MODULE_DIR, { force: true, recursive: true }),
		rm(HELPER_DIR, { force: true, recursive: true }),
	]);
}

if (failures > 0) {
	console.error(
		`\ncheck-rules: ${failures} rule(s) no longer fire. The architecture is unguarded.`
	);
	process.exit(1);
}

console.log(
	`\ncheck-rules: ${EXPECTATIONS.length} architecture rules verified against deliberate violations.`
);
