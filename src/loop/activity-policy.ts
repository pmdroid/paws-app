import type { Database } from "bun:sqlite";

/** The PR response completes this generation; only a terminal response or ask may follow. */
export function hasPublishedPullRequest(
  db: Database,
  sessionId: string,
  generation: number,
): boolean {
  return (
    db
      .query(`SELECT 1 FROM outbox WHERE target='linear' AND ordering_key=?
    AND delivery_generation=? AND idempotency_key LIKE 'pull-request-ready:%'
    AND status!='dropped' LIMIT 1`)
      .get(sessionId, generation) !== null
  );
}

export function canReportProgress(
  db: Database,
  sessionId: string,
  generation: number,
  rowId?: number,
): boolean {
  if (rowId === undefined) return !hasPublishedPullRequest(db, sessionId, generation);
  return (
    db
      .query(`SELECT 1 FROM outbox WHERE target='linear' AND ordering_key=?
    AND delivery_generation=? AND idempotency_key LIKE 'pull-request-ready:%'
    AND status!='dropped' AND id < ? LIMIT 1`)
      .get(sessionId, generation, rowId) === null
  );
}
