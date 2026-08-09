#!/usr/bin/env bun
/**
 * Runs the full check before an agent is allowed to call the work finished.
 *
 * The per-file hook only sees one file at a time, so it cannot see a broken type
 * across a boundary, a failing test, dependency drift, or an architecture rule
 * that stopped firing. This is the gate that makes "done" mean something.
 *
 * Exit code 2 sends the output back rather than ending the turn.
 */
import { $ } from "bun";

interface HookInput {
	stop_hook_active?: boolean;
}

const raw = await Bun.stdin.text();

try {
	// Set when the agent was already resumed by this hook. Checking it is what
	// keeps a persistent failure from looping forever.
	if ((JSON.parse(raw) as HookInput).stop_hook_active) {
		process.exit(0);
	}
} catch {
	process.exit(0);
}

const result = await $`bun run check`.nothrow().quiet();
if (result.exitCode === 0) {
	process.exit(0);
}

const report = `${result.stdout.toString()}${result.stderr.toString()}`.trim();
console.error(
	`\`bun run check\` is failing, so the work is not finished:\n\n${report.slice(-6000)}`
);
process.exit(2);
