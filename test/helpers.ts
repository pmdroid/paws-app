import { mkdtempSync } from "node:fs";
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
const warm = openDatabase(join(tempHome(), "paws.db"));
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
