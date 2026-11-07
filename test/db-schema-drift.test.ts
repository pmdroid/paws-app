import { describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { Column, getTableName, is, SQL } from "drizzle-orm";
import { getTableConfig, SQLiteSyncDialect, SQLiteTable } from "drizzle-orm/sqlite-core";
import { closingParen, createTableParts, rawSchema, schema, splitTopLevel } from "../src/db";
import { tempDb } from "./helpers";

type Shape = Map<string, string>;

const dialect = new SQLiteSyncDialect();
const flat = (text: string) => text.replace(/[\s"`]/g, "").toLowerCase();
const render = (value: SQL | Column) =>
  flat(is(value, Column) ? value.name : dialect.sqlToQuery(value).sql);
const sorted = (values: string[]) => values.sort().join(" | ");
const rawCollations: Record<string, Record<string, string>> = rawSchema.collations;
const collation = (table: string, column: string) =>
  rawCollations[table]?.[column]?.toUpperCase() ?? "BINARY";

function literal(value: unknown): string {
  if (value === undefined || value === null) return "none";
  if (is(value, SQL)) return render(value);
  if (typeof value === "string") return flat(`'${value.replaceAll("'", "''")}'`);
  return flat(String(value));
}

function fromDatabase(db: Database): Shape {
  const shape: Shape = new Map();
  const all = <T>(sql: string, ...params: string[]) => db.query<T, string[]>(sql).all(...params);
  const tables = all<{ name: string; strict: number; wr: number; sql: string }>(
    "SELECT t.name, t.strict, t.wr, m.sql FROM pragma_table_list t JOIN sqlite_master m ON m.name = t.name WHERE t.schema = 'main' AND t.type = 'table' AND t.name NOT LIKE 'sqlite_%' AND t.name != '__drizzle_migrations'",
  );
  for (const table of tables) {
    const { name } = table;
    const parts = createTableParts(table.sql);
    shape.set(
      name,
      `strict=${table.strict} withoutRowid=${table.wr} autoincrement=${/\bAUTOINCREMENT\b/i.test(table.sql)}`,
    );
    const columns = all<{
      name: string;
      type: string;
      notnull: number;
      dflt_value: string | null;
      pk: number;
    }>('SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?)', name);
    for (const column of columns)
      shape.set(
        `${name}.${column.name}`,
        `${column.type.toLowerCase()} notNull=${column.pk > 0 ? "pk" : column.notnull === 1} default=${column.dflt_value === null ? "none" : flat(column.dflt_value)} collate=${(parts.collations[column.name] ?? "BINARY").toUpperCase()}`,
      );
    shape.set(
      `${name} primary key`,
      columns
        .filter((column) => column.pk > 0)
        .sort((a, b) => a.pk - b.pk)
        .map((column) => column.name)
        .join(","),
    );
    const keys = new Map<
      number,
      { from: string[]; to: string[]; table: string; actions: string }
    >();
    for (const key of all<{
      id: number;
      table: string;
      from: string;
      to: string;
      on_update: string;
      on_delete: string;
    }>(
      'SELECT id, "table", "from", "to", on_update, on_delete FROM pragma_foreign_key_list(?) ORDER BY id, seq',
      name,
    )) {
      const entry = keys.get(key.id) ?? {
        from: [],
        to: [],
        table: key.table,
        actions: `${key.on_delete} ${key.on_update}`,
      };
      entry.from.push(key.from);
      entry.to.push(key.to);
      keys.set(key.id, entry);
    }
    shape.set(
      `${name} foreign keys`,
      sorted(
        [...keys.values()].map((key) =>
          `${key.from}->${key.table}(${key.to}) ${key.actions}`.toLowerCase(),
        ),
      ),
    );
    const indexes = all<{ name: string; unique: number; origin: string }>(
      'SELECT name, "unique", origin FROM pragma_index_list(?)',
      name,
    );
    shape.set(
      `${name} unique`,
      sorted(
        indexes
          .filter((index) => index.origin === "u")
          .map((index) =>
            all<{ name: string }>(
              "SELECT name FROM pragma_index_info(?) ORDER BY seqno",
              index.name,
            )
              .map((c) => c.name)
              .join(","),
          ),
      ),
    );
    for (const index of indexes.filter((entry) => entry.origin === "c")) {
      const sql = all<{ sql: string }>(
        "SELECT sql FROM sqlite_master WHERE name = ?",
        index.name,
      )[0]!.sql;
      const open = sql.indexOf("(");
      const close = closingParen(sql, open);
      const where = /^\s*WHERE\s+([\s\S]*)$/i.exec(sql.slice(close + 1))?.[1];
      shape.set(
        `${name} index ${index.name}`,
        `unique=${index.unique === 1} on=${splitTopLevel(sql.slice(open + 1, close))
          .map(flat)
          .join(",")} where=${where === undefined ? "none" : flat(where)}`,
      );
    }
    shape.set(`${name} checks`, sorted(parts.checks.map(flat)));
  }
  for (const row of all<{ type: string; name: string; sql: string }>(
    "SELECT m.type, m.name, m.sql FROM sqlite_master m LEFT JOIN pragma_table_list t ON t.name = m.name AND t.schema = 'main' WHERE m.type = 'trigger' OR t.type = 'virtual'",
  ))
    shape.set(`${row.type === "trigger" ? "trigger" : "virtual table"} ${row.name}`, row.sql);
  return shape;
}

function fromSchema(): Shape {
  const shape: Shape = new Map();
  const tables = Object.values(schema as Record<string, unknown>).filter(
    (value): value is SQLiteTable => is(value, SQLiteTable),
  );
  for (const table of tables) {
    const config = getTableConfig(table);
    const name = config.name;
    const primary =
      config.primaryKeys[0]?.columns.map((column) => column.name) ??
      config.columns.filter((column) => column.primary).map((column) => column.name);
    shape.set(
      name,
      `strict=${Number(rawSchema.strictTables.includes(name as never))} withoutRowid=${Number(rawSchema.withoutRowidTables.includes(name as never))} autoincrement=${config.columns.some((column) => "autoIncrement" in column && column.autoIncrement === true)}`,
    );
    for (const column of config.columns)
      shape.set(
        `${name}.${column.name}`,
        `${column.getSQLType().toLowerCase()} notNull=${primary.includes(column.name) ? "pk" : column.notNull} default=${literal(column.default)} collate=${collation(name, column.name)}`,
      );
    shape.set(`${name} primary key`, primary.join(","));
    shape.set(
      `${name} foreign keys`,
      sorted(
        config.foreignKeys.map((key) => {
          const reference = key.reference();
          return `${reference.columns.map((c) => c.name)}->${getTableName(reference.foreignTable)}(${reference.foreignColumns.map((c) => c.name)}) ${key.onDelete ?? "no action"} ${key.onUpdate ?? "no action"}`.toLowerCase();
        }),
      ),
    );
    shape.set(
      `${name} unique`,
      sorted([
        ...config.uniqueConstraints.map((unique) => unique.columns.map((c) => c.name).join(",")),
        ...config.columns.filter((column) => column.isUnique).map((column) => column.name),
      ]),
    );
    for (const { config: index } of config.indexes)
      shape.set(
        `${name} index ${index.name}`,
        `unique=${index.unique} on=${index.columns.map((term) => render(term as SQL | Column)).join(",")} where=${index.where === undefined ? "none" : render(index.where)}`,
      );
    shape.set(`${name} checks`, sorted(config.checks.map((check) => render(check.value))));
  }
  for (const [name, sql] of Object.entries(rawSchema.triggers)) shape.set(`trigger ${name}`, sql);
  for (const [name, sql] of Object.entries(rawSchema.virtualTables))
    shape.set(`virtual table ${name}`, sql);
  return shape;
}

function drift(db: Database): string[] {
  const actual = fromDatabase(db);
  const expected = fromSchema();
  const found: string[] = [];
  for (const [key, value] of actual) {
    const described = expected.get(key);
    if (described === undefined) found.push(`${key}: in the database, missing from the schema`);
    else if (described !== value)
      found.push(`${key}: database has ${value}; schema has ${described}`);
  }
  for (const key of expected.keys())
    if (!actual.has(key)) found.push(`${key}: in the schema, missing from the database`);
  return found;
}

describe("Drizzle schema", () => {
  test("matches the database 0000_baseline builds", () => {
    expect(drift(tempDb())).toEqual([]);
  });

  test("names a column the database has that the schema lacks", () => {
    const db = tempDb();
    db.run("ALTER TABLE work_item ADD COLUMN drift_probe TEXT");
    expect(drift(db)).toEqual(["work_item.drift_probe: in the database, missing from the schema"]);
  });
});
