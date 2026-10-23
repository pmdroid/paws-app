import type { Database } from "bun:sqlite";

export type IntakeQueueEntry = {
  sessionId: string | null;
  issue: string;
  title: string | null;
  receivedAt: number;
  attempts: number;
  nextAttemptAt: number | null;
  lastError: string | null;
};

export function listIntakeQueue(db: Database): IntakeQueueEntry[] {
  return db
    .query<IntakeQueueEntry, []>(
      `SELECT e.session_id AS sessionId,
              COALESCE(json_extract(e.payload, '$.agentSession.issue.identifier'),
                       json_extract(e.payload, '$.identifier'),
                       w.linear_identifier, e.issue_id, e.session_id, e.dedupe_key) AS issue,
              COALESCE(json_extract(e.payload, '$.agentSession.issue.title'), w.title) AS title,
              e.received_at AS receivedAt, e.attempts, e.next_attempt_at AS nextAttemptAt,
              e.last_error AS lastError
       FROM inbox_event e
       LEFT JOIN work_item w ON w.id = (
         SELECT id FROM work_item
         WHERE session_key = e.session_id OR linear_issue_id = e.issue_id
         ORDER BY created_at DESC LIMIT 1)
       WHERE e.handled = 0 AND e.action IN ('created', 'prompted')
         AND (e.signal IS NULL OR e.signal <> 'stop')
       ORDER BY e.received_at, e.dedupe_key`,
    )
    .all();
}
