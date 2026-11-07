import type { Q } from "./db";

/** A JSON column as read: SQLite hands back its text, Postgres `jsonb` the parsed value. */
export function readJson<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}

/** A value for a JSON column: SQLite stores its text, Postgres `jsonb` takes the value. */
export function writeJson(q: Q, value: unknown): string {
  return (q.dialect === "sqlite" ? JSON.stringify(value) : value) as string;
}
