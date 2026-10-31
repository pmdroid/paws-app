import type { Database } from "bun:sqlite";

/**
 * Responses that may follow the PR response: the final merged, closed or stopped line, a
 * comment-only GitHub review's threads, posted once per review id, and what a person decided on
 * the risk approval. A response keeps the session complete, so neither reopens it.
 */
export const AFTER_PULL_REQUEST_RESPONSE =
  /^(merged:|closed:|command:stop:|pull-review:|risk-approval:)/;

/**
 * Thoughts that may follow the PR response: a change request on the risk approval, from the
 * Risk card or a Linear reply, and a review or comments on the pull request that sent the item
 * back to the agent (`pull-feedback:`). Each wakes the session, so a person sees the agent work.
 */
export const AFTER_PULL_REQUEST_THOUGHT = /^(risk-approval:|pull-feedback:)/;

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
  return (
    db
      .query(`SELECT 1 FROM outbox WHERE target='linear' AND ordering_key=?
    AND delivery_generation=? AND (idempotency_key LIKE 'pull-request-ready:%' OR idempotency_key LIKE 'merged:%' OR idempotency_key LIKE 'closed:%')
    AND status!='dropped' AND (? IS NULL OR id < ? OR status='sent') LIMIT 1`)
      .get(sessionId, generation, rowId ?? null, rowId ?? null) === null
  );
}
