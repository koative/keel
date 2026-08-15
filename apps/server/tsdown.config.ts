import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
	/**
	 * Off, because nothing imports `dist/`.
	 *
	 * tsdown turns declarations on by default when a package.json advertises
	 * types, and this one does — `exports["./app-type"]` points @keel/api-client
	 * at `types/app.d.mts`. But that file comes from `tsdown.types.config.ts`,
	 * built by a separate `build:types` task; `dist/` holds four executables that
	 * bun runs, and a declaration beside them has no consumer.
	 *
	 * It was not free, either. Emitting them failed outright — a
	 * `rolldown-plugin-dts` warning about eager mode, then six MISSING_EXPORT
	 * errors for the `enqueue` re-export chain that crosses into `@keel/db/jobs`,
	 * which `tsc --noEmit` accepts and `noExternal` then asks the dts bundler to
	 * inline. So `bun run build` and every `docker build` behind it exited 1 for
	 * output nobody reads.
	 */
	dts: false,
	// Separate entries, because these are separate lifecycle steps: a rolling
	// deploy migrates once, then starts N servers and M workers. Bundling the
	// migrator into the server would mean either running it on every boot or
	// shipping dead code, and running it on every boot is how concurrent
	// instances race. The worker is separate for a different reason: it is
	// scaled and restarted independently of the request path.
	entry: [
		"./src/index.ts",
		"./src/migrate.ts",
		"./src/tasks.ts",
		"./src/worker.ts",
	],
	format: "esm",
	noExternal: [/@keel\/.*/],
	outDir: "./dist",
	// The maps carry mappings only. Without this they embed `sourcesContent`, and
	// since the runner stage copies `dist/` wholesale, the full TypeScript source
	// of apps/server and every bundled @keel/* package would ship in the
	// production image — against the no-source invariant the Dockerfile states.
	// A stack trace still resolves to a file and a line; only the ability to read
	// the file out of the artifact is gone.
	outputOptions: { sourcemapExcludeSources: true },
	// Emit .map files beside the bundles so wide-event stack traces (evlog,
	// LOG_DRAIN=otlp) keep their source file/line instead of pointing at line 1
	// of a bundle column. "hidden" would skip the sourceMappingURL comment but
	// buys nothing here: dist is not a published artifact and the comment is what
	// makes `bun dist/index.mjs` attribute frames in tools that read the maps.
	sourcemap: true,
});
