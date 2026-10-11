import type { Database } from "bun:sqlite";

export function blockLinearSessionCleanup(db: Database, sessionId: string): void {
  db.run("INSERT OR IGNORE INTO linear_session_cleanup_block(session_id) VALUES (?)", [sessionId]);
}

export function assertLinearSessionCleanup(db: Database, sessionId?: string): void {
  const blocked = sessionId
    ? db.query("SELECT 1 FROM linear_session_cleanup_block WHERE session_id = ?").get(sessionId)
    : db.query("SELECT 1 FROM linear_session_cleanup_block LIMIT 1").get();
  if (blocked) throw new Error("ACP process cleanup could not be verified");
}
