import { copyFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db";
import type { Database } from "bun:sqlite";

export function tempHome(): string {
  return mkdtempSync(join(tmpdir(), "paws-"));
}

// `synchronous=FULL` fsyncs every commit. The first file database on a cold CI
// disk spent longer than bun's 5s test budget inside the ask test (about two
// dozen fsyncs). Pay that once while this module loads; tests use memory.
const template = join(tempHome(), "paws.db");
const warm = openDatabase(template);
try {
  migrate(warm);
} finally {
  warm.close();
}

export function tempDb(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  return db;
}

// Migrating a new file database commits once per migration, about 0.6 s of
// fsyncs alone and many times that on a loaded disk. A test that needs a file
// starts from a copy of the database migrated above instead.
export function migratedDatabase(path: string): Database {
  copyFileSync(template, path);
  const db = openDatabase(path);
  migrate(db);
  return db;
}
