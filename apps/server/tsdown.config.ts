import { defineConfig } from "tsdown";

export default defineConfig({
	clean: true,
	// Two entries, because migrating and serving are separate lifecycle steps: a
	// rolling deploy migrates once, then starts N instances. Bundling the migrator
	// into the server would mean either running it on every boot or shipping dead
	// code, and running it on every boot is how concurrent instances race.
	entry: ["./src/index.ts", "./src/migrate.ts", "./src/tasks.ts"],
	format: "esm",
	noExternal: [/@keel\/.*/],
	outDir: "./dist",
});
