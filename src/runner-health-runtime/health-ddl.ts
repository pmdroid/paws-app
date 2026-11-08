import type { Database } from "bun:sqlite";

/** Runners upgrade in place with live state, so these statements are the store's only migration. */
export function createHealthStore(db: Database) {
  db.run(
    "CREATE TABLE IF NOT EXISTS health_execution(id TEXT PRIMARY KEY,command_id TEXT UNIQUE NOT NULL,payload TEXT NOT NULL,phase TEXT NOT NULL) STRICT",
  );
  if (
    !db
      .query<{ name: string }, []>("PRAGMA table_info(health_execution)")
      .all()
      .some((row) => row.name === "result")
  )
    db.run("ALTER TABLE health_execution ADD COLUMN result TEXT");
}
