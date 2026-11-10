import type { Database } from "bun:sqlite";

export type Q = { readonly dialect: "sqlite" };
export type Steps<T> = Generator<unknown, T, unknown>;
export type SqliteDb = {
  run<T>(body: (q: Q) => Steps<T>): Promise<T>;
  transaction<T>(body: (q: Q) => Steps<T>): Promise<T>;
};
export type Db = SqliteDb;

export function sqliteDb(_database: Database): SqliteDb {
  throw new Error("fixture");
}

export function settled<T>(_promise: Promise<T>): T {
  throw new Error("fixture");
}
