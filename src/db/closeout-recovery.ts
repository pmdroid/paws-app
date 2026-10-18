import type { Database } from "bun:sqlite";

export type CloseoutRecovery = {
  questionId: string;
  taskId: string;
  itemId: string;
  base: string;
  head: string;
  policyDigest: string;
  failedChecks: string[];
  retryBaseline: string[];
  summary: string;
  /** The agent's request to skip exhausted checks, shown in the recovery question. */
  skip: CloseoutSkip | null;
  answer: string | null;
  answeredBy: string | null;
};

export type CloseoutSkip = {
  checkIds: string[];
  reason: string;
  evidence: { label: string; url: string }[];
};

/** Saved by the agent's `request_closeout_skip` until Paws opens the recovery question. */
export type CloseoutSkipRequest = {
  itemId: string;
  checkIds: string[];
  reason: string;
  requestedAt: number;
};

type RecoveryRow = {
  question_id: string;
  task_id: string;
  item_id: string;
  base: string;
  head: string;
  policy_digest: string;
  failed_checks: string;
  retry_baseline: string;
  summary: string;
  skip: string | null;
  answer: string | null;
  answered_by: string | null;
};

export function saveCloseoutRecovery(
  db: Database,
  input: Omit<CloseoutRecovery, "answer" | "answeredBy">,
): void {
  db.run(
    `INSERT INTO closeout_recovery (question_id, task_id, item_id, base, head, policy_digest, failed_checks, retry_baseline, summary, skip) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      input.questionId,
      input.taskId,
      input.itemId,
      input.base,
      input.head,
      input.policyDigest,
      JSON.stringify(input.failedChecks),
      JSON.stringify(input.retryBaseline),
      input.summary,
      input.skip === null ? null : JSON.stringify(input.skip),
    ],
  );
}

export function listCloseoutRecoveries(db: Database, itemId: string): CloseoutRecovery[] {
  return db
    .query<RecoveryRow, [string]>(
      `SELECT r.*, q.answer, q.answered_by FROM closeout_recovery r JOIN question q ON q.id = r.question_id WHERE r.item_id = ? ORDER BY q.created_at, q.rowid`,
    )
    .all(itemId)
    .map((row) => ({
      questionId: row.question_id,
      taskId: row.task_id,
      itemId: row.item_id,
      base: row.base,
      head: row.head,
      policyDigest: row.policy_digest,
      failedChecks: JSON.parse(row.failed_checks) as string[],
      retryBaseline: JSON.parse(row.retry_baseline) as string[],
      summary: row.summary,
      skip: row.skip === null ? null : (JSON.parse(row.skip) as CloseoutSkip),
      answer: row.answer,
      answeredBy: row.answered_by,
    }));
}

/** Replaces the item's pending skip request. Each exhausted gate gets one. */
export function saveCloseoutSkipRequest(db: Database, input: CloseoutSkipRequest): void {
  db.run(
    `INSERT INTO closeout_skip_request (item_id, check_ids, reason, requested_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (item_id) DO UPDATE SET check_ids = excluded.check_ids, reason = excluded.reason, requested_at = excluded.requested_at`,
    [input.itemId, JSON.stringify(input.checkIds), input.reason, input.requestedAt],
  );
}

/** Removes and returns the pending skip request. */
export function takeCloseoutSkipRequest(db: Database, itemId: string): CloseoutSkipRequest | null {
  const row = db
    .query<{ check_ids: string; reason: string; requested_at: number }, [string]>(
      `DELETE FROM closeout_skip_request WHERE item_id = ? RETURNING check_ids, reason, requested_at`,
    )
    .get(itemId);
  if (row === null) return null;
  return {
    itemId,
    checkIds: JSON.parse(row.check_ids) as string[],
    reason: row.reason,
    requestedAt: row.requested_at,
  };
}

/** The Linear comment that carries a question in comment mode. */
export function saveQuestionComment(db: Database, questionId: string, commentId: string): void {
  db.run(
    `INSERT INTO question_comment (question_id, comment_id) VALUES (?, ?)
     ON CONFLICT (question_id) DO UPDATE SET comment_id = excluded.comment_id`,
    [questionId, commentId],
  );
}

export function getQuestionComment(db: Database, questionId: string): string | null {
  return (
    db
      .query<{ comment_id: string }, [string]>(
        `SELECT comment_id FROM question_comment WHERE question_id = ?`,
      )
      .get(questionId)?.comment_id ?? null
  );
}
