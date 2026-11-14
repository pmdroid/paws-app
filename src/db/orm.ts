import type { Changes, Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

export type Orm = BunSQLiteDatabase & { $client: Database };

const handles = new WeakMap<Database, Orm>();

export function orm(db: Database): Orm {
  let handle = handles.get(db);
  if (handle === undefined) {
    handle = drizzle(db);
    handles.set(db, handle);
  }
  return handle;
}

export function changes(query: { run(): unknown }): number {
  return (query.run() as Changes).changes;
}
