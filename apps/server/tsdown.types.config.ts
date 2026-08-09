import { defineConfig } from "tsdown";

/**
 * Bundles the app's declarations into one self-contained file for
 * @keel/api-client.
 *
 * hc<AppType>'s inference cost grows with the endpoint count; consuming a
 * prebuilt .d.mts means the client package never re-infers the server's route
 * tree, and the point of doing it at three endpoints is not to discover the
 * problem at eighty.
 *
 * Bundling rather than `tsc --emitDeclarationOnly` because the emitted tree
 * would carry the server's `@/*` path alias into a package that has no business
 * knowing it. The alias is not incidental — the layer rules mandate `@/lib/*`
 * over a relative import that escapes a module — so it has to be resolved here
 * instead of removed there.
 */
export default defineConfig({
	clean: true,
	dts: { emitDtsOnly: true },
	entry: "./src/app.ts",
	format: "esm",
	outDir: "types",
	tsconfig: "./tsconfig.json",
});
