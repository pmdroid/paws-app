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
  /** The agent's request to skip exhausted checks, shown in the recovery comment. */
  skipRequest: SkipRequest | null;
  answer: string | null;
  answeredBy: string | null;
};

export type SkipRequest = { checks: string[]; reason: string };

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
  skip_checks: string | null;
  skip_reason: string | null;
  answer: string | null;
  answered_by: string | null;
};

export function saveCloseoutRecovery(
  db: Database,
  input: Omit<CloseoutRecovery, "answer" | "answeredBy">,
): void {
  db.run(
    `INSERT INTO closeout_recovery (question_id, task_id, item_id, base, head, policy_digest, failed_checks, retry_baseline, summary, skip_checks, skip_reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      input.skipRequest ? JSON.stringify(input.skipRequest.checks) : null,
      input.skipRequest?.reason ?? null,
    ],
  );
}

export function listCloseoutRecoveries(db: Database, itemId: string): CloseoutRecovery[] {
  return db
    .query<RecoveryRow, [string]>(
      `SELECT r.*, q.answer, q.answered_by FROM closeout_recovery r JOIN question q ON q.id = r.question_id WHERE r.item_id = ? ORDER BY q.created_at, q.rowid`,
    )
    .all(itemId)
    .map(fromRow);
}

export function getCloseoutRecovery(db: Database, questionId: string): CloseoutRecovery | null {
  const row = db
    .query<RecoveryRow, [string]>(
      `SELECT r.*, q.answer, q.answered_by FROM closeout_recovery r JOIN question q ON q.id = r.question_id WHERE r.question_id = ?`,
    )
    .get(questionId);
  return row ? fromRow(row) : null;
}

function fromRow(row: RecoveryRow): CloseoutRecovery {
  return {
    questionId: row.question_id,
    taskId: row.task_id,
    itemId: row.item_id,
    base: row.base,
    head: row.head,
    policyDigest: row.policy_digest,
    failedChecks: JSON.parse(row.failed_checks) as string[],
    retryBaseline: JSON.parse(row.retry_baseline) as string[],
    summary: row.summary,
    skipRequest:
      row.skip_checks !== null && row.skip_reason !== null
        ? { checks: JSON.parse(row.skip_checks) as string[], reason: row.skip_reason }
        : null,
    answer: row.answer,
    answeredBy: row.answered_by,
  };
}
