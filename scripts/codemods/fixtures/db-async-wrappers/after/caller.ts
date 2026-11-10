import type { Database } from "bun:sqlite";
import { countPicked } from "./db/picked";
import { countSkipped } from "./db/skipped";
import { sqliteDb } from "./db/db";

export async function total(db: Database): Promise<number> {
  return (await countPicked(sqliteDb(db), "a")) + countSkipped(db, "b");
}
