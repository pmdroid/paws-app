import { Database } from "bun:sqlite";

export type Db = { run<T>(body: (q: unknown) => T): Promise<T> };

export function openDatabase(path: string): Database {
  return new Database(path);
}

export function migrate(_db: Database): void {}

export function sqliteDb(_database: Database): Db {
  throw new Error("fixture");
}

export async function countItems(_db: Db): Promise<number> {
  return 0;
}
