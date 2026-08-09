import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
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
});
