import type { Database } from "bun:sqlite";
import { sqliteDb } from "./db/db";
import { loadItem, loadItemAsync } from "./db/items";

export function first(db: Database): string {
  return loadItem(db, "a");
}

export async function second(db: Database): Promise<string> {
  return loadItemAsync(sqliteDb(db), "b");
}
