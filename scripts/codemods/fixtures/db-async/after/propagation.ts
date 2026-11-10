import type { Database } from "bun:sqlite";
import { saveItem } from "./db/items";
import { sqliteDb } from "./db/db";

async function store(db: Database, name: string): Promise<void> {
  await saveItem(sqliteDb(db), name);
}

export async function storeTwice(db: Database): Promise<void> {
  await store(db, "a");
  await store(db, "b");
}
