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
 * check also replays what the committed statements declare about column
 * nullability and compares it with the schema's, which is the only way a
 * hand-edit that drizzle-kit would not re-emit becomes visible.
 *
 * The reader is line-oriented because every committed migration is drizzle-kit
 * formatted: one column per line inside `CREATE TABLE`, one ALTER per line. It
 * reads declarations — never asserts on syntax — and anything it does not
 * recognize is left alone.
 */
import { $, Glob } from "bun";

// biome-ignore lint/performance/noNamespaceImport: the pass must cover every table the schema gains, and a second explicit list is exactly what drifts — the schema index is the single source of truth the probe itself reads.
import * as schemaModule from "../packages/db/src/schema";

const MIGRATIONS = "packages/db/src/migrations";

const sqlFiles = async () => {
	const found: string[] = [];
	for await (const path of new Glob("*.sql").scan(MIGRATIONS)) {
		found.push(path);
	}
	return found.toSorted((a, b) => a.localeCompare(b));
};

const Columns = Symbol.for("drizzle:Columns");
const TableName = Symbol.for("drizzle:OriginalName");

interface ColumnDecl {
	notNull: boolean;
}
type DeclaredModel = Map<string, Map<string, ColumnDecl>>;

const modelTable = (model: DeclaredModel, name: string) => {
	const table = model.get(name) ?? new Map<string, ColumnDecl>();
	model.set(name, table);
	return table;
};

const CREATE_TABLE = /^CREATE TABLE "([^"]+)" \($/;
const COLUMN_DEF = /^"([^"]+)" (.*)$/;
const ALTER_COLUMN_NOT_NULL =
	/^ALTER TABLE "([^"]+)" ALTER COLUMN "([^"]+)" (SET|DROP) NOT NULL/;
const ADD_COLUMN = /^ALTER TABLE "([^"]+)" ADD COLUMN "([^"]+)" (.*)/;
const RENAME_COLUMN =
	/^ALTER TABLE "([^"]+)" RENAME COLUMN "([^"]+)" TO "([^"]+)"/;
const STRIP_QUOTED = /['"][^'"]*['"]/g;
const NOT_NULL = /\bNOT NULL\b/;
const PRIMARY_KEY = /\bPRIMARY KEY\b/;

/** A column definition is NOT NULL when it says so, or when it is a primary key. */
const declaresNotNull = (text: string): boolean => {
	const bare = text.replace(STRIP_QUOTED, " ");
	return NOT_NULL.test(bare) || PRIMARY_KEY.test(bare);
};

/** Applies an ALTER statement's effect on the declared model. */
const applyAlter = (model: DeclaredModel, line: string): void => {
	const alterMatch = line.match(ALTER_COLUMN_NOT_NULL);
	if (alterMatch) {
		const [, tableName, columnName, mode] = alterMatch;
		modelTable(model, tableName).set(columnName, { notNull: mode === "SET" });
		return;
	}
	const addMatch = line.match(ADD_COLUMN);
	if (addMatch) {
		const [, tableName, columnName, def] = addMatch;
		const table = modelTable(model, tableName);
		table.set(columnName, { notNull: declaresNotNull(def) });
		return;
	}
	// A renamed column keeps its constraints, so the declaration carries over.
	const renameMatch = line.match(RENAME_COLUMN);
	if (renameMatch) {
		const [, tableName, from, to] = renameMatch;
		const table = modelTable(model, tableName);
		const carried = table.get(from);
		if (carried) {
			table.set(to, carried).delete(from);
		}
	}
};

const migrationLines = (sql: string): string[] =>
	sql.split("--> statement-breakpoint").flatMap((chunk) => chunk.split("\n"));

/** Replays the committed statements' nullability declarations, in order. */
const declaredModel = async (files: string[]): Promise<DeclaredModel> => {
	const model: DeclaredModel = new Map();
	const sqls = await Promise.all(
		files.map((file) => readFile(`${MIGRATIONS}/${file}`, "utf8"))
	);
	for (const sql of sqls) {
		let tableName = "";
		for (const rawLine of migrationLines(sql)) {
			const line = rawLine.trim();
			const create = line.match(CREATE_TABLE);
			if (create) {
				const [, name] = create;
				tableName = name;
				continue;
			}
			if (tableName) {
				if (line.startsWith(")")) {
					tableName = "";
					continue;
				}
				const column = line.match(COLUMN_DEF);
				if (column) {
					const [, columnName, def] = column;
					const table = modelTable(model, tableName);
					table.set(columnName, { notNull: declaresNotNull(def) });
				}
				continue;
			}
			applyAlter(model, line);
		}
	}
	return model;
};

const schemaModel = (): DeclaredModel => {
	const model: DeclaredModel = new Map();
	for (const exported of Object.values(schemaModule)) {
		const metadata = exported as Record<symbol, unknown>;
		const columns = metadata[Columns] as
			| Record<string, ColumnDecl & { name: string }>
			| undefined;
		if (!columns) {
			continue;
		}
		const declared = new Map<string, ColumnDecl>();
		for (const column of Object.values(columns)) {
			declared.set(column.name, { notNull: column.notNull });
		}
		model.set(metadata[TableName] as string, declared);
	}
	return model;
};

const before = await sqlFiles();
if (before.length === 0) {
	console.error(`${MIGRATIONS} holds no migrations. Run: bun run db:generate`);
	process.exit(1);
}

// Runs before the probe: it is cheaper and names the column, while the probe can
// only name the migration file it would have created. Columns the migrations
// declare but the schema lacks, and vice versa, are left to the probe.
const declared = await declaredModel(before);
const schemaSide = schemaModel();
const drift: string[] = [];
for (const [tableName, table] of declared) {
	const schemaTable = schemaSide.get(tableName);
	if (!schemaTable) {
		continue;
	}
	for (const [columnName, column] of table) {
		const schemaColumn = schemaTable.get(columnName);
		if (schemaColumn && schemaColumn.notNull !== column.notNull) {
			drift.push(
				`"${tableName}"."${columnName}": migrations declare ${column.notNull ? "NOT NULL" : "nullable"}, schema declares ${schemaColumn.notNull ? "NOT NULL" : "nullable"}`
			);
		}
	}
}
if (drift.length > 0) {
	console.error(
		`The committed migrations and the schema disagree on column nullability:\n  ${drift.join("\n  ")}\n\nThe generate probe cannot see this: it diffs the schema against the latest snapshot, and a snapshot records what the schema declared, not what the migration SQL does. Reconcile the column, then run: bun run db:generate\n`
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
