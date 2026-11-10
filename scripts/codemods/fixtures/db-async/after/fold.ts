import type { Database } from "bun:sqlite";
import { sqliteDb } from "./db/db";
import { loadItem } from "./db/items";

export async function first(db: Database): Promise<string> {
  return await loadItem(sqliteDb(db), "a");
}

export async function second(db: Database): Promise<string> {
  return loadItem(sqliteDb(db), "b");
}
