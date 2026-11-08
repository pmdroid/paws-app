import type { Database } from "bun:sqlite";

/** Runners upgrade in place with live state, so this statement is the store's only migration. */
export function createRetroStore(db: Database) {
  db.run(
    `CREATE TABLE IF NOT EXISTS retro_execution(id TEXT PRIMARY KEY, command_id TEXT UNIQUE NOT NULL,
     payload TEXT NOT NULL, phase TEXT NOT NULL CHECK(phase IN
     ('preparing','running','reporting','releasing','complete')), result TEXT, started_at INTEGER) STRICT`,
  );
}
