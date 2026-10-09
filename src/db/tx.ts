import type { Database } from "bun:sqlite";

/** Immediate transaction. Nested calls become savepoints. */
export function immediate<T>(db: Database, fn: () => T): T {
  return db.transaction(fn).immediate();
}
