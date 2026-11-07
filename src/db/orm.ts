import type { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

export type Orm = BunSQLiteDatabase<typeof schema>;

const handles = new WeakMap<Database, Orm>();

export function orm(db: Database): Orm {
  let handle = handles.get(db);
  if (handle === undefined) {
    handle = drizzle(db, { schema });
    handles.set(db, handle);
  }
  return handle;
}
