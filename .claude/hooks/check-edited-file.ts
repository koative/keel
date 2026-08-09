#!/usr/bin/env bun
/**
 * Lints the file that was just written and fails loudly if it is wrong.
 *
 * The previous version of this hook ran `bun run fix` over the whole repo after
 * every edit. That is the wrong shape twice over: it reformats files the agent did
 * not touch, and — worse — it silently repairs the mistake instead of reporting
 * it, so the agent never learns that a layer boundary was crossed. Exit code 2
 * feeds the diagnostic back so it can be fixed properly.
 *
 * Formatting is still applied automatically, because whitespace is not a lesson.
 * Lint findings are not.
 */
import { $ } from "bun";

interface HookInput {
	tool_input?: { file_path?: string };
}

const LINTABLE = /\.(ts|tsx|js|jsx|json|jsonc|css)$/;

const raw = await Bun.stdin.text();
let filePath: string | undefined;

try {
	filePath = (JSON.parse(raw) as HookInput).tool_input?.file_path;
} catch {
	// No parseable payload means nothing to check; never block on the hook's own
	// plumbing.
	process.exit(0);
}

if (!(filePath && LINTABLE.test(filePath))) {
	process.exit(0);
}

// Formatting and safe assists are applied silently; only real findings surface.
await $`bunx biome check --write --formatter-enabled=true --linter-enabled=false ${filePath}`
	.nothrow()
	.quiet();

const result = await $`bunx biome check --max-diagnostics=20 ${filePath}`
	.nothrow()
	.quiet();
if (result.exitCode === 0) {
	process.exit(0);
}

const report = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
console.error(`Biome rejected ${filePath}:\n\n${report}`);
console.error(
	"\nThese rules encode the architecture. Read the message before working around it — the layer boundaries, the response envelope and the file-size limit each name their own fix."
);
process.exit(2);
