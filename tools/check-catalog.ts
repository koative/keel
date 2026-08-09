#!/usr/bin/env bun
/**
 * Guards the Bun catalog against silent drift.
 *
 * `bun add` has no `--catalog` flag, so a new dependency always lands in a
 * workspace manifest as a literal version range. When that dependency is
 * already pinned in the root catalog, the workspace now carries a second,
 * independent source of truth — the exact failure mode an agent introduces
 * without noticing.
 *
 * Fails when a manifest pins a version for a package the catalog already owns,
 * and when the catalog owns a package nobody consumes.
 */
import { Glob } from "bun";

const ROOT_MANIFEST = "package.json";
const DEPENDENCY_FIELDS = [
	"dependencies",
	"devDependencies",
	"peerDependencies",
	"optionalDependencies",
] as const;

type Manifest = {
	workspaces?: { catalog?: Record<string, string> };
} & Partial<Record<(typeof DEPENDENCY_FIELDS)[number], Record<string, string>>>;

const root = (await Bun.file(ROOT_MANIFEST).json()) as Manifest;
const catalog = root.workspaces?.catalog;

if (!catalog) {
	console.error(
		`${ROOT_MANIFEST} declares no workspaces.catalog — nothing to enforce.`
	);
	process.exit(1);
}

const globbed = await Promise.all(
	["apps/*/package.json", "packages/*/package.json"].map((pattern) =>
		Array.fromAsync(new Glob(pattern).scan("."))
	)
);
const manifestPaths = [ROOT_MANIFEST, ...globbed.flat()].sort();
const manifests = await Promise.all(
	manifestPaths.map(
		async (path) => [path, (await Bun.file(path).json()) as Manifest] as const
	)
);

const problems: string[] = [];
const consumed = new Set<string>();

for (const [path, manifest] of manifests) {
	for (const field of DEPENDENCY_FIELDS) {
		for (const [dependency, range] of Object.entries(manifest[field] ?? {})) {
			if (!(dependency in catalog)) {
				continue;
			}
			consumed.add(dependency);
			if (range !== "catalog:") {
				problems.push(
					`${path}: ${field}.${dependency} pins "${range}" but the catalog owns it (${catalog[dependency]}). Use "catalog:".`
				);
			}
		}
	}
}

for (const dependency of Object.keys(catalog)) {
	if (!consumed.has(dependency)) {
		problems.push(
			`${ROOT_MANIFEST}: catalog owns "${dependency}" but no workspace consumes it. Remove the entry.`
		);
	}
}

if (problems.length > 0) {
	for (const problem of problems) {
		console.error(problem);
	}
	console.error(
		`\ncheck-catalog: ${problems.length} problem(s) across ${manifestPaths.length} manifests.`
	);
	process.exit(1);
}

console.log(
	`check-catalog: ${Object.keys(catalog).length} catalog entries across ${manifestPaths.length} manifests, no drift.`
);
