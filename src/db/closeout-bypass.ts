import type { Database } from "bun:sqlite";

/**
 * A failed Closeout check a bypass link ask offers, as Closeout judged it on
 * the asked head. A person who bypasses it on the item page fills in the reason
 * and their name.
 */
export type CloseoutBypassCheck = {
  questionId: string;
  checkId: string;
  kind: string;
  state: string;
  attempt: number | null;
  message: string;
  reason: string | null;
  /** Linear user id of the person who bypassed the check. */
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: number | null;
};

type Row = {
  question_id: string;
  check_id: string;
  kind: string;
  state: string;
  attempt: number | null;
  message: string;
  reason: string | null;
  approved_by: string | null;
  approved_by_name: string | null;
  approved_at: number | null;
};

export function saveCloseoutBypassChecks(
  db: Database,
  questionId: string,
  checks: readonly { id: string; kind: string; state: string; attempt?: number; message: string }[],
): void {
  checks.forEach((check, ordinal) =>
    db.run(
      `INSERT INTO closeout_bypass_check (question_id, check_id, kind, state, attempt, message, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        questionId,
        check.id,
        check.kind,
        check.state,
        check.attempt ?? null,
        check.message,
        ordinal,
      ],
    ),
  );
}

export function listCloseoutBypassChecks(db: Database, questionId: string): CloseoutBypassCheck[] {
  return db
    .query<Row, [string]>(
      "SELECT * FROM closeout_bypass_check WHERE question_id = ? ORDER BY ordinal",
    )
    .all(questionId)
    .map((row) => ({
      questionId: row.question_id,
      checkId: row.check_id,
      kind: row.kind,
      state: row.state,
      attempt: row.attempt,
      message: row.message,
      reason: row.reason,
      approvedBy: row.approved_by,
      approvedByName: row.approved_by_name,
      approvedAt: row.approved_at,
    }));
}

/** Records who bypassed which offered check and why. Returns false when a check was not offered or already decided. */
export function approveCloseoutBypassChecks(
  db: Database,
  questionId: string,
  input: {
    checks: readonly { checkId: string; reason: string }[];
    approvedBy: string;
    approvedByName: string;
    now: number;
  },
): boolean {
  for (const check of input.checks) {
    const updated = db.run(
      `UPDATE closeout_bypass_check SET reason = ?, approved_by = ?, approved_by_name = ?, approved_at = ?
       WHERE question_id = ? AND check_id = ? AND approved_at IS NULL`,
      [check.reason, input.approvedBy, input.approvedByName, input.now, questionId, check.checkId],
    );
    if (updated.changes === 0) return false;
  }
  return true;
}
