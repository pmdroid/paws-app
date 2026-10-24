import type { Database } from "bun:sqlite";

export function getLinearConversationSource(db: Database, sessionId: string): string | null {
  for (const [table, filter, order] of [
    ["inbox_event", "AND action = 'created'", "received_at"],
    ["linear_turn", "", "ordinal"],
  ] as const) {
    if (!hasTable(db, table)) continue;
    const row = db
      .query<{ url: string }, [string]>(`SELECT CASE WHEN json_valid(payload) THEN
      COALESCE(json_extract(payload, '$.agentSession.url'), json_extract(payload, '$.agentSession.issue.url'))
      ELSE NULL END AS url FROM ${table} WHERE session_id = ? ${filter}
      AND typeof(url) = 'text' AND length(url) > 0 ORDER BY ${order} LIMIT 1`)
      .get(sessionId);
    if (row) return row.url;
  }
  return null;
}

function hasTable(db: Database, name: string): boolean {
  return (
    db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== null
  );
}
