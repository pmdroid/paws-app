import type { Database } from "bun:sqlite";

export function linearSessionsForIssueContext(db: Database, issueId: string): string[] {
  return db
    .query<{ session_id: string }, [string, string]>(
      `SELECT session_id FROM linear_session WHERE issue_id = ?
    UNION SELECT t.session_id FROM linear_session_task t JOIN work_item w ON w.epic_id = t.epic_id WHERE w.linear_issue_id = ?`,
    )
    .all(issueId, issueId)
    .map((row) => row.session_id);
}

export function saveLinearIssueContext(
  db: Database,
  input: {
    sessionId: string;
    issueId: string;
    observedAt: number;
    context: string;
  },
): void {
  db.run(
    `INSERT INTO linear_issue_context (session_id,issue_id,observed_at,context) VALUES (?,?,?,?)
    ON CONFLICT(session_id,issue_id) DO UPDATE SET observed_at = excluded.observed_at,context = excluded.context
    WHERE excluded.observed_at >= linear_issue_context.observed_at`,
    [input.sessionId, input.issueId, input.observedAt, input.context],
  );
}

export function getLinearIssueContext(db: Database, sessionId: string): string {
  return db
    .query<{ context: string }, [string]>(
      "SELECT context FROM linear_issue_context WHERE session_id = ? ORDER BY issue_id",
    )
    .all(sessionId)
    .map((row) => row.context)
    .join("\n\n");
}
