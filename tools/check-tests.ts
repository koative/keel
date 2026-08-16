#!/usr/bin/env bun
/**
 * Runs the typecheck and test tasks, and fails when a suite skipped itself.
 *
 * Every integration suite is a `describe.skipIf(!ready)`, so with the test
 * database unreachable bun reports `145 pass / 147 skip / 0 fail` and exits 0,
 * turbo calls all 21 tasks successful, and `bun run check` — the command
 * AGENTS.md tells every contributor and every agent to run after every change —
 * is green having proved nothing about tenancy, the job queue, audit or the
 * webhook receivers. CI asserted the skip count in a workflow step of its own, so
 * the gate a developer runs and the gate that blocks a merge disagreed about what
 * green means. The assertion belongs to the gate itself, not to one of its two
 * callers.
 *
 * The single turbo invocation is wrapped rather than repeated: `test` is
 * `cache: false`, so a second `turbo run test` would re-execute every suite
 * against the shared test database. Wrapping costs turbo's interactive TUI — it
 * streams instead, because stdout is a pipe here — which is the output CI already
 * reads, and it is what puts a suite's own `[skip]` notice on screen instead of
 * inside a pane that scrolls away.
 */

const TURBO = ["bunx", "turbo", "run", "check-types", "test"];

/**
 * bun writes its summary to stderr and a suite's own notice to stdout, and turbo
 * prefixes both with `<package>:<task>: `, hence the `:` alternative to `^`. The
 * leading `[1-9]` is what keeps `0 skip` from failing the run.
 */
const SKIPPED = /(^|:)[ \t]*[1-9][0-9]* skip|\(skip\)/;

/** Writes the stream through to the terminal, and returns what went past. */
const forward = async (
	stream: ReadableStream<Uint8Array>,
	sink: typeof Bun.stdout
) => {
	const decoder = new TextDecoder();
	let text = "";
	for await (const chunk of stream) {
		await Bun.write(sink, chunk);
		text += decoder.decode(chunk, { stream: true });
	}
	return text + decoder.decode();
};

const turbo = Bun.spawn(TURBO, { stderr: "pipe", stdout: "pipe" });
const [out, err] = await Promise.all([
	forward(turbo.stdout, Bun.stdout),
	forward(turbo.stderr, Bun.stderr),
]);
const exitCode = await turbo.exited;

// A real failure is reported by turbo, in its own words, and its exit code is
// what the chain in package.json already stops on.
if (exitCode !== 0) {
	process.exit(exitCode);
}

const skipped = `${out}\n${err}`
	.split("\n")
	.filter((line) => SKIPPED.test(line));

if (skipped.length > 0) {
	for (const line of skipped) {
		console.error(line.trim());
	}
	console.error(
		"\ncheck-tests: tests were skipped — the test database was not reachable, or a generated module's repository is still throwing. Start it with `bun run db:test:start && bun run db:test:migrate`."
	);
	process.exit(1);
}

console.log("check-tests: every suite ran, nothing skipped.");
