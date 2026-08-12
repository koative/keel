#!/usr/bin/env bun
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
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const BUNDLE = "apps/server/types/app.d.mts";

// The signatures of a `/v1`-shaped branch in the emitted bundle: phantom
// generics with no declaration in the file, and `output: any` where every
// internal endpoint carries a concrete body.
const PHANTOMS = [
	'R["request"]',
	'R_1["request"]',
	"Part extends keyof R",
	"output: any",
];

const bundle = resolve(BUNDLE);

const contents = await readFile(bundle, "utf8").catch(() => null);
if (contents === null) {
	console.error(`${BUNDLE} is missing. Run: bun run build:types -F server`);
	process.exit(1);
}

for (const phantom of PHANTOMS) {
	if (contents.includes(phantom)) {
		console.error(
			`${BUNDLE} carries ${phantom} — the bundle regressed to the frozen /v1 surface. Regenerate it from app-type.ts: bun run build:types -F server`
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
					target: "ESNext",
					module: "ESNext",
					moduleResolution: "bundler",
					lib: ["ESNext", "DOM"],
					strict: true,
					skipLibCheck: false,
					noEmit: true,
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
		console.error(
			`${BUNDLE} does not typecheck with skipLibCheck off:\n` +
				result.stderr.toString() +
				`\nRegenerate it from app-type.ts: bun run build:types -F server`
		);
		process.exit(1);
	}
} finally {
	await rm(dir, { recursive: true, force: true });
}

console.log(
	`check-app-types: ${BUNDLE} is self-contained and typechecks with skipLibCheck off.`
);
