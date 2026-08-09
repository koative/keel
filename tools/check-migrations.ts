#!/usr/bin/env bun
import { rm } from "node:fs/promises";
/**
 * Fails when the Drizzle schema has drifted from the committed migrations.
 *
 * `db:push` is a development convenience: it diffs the live database against the
 * schema and applies whatever it decides is needed. That is the wrong tool for
 * production data — it will drop a column to make the shapes match. Production
 * runs `db:migrate`, which replays committed SQL, so the schema and the migrations
 * have to stay in step.
 *
 * The failure this catches is silent by nature: add a column, `db:push` it locally,
 * everything works, tests pass, and the deployment applies a migration set that
 * knows nothing about it. So the check asks drizzle-kit to generate, and fails if
 * anything new appears.
 */
import { $, Glob } from "bun";

const MIGRATIONS = "packages/db/src/migrations";

const sqlFiles = async () => {
	const found: string[] = [];
	for await (const path of new Glob("*.sql").scan(MIGRATIONS)) {
		found.push(path);
	}
	return found.toSorted((a, b) => a.localeCompare(b));
};

const before = await sqlFiles();

if (before.length === 0) {
	console.error(`${MIGRATIONS} holds no migrations. Run: bun run db:generate`);
	process.exit(1);
}

// drizzle-kit rewrites meta/ as a side effect of generating, so it is copied
// aside first. Restoring from a backup rather than from git keeps this working
// before the migrations are committed and inside a dirty tree.
const backup = (await $`mktemp -d`.text()).trim();
await $`cp -R ${MIGRATIONS}/meta ${backup}/meta`.quiet();

// drizzle-kit writes a file when and only when there is a difference, so the
// generated output is itself the diff.
const result = await $`bunx drizzle-kit generate --name drift-probe`
	.cwd("packages/db")
	.nothrow()
	.quiet();

const after = await sqlFiles();
const added = after.filter((file) => !before.includes(file));

await rm(`${MIGRATIONS}/meta`, { force: true, recursive: true });
await $`cp -R ${backup}/meta ${MIGRATIONS}/meta`.quiet();
await rm(backup, { force: true, recursive: true });

if (added.length > 0) {
	await Promise.all(
		added.map((file) => rm(`${MIGRATIONS}/${file}`, { force: true }))
	);

	console.error(
		`The Drizzle schema has changes with no migration: ${added.join(", ")} would have been created.\n\nRun: bun run db:generate\n`
	);
	process.exit(1);
}

if (result.exitCode !== 0) {
	console.error(`drizzle-kit generate failed:\n${result.stderr.toString()}`);
	process.exit(1);
}

console.log(`check-migrations: ${before.length} migration(s), schema matches.`);
