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

const MODULE_DIR = "apps/server/src/modules/rulecheck";
const HELPER_DIR = "packages/http/src/rulecheck";

interface Expectation {
	/** Path relative to the repo root. */
	path: string;
	/** Rule id, or "plugin" for a GritQL plugin diagnostic. */
	rule: string;
	/** When set, the fixture must produce NO diagnostic for `rule`. */
	silent?: true;
	source: string;
	why: string;
}

// Deliberately 201 statements with no comments and no blank lines: the rule
// counts code, so a fixture padded with comments would pass and the check would
// report a working rule as dead.
const LONG_FILE = `${Array.from({ length: 201 }, (_, index) => `export const value${index} = ${index};`).join("\n")}\n`;

const EXPECTATIONS: Expectation[] = [
	{
		path: `${MODULE_DIR}/rulecheck.handlers.ts`,
		rule: "plugin",
		source:
			'import type { Context } from "hono";\nexport const list = (c: Context) => c.json({ data: [] }, 200);\n',
		why: "a handler builds a response envelope by hand",
	},
	{
		path: `${MODULE_DIR}/rulecheck.service.ts`,
		rule: "lint/style/noRestrictedImports",
		source:
			'import type { Context } from "hono";\nexport const use = (c: Context) => c.req.path;\n',
		why: "a service imports hono",
	},
	{
		path: `${MODULE_DIR}/store.service.ts`,
		rule: "lint/style/noRestrictedImports",
		source: 'import { db } from "@keel/db";\nexport const rows = () => db;\n',
		why: "a service reaches the database directly",
	},
	{
		path: `${MODULE_DIR}/reply.service.ts`,
		rule: "lint/style/noRestrictedImports",
		source:
			'import { ok } from "@keel/http/response";\nexport const send = ok;\n',
		why: "a service owns a response shape",
	},
	{
		path: `${MODULE_DIR}/internal/rulecheck.handlers.ts`,
		rule: "lint/style/noRestrictedImports",
		source: 'import { eq } from "drizzle-orm";\nexport const op = eq;\n',
		why: "an HTTP layer uses Drizzle",
	},
	{
		path: `${MODULE_DIR}/deep.handlers.ts`,
		rule: "lint/style/noRestrictedImports",
		source:
			'import { projectStore } from "@/modules/projects/projects.repository";\nexport const store = projectStore;\n',
		why: "one module reaches into another module's internals",
	},
	{
		path: `${MODULE_DIR}/internal/escape.handlers.ts`,
		rule: "lint/style/noRestrictedImports",
		source:
			'import { projectStore } from "../../projects/projects.repository";\nexport const store = projectStore;\n',
		why: "a relative import escapes its module directory",
	},
	{
		path: `${MODULE_DIR}/env.service.ts`,
		rule: "lint/style/noProcessEnv",
		source: "export const url = process.env.DATABASE_URL;\n",
		why: "code reads process.env instead of @keel/env",
	},
	{
		path: `${MODULE_DIR}/long.service.ts`,
		rule: "lint/style/noExcessiveLinesPerFile",
		source: LONG_FILE,
		why: "a file grew past 200 code lines",
	},
	{
		path: `${MODULE_DIR}/undeclared.service.ts`,
		rule: "lint/correctness/noUndeclaredDependencies",
		source:
			'import { render } from "react-dom";\nexport const draw = render;\n',
		why: "a workspace imports a dependency it does not declare",
	},
	{
		path: `${MODULE_DIR}/cycle-a.service.ts`,
		rule: "lint/suspicious/noImportCycles",
		source:
			'import { b } from "./cycle-b.service";\nexport const a = () => b;\n',
		why: "two files import each other",
	},
	{
		path: `${MODULE_DIR}/peek.service.ts`,
		rule: "lint/correctness/noPrivateImports",
		source:
			'import { secret } from "./hidden.service";\nexport const value = secret;\n',
		why: "one file imports another's private export",
	},
	{
		// The one legitimate c.json in the repo. If the plugin's exemption breaks,
		// it starts flagging the very helpers it tells authors to use.
		path: `${HELPER_DIR}/exempt.ts`,
		rule: "plugin",
		silent: true,
		source:
			'import type { Context } from "hono";\nexport const send = (c: Context) => c.json({ data: null }, 200);\n',
		why: "the response helper module itself may call c.json",
	},
];

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
		await $`bunx biome lint --max-diagnostics=200 --reporter=github ${MODULE_DIR} ${HELPER_DIR}`
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
