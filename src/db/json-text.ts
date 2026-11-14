import { sql, type AnyColumn, type SQL } from "drizzle-orm";
import type { Q } from "./db";

export function jsonText(q: Q, column: AnyColumn): SQL<string> {
  return sql<string>`${column}::text`;
}

export function jsonValue(q: Q, value: unknown): unknown {
  return value;
}

export function jsonField(q: Q, column: AnyColumn, ...path: string[]): SQL<string | null> {
  const last = path.length - 1;
  const steps = path.map((key, index) => `${index === last ? "->>" : "->"}'${key}'`).join("");
  return sql`(${column}${sql.raw(steps)})`;
}

export function parsedJson<T>(q: Q, stored: unknown): T {
  return stored as T;
}

export function jsonFromText(q: Q, text: string): SQL {
  return sql`${text}::text::jsonb`;
}
