import type { Database } from "bun:sqlite";
import { countItems } from "./db/items";
import { sqliteDb } from "./db/db";

export async function total(db: Database): Promise<number> {
  return (await countItems(sqliteDb(db), "a")) + 1;
}
