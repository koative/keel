import { readFile } from "node:fs/promises";
/**
 * The two column models `check-migrations.ts` compares: what the committed
 * migration statements declare, and what the Drizzle schema declares.
 *
 * The reader is line-oriented because every committed migration is drizzle-kit
 * formatted: one column per line inside `CREATE TABLE`, one ALTER per line. It
 * reads declarations — never asserts on syntax — and anything it does not
 * recognize is left alone.
 */

// biome-ignore lint/performance/noNamespaceImport: the pass must cover every table the schema gains, and a second explicit list is exactly what drifts — the schema index is the single source of truth the probe itself reads.
import * as schemaModule from "../packages/db/src/schema";

const Columns = Symbol.for("drizzle:Columns");
const TableName = Symbol.for("drizzle:OriginalName");

export interface ColumnDecl {
	notNull: boolean;
}
export type DeclaredModel = Map<string, Map<string, ColumnDecl>>;

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
const DROP_COLUMN = /^ALTER TABLE "([^"]+)" DROP COLUMN "([^"]+)"/;
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
		const [, tableName = "", columnName = "", mode = ""] = alterMatch;
		modelTable(model, tableName).set(columnName, { notNull: mode === "SET" });
		return;
	}
	const addMatch = line.match(ADD_COLUMN);
	if (addMatch) {
		const [, tableName = "", columnName = "", def = ""] = addMatch;
		const table = modelTable(model, tableName);
		table.set(columnName, { notNull: declaresNotNull(def) });
		return;
	}
	const dropMatch = line.match(DROP_COLUMN);
	if (dropMatch) {
		const [, tableName = "", columnName = ""] = dropMatch;
		modelTable(model, tableName).delete(columnName);
		return;
	}
	// A renamed column keeps its constraints, so the declaration carries over.
	const renameMatch = line.match(RENAME_COLUMN);
	if (renameMatch) {
		const [, tableName = "", from = "", to = ""] = renameMatch;
		const table = modelTable(model, tableName);
		const carried = table.get(from);
		if (carried) {
			table.set(to, carried).delete(from);
		}
	}
};

const migrationLines = (sql: string): string[] =>
	sql.split("--> statement-breakpoint").flatMap((chunk) => chunk.split("\n"));

/** Replays what the committed statements declare, in order. */
export const declaredModel = async (
	paths: string[]
): Promise<DeclaredModel> => {
	const model: DeclaredModel = new Map();
	const sqls = await Promise.all(paths.map((path) => readFile(path, "utf8")));
	for (const sql of sqls) {
		let tableName = "";
		for (const rawLine of migrationLines(sql)) {
			const line = rawLine.trim();
			const create = line.match(CREATE_TABLE);
			if (create) {
				const [, name = ""] = create;
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
					const [, columnName = "", def = ""] = column;
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

/** What the Drizzle schema declares, read offline from the schema index. */
export const schemaModel = (): DeclaredModel => {
	const model: DeclaredModel = new Map();
	for (const exported of Object.values(schemaModule)) {
		const metadata = exported as unknown as Record<symbol, unknown>;
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
