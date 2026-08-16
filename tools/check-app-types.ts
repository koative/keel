#!/usr/bin/env bun
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
/**
 * Fails when the typed-client declaration bundle cannot be checked without
 * `skipLibCheck`.
 *
 * `packages/config/tsconfig.base.json` sets `skipLibCheck: true`, so a bundle
 * carrying unresolved identifiers — the `/v1` phantom generics this gate was
 * written for — typechecks everywhere it is consumed and rots silently. This
 * check compiles the bundle with the flag off, and additionally greps for the
 * free-identifier signatures that tsc does not always surface from inside
 * Hono's schema types, so the failure names the disease.
 */
import { $ } from "bun";

const BUNDLE = "apps/server/types/app.d.mts";

// Plan 029's rule, checked literally: a `/v1` path in the bundle means the
// frozen contract is back in the client's surface, whether or not its types
// resolve. The rest are the signatures of a `/v1`-shaped branch that tsc does
// not always surface — phantom generics with no declaration in the file, and
// `output: any` where every internal endpoint carries a concrete body.
const PHANTOMS = [
	'"/v1',
	'R["request"]',
	'R_1["request"]',
	"Part extends keyof R",
	"output: any",
];

const bundle = resolve(BUNDLE);

const contents = await readFile(bundle, "utf8").catch(() => null);
if (contents === null) {
	console.error(
		`${BUNDLE} is missing. Run: bun run --filter server build:types`
	);
	process.exit(1);
}

for (const phantom of PHANTOMS) {
	if (contents.includes(phantom)) {
		console.error(
			`${BUNDLE} carries ${phantom} — the bundle regressed to the frozen /v1 surface. Regenerate it from app-type.ts: bun run --filter server build:types`
		);
		process.exit(1);
	}
}

// The bundle is a library file, so the base tsconfig's skipLibCheck: true hides
// any unresolved identifier it emits. Compile it from a scratch config with
// the flag off — a self-contained bundle must be its own program.
const dir = await mkdtemp(join(tmpdir(), "keel-app-types-"));
try {
	await writeFile(
		join(dir, "tsconfig.json"),
		JSON.stringify(
			{
				compilerOptions: {
					lib: ["ESNext", "DOM"],
					module: "ESNext",
					moduleResolution: "bundler",
					noEmit: true,
					skipLibCheck: false,
					strict: true,
					target: "ESNext",
					types: [],
				},
				files: [bundle],
			},
			null,
			2
		)
	);
	const result = await $`bunx tsc -p ${join(dir, "tsconfig.json")}`
		.nothrow()
		.quiet();
	if (result.exitCode !== 0) {
		// `tsc` writes diagnostics to stdout and reserves stderr for its own
		// failures — a bad config, a crash. Reporting only stderr printed an empty
		// message for every diagnostic this check exists to surface, which is how
		// it stayed unnoticed: the check failed correctly and said nothing.
		const diagnostics = [result.stdout.toString(), result.stderr.toString()]
			.filter((stream) => stream.trim() !== "")
			.join("\n");
		console.error(
			`${BUNDLE} does not typecheck with skipLibCheck off:\n${diagnostics}\nRegenerate it from app-type.ts: bun run --filter server build:types`
		);
		process.exit(1);
	}
} finally {
	await rm(dir, { force: true, recursive: true });
}

console.log(
	`check-app-types: ${BUNDLE} is self-contained and typechecks with skipLibCheck off.`
);
