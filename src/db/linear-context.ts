import { getLinearIssueContext } from "./linear-issue-context";
import type { Database } from "bun:sqlite";

export function saveLinearSessionContext(
  db: Database,
  sessionId: string,
  context: string,
  richness = 1,
): void {
  if (!context) return;
  db.run(
    `INSERT INTO linear_session_context (session_id, context, richness) VALUES (?, ?, ?)
     ON CONFLICT (session_id) DO UPDATE SET context = excluded.context, richness = excluded.richness WHERE excluded.richness > linear_session_context.richness`,
    [sessionId, context, richness],
  );
}

export function getLinearSessionContext(db: Database, sessionId: string): string {
  const row = db
    .query<{ context: string; snapshot_context: string | null }, [string]>(
      "SELECT context, snapshot_context FROM linear_session_context WHERE session_id = ?",
    )
    .get(sessionId);
  return [row?.context, row?.snapshot_context, getLinearIssueContext(db, sessionId)]
    .filter(Boolean)
    .join("\n\n");
}

export function hasLinearSessionSnapshotContext(db: Database, sessionId: string): boolean {
  return (
    db
      .query<{ hydrated: number }, [string]>(
        "SELECT snapshot_context IS NOT NULL AS hydrated FROM linear_session_context WHERE session_id = ?",
      )
      .get(sessionId)?.hydrated === 1
  );
}

export function saveLinearSessionSnapshotContext(
  db: Database,
  sessionId: string,
  context: string,
): void {
  db.run(
    `INSERT INTO linear_session_context (session_id, context, richness, snapshot_context) VALUES (?, '', -1, ?)
    ON CONFLICT (session_id) DO UPDATE SET snapshot_context = COALESCE(linear_session_context.snapshot_context, excluded.snapshot_context)`,
    [sessionId, context],
  );
}

export function saveLinearActivitySnapshot(
  db: Database,
  input: { id: string; sessionId: string; createdAt: string; snapshot: string },
): void {
  db.run(
    "INSERT INTO linear_activity_snapshot (id, session_id, created_at, snapshot) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO NOTHING",
    [input.id, input.sessionId, input.createdAt, input.snapshot],
  );
}

export function listLinearActivitySnapshots(db: Database, sessionId: string): readonly string[] {
  return db
    .query<{ snapshot: string }, [string]>(
      "SELECT snapshot FROM linear_activity_snapshot WHERE session_id = ? ORDER BY created_at, id",
    )
    .all(sessionId)
    .map((row) => row.snapshot);
}
