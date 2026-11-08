import type { Database } from "bun:sqlite";

export function ddl(db: Database): void {
  db.run(
    "CREATE TABLE IF NOT EXISTS execution (id TEXT PRIMARY KEY, command_id TEXT UNIQUE NOT NULL, payload TEXT NOT NULL, phase TEXT NOT NULL, consumed INTEGER NOT NULL DEFAULT 0, prefix_hash TEXT NOT NULL DEFAULT '', answer_cursor INTEGER NOT NULL DEFAULT 0) STRICT",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS delivery (execution_id TEXT NOT NULL REFERENCES execution(id), sequence INTEGER NOT NULL, payload TEXT NOT NULL, request_id TEXT, sent INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(execution_id,sequence)) STRICT",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS result_delivery (execution_id TEXT PRIMARY KEY REFERENCES execution(id), payload TEXT NOT NULL, failure INTEGER NOT NULL, accepted INTEGER NOT NULL DEFAULT 0) STRICT",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS publication (execution_id TEXT PRIMARY KEY REFERENCES execution(id), payload TEXT NOT NULL, lease TEXT, published_sha TEXT, refused TEXT) STRICT",
  );
  const columns = new Set(
    db
      .query<{ name: string }, []>("PRAGMA table_info(execution)")
      .all()
      .map((column) => column.name),
  );
  if (!columns.has("transcript_offset"))
    db.run("ALTER TABLE execution ADD COLUMN transcript_offset INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("session_offset"))
    db.run("ALTER TABLE execution ADD COLUMN session_offset INTEGER NOT NULL DEFAULT 0");
  if (!columns.has("session_state"))
    db.run("ALTER TABLE execution ADD COLUMN session_state TEXT NOT NULL DEFAULT ''");
  if (!columns.has("transcript_sealed"))
    db.run("ALTER TABLE execution ADD COLUMN transcript_sealed INTEGER NOT NULL DEFAULT 0");
  if (
    !db
      .query<{ name: string }, []>("PRAGMA table_info(result_delivery)")
      .all()
      .some((column) => column.name === "refused")
  )
    db.run("ALTER TABLE result_delivery ADD COLUMN refused TEXT");
  db.run(
    "CREATE INDEX IF NOT EXISTS delivery_waiting ON delivery(execution_id,sequence) WHERE json_extract(payload,'$.type') IN ('question','artifact','closeout_policy')",
  );
  db.run(`CREATE TABLE IF NOT EXISTS termination (
    command_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, generation INTEGER NOT NULL,
    reported INTEGER NOT NULL DEFAULT 0) STRICT`);
  db.run("CREATE INDEX IF NOT EXISTS termination_generation ON termination(run_id,generation)");
  db.run(`CREATE TABLE IF NOT EXISTS cleanup (
    execution_id TEXT PRIMARY KEY REFERENCES execution(id), started_at INTEGER NOT NULL,
    failures INTEGER NOT NULL DEFAULT 0, failure TEXT, failed_at INTEGER) STRICT`);
}
