import type { Database } from "bun:sqlite";

/** Runners upgrade in place with live state, so these statements are the store's only migration. */
export function createCommandStore(db: Database) {
  db.run(
    "CREATE TABLE IF NOT EXISTS command_receipt (id TEXT PRIMARY KEY, expires_at INTEGER NOT NULL) STRICT",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS pending_command (id TEXT PRIMARY KEY REFERENCES command_receipt(id), payload TEXT NOT NULL, acknowledged INTEGER NOT NULL DEFAULT 0 CHECK(acknowledged IN (0,1,2))) STRICT",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS pending_retro_command (id TEXT PRIMARY KEY REFERENCES command_receipt(id), payload TEXT NOT NULL, delivered INTEGER NOT NULL DEFAULT 0 CHECK(delivered IN (0,1))) STRICT",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS retro_attempt (retro_id TEXT PRIMARY KEY, attempt INTEGER NOT NULL) STRICT",
  );
}
