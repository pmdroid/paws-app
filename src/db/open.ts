import { Database } from "bun:sqlite";

/** One connection. The process that calls this is the only writer. */
export function openDatabase(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA synchronous = FULL");
  db.run("PRAGMA foreign_keys = ON");
  db.run("PRAGMA busy_timeout = 5000");
  db.run("PRAGMA temp_store = MEMORY");
  return db;
}
