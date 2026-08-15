/**
 * The deliberate violations `check-rules.ts` lints.
 *
 * Separate from the runner only because the fixture list grows with every rule
 * and the 200-code-line limit applies to this repo's tooling too.
 */

export const MODULE_DIR = "apps/server/src/modules/rulecheck";
export const HELPER_DIR = "packages/http/src/rulecheck";
export const LIB_DIR = "apps/server/src/lib/rulecheck";
export const WEB_DIR = "apps/web/src/rulecheck";

export interface Expectation {
	/** Path relative to the repo root. */
	path: string;
	/** Rule id, or "plugin" for a GritQL plugin diagnostic. */
	rule: string;
	/** When set, the fixture must produce NO diagnostic for `rule`. */
	silent?: true;
	source: string;
	why: string;
}

// Deliberately 201 statements. The rule counts every line that is not blank,
// comments included, so all that matters is that there is one line too many.
const LONG_FILE = `${Array.from({ length: 201 }, (_, index) => `export const value${index} = ${index};`).join("\n")}\n`;

// Three bodies that recur, because Biome resolves noRestrictedImports
// last-override-wins: each block carries its own copy of the patterns, and each
// copy needs its own fixture. Written once so the copies cannot drift apart.
const DEEP =
	'import { projectStore } from "@/modules/projects/projects.repository";\nexport const store = projectStore;\n';
const ESCAPE =
	'import { projectStore } from "../../projects/projects.repository";\nexport const store = projectStore;\n';
const QUEUE =
	'import { enqueue } from "@/lib/jobs.repository";\nexport const add = enqueue;\n';

export const EXPECTATIONS: Expectation[] = [
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
		source: DEEP,
		why: "one module reaches into another module's internals",
	},
	{
		path: `${MODULE_DIR}/internal/escape.handlers.ts`,
		rule: "lint/style/noRestrictedImports",
		source: ESCAPE,
		why: "a relative import escapes its module directory",
	},
	{
		path: `${MODULE_DIR}/queue.service.ts`,
		rule: "lint/style/noRestrictedImports",
		source: QUEUE,
		why: "a service reaches past the queue's public face",
	},
	{
		path: `${MODULE_DIR}/queue.handlers.ts`,
		rule: "lint/style/noRestrictedImports",
		source: QUEUE,
		why: "an HTTP layer reaches past the queue's public face",
	},
	{
		// The service block repeats the module-privacy patterns rather than
		// inheriting them, and these two fixtures are the only ones that reach
		// its copies: without them both groups can be deleted and every check
		// stays green.
		path: `${MODULE_DIR}/reach.service.ts`,
		rule: "lint/style/noRestrictedImports",
		source: DEEP,
		why: "a service reaches into another module's internals",
	},
	{
		path: `${MODULE_DIR}/escape.service.ts`,
		rule: "lint/style/noRestrictedImports",
		source: ESCAPE,
		why: "a service escapes its module directory relatively",
	},
	{
		// Every noRestrictedImports fixture above ends in .service.ts or
		// .handlers.ts, so none of them reaches the block scoped to everything in
		// a module that is NOT a service, an HTTP layer or a test — the block that
		// polices *.repository.ts, *.schema.ts and *.fixtures.ts.
		path: `${MODULE_DIR}/rulecheck.repository.ts`,
		rule: "lint/style/noRestrictedImports",
		source: DEEP,
		why: "a repository reaches into another module's internals",
	},
	{
		path: `${MODULE_DIR}/internal/escape.schema.ts`,
		rule: "lint/style/noRestrictedImports",
		source: ESCAPE,
		why: "a schema escapes its module directory relatively",
	},
	{
		// The three module-scoped overrides cannot match a file outside
		// src/modules/, so shared code needs its own block or it is unpoliced.
		path: `${LIB_DIR}/reach.ts`,
		rule: "lint/style/noRestrictedImports",
		source: DEEP,
		why: "shared code reaches into a module's internals",
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
];
