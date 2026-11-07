import { describe, expect, test } from "bun:test";
import { getTableColumns, is } from "drizzle-orm";
import {
  getTableConfig as pgConfig,
  integer as pgInteger,
  PgTable,
  pgTable,
  text as pgText,
} from "drizzle-orm/pg-core";
import {
  getTableConfig as sqliteConfig,
  integer,
  SQLiteTable,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";
import { pgSchema, schema } from "../src/db";

type Shape = { columns: { name: string; notNull: boolean }[]; primaryKey: string };

function shapes(tables: Record<string, unknown>): Map<string, Shape> {
  const result = new Map<string, Shape>();
  for (const table of Object.values(tables)) {
    const config = is(table, SQLiteTable)
      ? sqliteConfig(table)
      : is(table, PgTable)
        ? pgConfig(table)
        : null;
    if (!config) continue;
    const columns = Object.values(getTableColumns(table as SQLiteTable | PgTable));
    const primary = [
      ...columns.filter((column) => column.primary).map((column) => column.name),
      ...config.primaryKeys.flatMap((key) => key.columns.map((column) => column.name)),
    ];
    result.set(config.name, {
      columns: columns.map((column) => ({
        name: column.name,
        notNull: column.notNull || primary.includes(column.name),
      })),
      primaryKey: primary.join(","),
    });
  }
  return result;
}

function dialectDrift(sqlite: Record<string, unknown>, pg: Record<string, unknown>): string[] {
  const left = shapes(sqlite);
  const right = shapes(pg);
  const drift: string[] = [];
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(name);
    const b = right.get(name);
    if (!a || !b) {
      drift.push(`${name}: only in ${a ? "sqlite" : "postgres"}`);
      continue;
    }
    const names = (shape: Shape) => shape.columns.map((column) => column.name);
    for (const column of names(a).filter((other) => !names(b).includes(other)))
      drift.push(`${name}.${column}: only in sqlite`);
    for (const column of names(b).filter((other) => !names(a).includes(other)))
      drift.push(`${name}.${column}: only in postgres`);
    const shared = (shape: Shape) =>
      shape.columns.filter(
        (column) => names(a).includes(column.name) && names(b).includes(column.name),
      );
    shared(a).forEach((column, index) => {
      const other = shared(b)[index]!;
      if (other.name !== column.name)
        drift.push(`${name}.${column.name}: sqlite has it where postgres has ${other.name}`);
      else if (other.notNull !== column.notNull)
        drift.push(
          `${name}.${column.name}: notNull ${column.notNull} in sqlite, ${other.notNull} in postgres`,
        );
    });
    if (a.primaryKey !== b.primaryKey)
      drift.push(`${name} primary key: (${a.primaryKey}) in sqlite, (${b.primaryKey}) in postgres`);
  }
  return drift;
}

describe("the Postgres schema", () => {
  test("has every SQLite table, with the same columns in order, nullability and primary keys", () => {
    expect(shapes(schema).size).toBeGreaterThan(0);
    expect(dialectDrift(schema, pgSchema)).toEqual([]);
  });

  test("drift names the table and column a fixture adds to one schema", () => {
    const sqlite = {
      probe: sqliteTable("probe", { id: integer().primaryKey(), name: text().notNull() }),
    };
    const pg = {
      probe: pgTable("probe", {
        id: pgInteger().primaryKey(),
        name: pgText().notNull(),
        extra: pgText(),
      }),
    };
    expect(dialectDrift(sqlite, pg)).toEqual(["probe.extra: only in postgres"]);
    expect(dialectDrift({ ...sqlite, other: sqliteTable("other", { id: text() }) }, pg)).toEqual([
      "probe.extra: only in postgres",
      "other: only in sqlite",
    ]);
  });

  test("drift names a column whose order, nullability or key differs", () => {
    const sqlite = {
      probe: sqliteTable("probe", { id: text().primaryKey(), a: text().notNull(), b: text() }),
    };
    const pg = {
      probe: pgTable("probe", { id: pgText(), b: pgText(), a: pgText() }),
    };
    expect(dialectDrift(sqlite, pg)).toEqual([
      "probe.id: notNull true in sqlite, false in postgres",
      "probe.a: sqlite has it where postgres has b",
      "probe.b: sqlite has it where postgres has a",
      "probe primary key: (id) in sqlite, () in postgres",
    ]);
  });
});
