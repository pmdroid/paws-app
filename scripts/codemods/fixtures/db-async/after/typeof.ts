import type { Database } from "bun:sqlite";
import { countItems } from "./db/items";
import { sqliteDb } from "./db/db";

export type Counter = typeof countItems;

export async function countTwice(db: Database): Promise<number> {
  return (await countItems(sqliteDb(db), "a")) * 2;
}
