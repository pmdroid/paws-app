import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Q } from "./db";

/** A JSON column read as its text: SQLite stores it as text, Postgres as jsonb. */
export function jsonText(q: Q, column: AnyColumn): SQL<string> {
  return q.dialect === "postgres" ? sql<string>`${column}::text` : sql<string>`${column}`;
}

/** A value for a JSON column: text on SQLite, jsonb on Postgres. */
export function jsonValue(q: Q, value: unknown): unknown {
  return q.dialect === "postgres" ? value : JSON.stringify(value);
}

export function jsonField(q: Q, column: AnyColumn, ...path: string[]): SQL<string | null> {
  if (q.dialect === "sqlite")
    return sql`json_extract(${column}, ${sql.raw(`'$.${path.join(".")}'`)})`;
  const last = path.length - 1;
  const steps = path.map((key, index) => `${index === last ? "->>" : "->"}'${key}'`).join("");
  return sql`(${column}${sql.raw(steps)})`;
}

export function parsedJson<T>(q: Q, stored: unknown): T {
  return (q.dialect === "sqlite" ? JSON.parse(stored as string) : stored) as T;
}
