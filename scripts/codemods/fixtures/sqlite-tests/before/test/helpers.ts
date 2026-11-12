import type { Database } from "bun:sqlite";
import { migrate, openDatabase } from "../db";

export function tempDb(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}
