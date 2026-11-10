import type { Database } from "bun:sqlite";
import { settled, sqliteDb, type Q, type Steps } from "./db";

export function* countSkippedSteps(_q: Q, kind: string): Steps<number> {
  yield kind;
  return kind.length;
}

export function countSkipped(db: Database, kind: string): number {
  return settled(sqliteDb(db).run((q) => countSkippedSteps(q, kind)));
}
