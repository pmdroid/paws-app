import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db";
import type { Database } from "bun:sqlite";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "paws-"));
}

export function tempDb(): Database {
  const db = openDatabase(join(tempHome(), "paws.db"));
  migrate(db);
  return db;
}
