import type { Database } from "bun:sqlite";
import { settled, sqliteDb, type Q, type Steps } from "./db";

export function* countPickedSteps(_q: Q, kind: string): Steps<number> {
  yield kind;
  return kind.length;
}

export function countPicked(db: Database, kind: string): number {
  return settled(sqliteDb(db).run((q) => countPickedSteps(q, kind)));
}
