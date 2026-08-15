#!/usr/bin/env bun
import { readFile, rm } from "node:fs/promises";
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
 *
 * Generation alone is not enough. The probe diffs the schema against the latest
 * meta snapshot, and a snapshot records the schema's intent, not what the
 * committed SQL does — 0001's snapshot declares `created_by` nullable (as the
 * schema always did) while the generated rename would have kept `owner_id`'s NOT
 * NULL, and the hand-added `DROP NOT NULL` is what makes the replay agree. So the
 * check also replays which columns the committed statements declare, and with
 * what nullability, and compares that with the schema. Those two facts are all
 * the replay covers, and a hand-edit can drift others; the pass below names the
 * ones nothing here sees.
 *
 * How each side is read — the line-oriented replay of the committed statements
 * and the offline read of the schema index — lives in `check-migrations.model`.
 */
import { $, Glob } from "bun";
import { declaredModel, schemaModel } from "./check-migrations.model";

const MIGRATIONS = "packages/db/src/migrations";

const sqlFiles = async () => {
	const found: string[] = [];
	for await (const path of new Glob("*.sql").scan(MIGRATIONS)) {
		found.push(path);
	}
	return found.toSorted((a, b) => a.localeCompare(b));
};

/** The migration tags drizzle will actually apply, in journal order. */
const journalTags = async (): Promise<string[]> => {
	const journal = JSON.parse(
		await readFile(`${MIGRATIONS}/meta/_journal.json`, "utf8")
	) as { entries: { tag: string }[] };
	return journal.entries.map((entry) => entry.tag);
};

const before = await sqlFiles();
if (before.length === 0) {
	console.error(`${MIGRATIONS} holds no migrations. Run: bun run db:generate`);
	process.exit(1);
}

// drizzle applies only the tags meta/_journal.json lists, so a committed .sql
// with no entry never runs in production — and the replay below would then
// assert the schema agrees with statements no deployed database has executed.
const tags = await journalTags();
const committed = before.map((file) => file.slice(0, -".sql".length));
const unlisted = committed
	.filter((name) => !tags.includes(name))
	.map((name) => `${name}.sql is committed, and no journal entry applies it`);
const unwritten = tags
	.filter((tag) => !committed.includes(tag))
	.map((tag) => `the journal lists ${tag}, and no ${tag}.sql exists`);
if (unlisted.length > 0 || unwritten.length > 0) {
	console.error(
		`The migration journal and the committed SQL disagree:\n  ${[...unlisted, ...unwritten].join("\n  ")}\n\nRun: bun run db:generate\n`
	);
	process.exit(1);
}

// Runs before the probe: it is cheaper and names the column, while the probe can
// only name the migration file it would have created. A column the schema
// declares but the migrations lack belongs to the probe, which re-emits it. The
// reverse belongs here: the probe diffs the schema against the latest meta
// snapshot and never opens a .sql file, so a column hand-added to a committed
// migration is invisible to it. Those two facts — that the schema declares the
// column at all, and that both sides agree on its nullability — are this pass's
// whole scope. A hand-edited DEFAULT or type, a UNIQUE dropped from an index and
// a deleted constraint are seen by neither pass.
const declared = await declaredModel(
	before.map((file) => `${MIGRATIONS}/${file}`)
);
const schemaSide = schemaModel();
const drift: string[] = [];
for (const [tableName, table] of declared) {
	const schemaTable = schemaSide.get(tableName);
	if (!schemaTable) {
		continue;
	}
	for (const [columnName, column] of table) {
		const schemaColumn = schemaTable.get(columnName);
		if (!schemaColumn) {
			drift.push(
				`"${tableName}"."${columnName}": the migrations declare this column, the schema does not`
			);
		} else if (schemaColumn.notNull !== column.notNull) {
			drift.push(
				`"${tableName}"."${columnName}": migrations declare ${column.notNull ? "NOT NULL" : "nullable"}, schema declares ${schemaColumn.notNull ? "NOT NULL" : "nullable"}`
			);
		}
	}
}
if (drift.length > 0) {
	console.error(
		`The committed migrations and the schema disagree:\n  ${drift.join("\n  ")}\n\nThe generate probe cannot see this: it diffs the schema against the latest snapshot, and a snapshot records what the schema declared, not what the migration SQL does. Reconcile the column, then run: bun run db:generate\n`
	);
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
