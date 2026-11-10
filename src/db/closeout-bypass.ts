import type { Database } from "bun:sqlite";
import { and, asc, eq, isNull } from "drizzle-orm";
import type { Q, Steps } from "./db";

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

export function* listCloseoutBypassChecksSteps(
  q: Q,
  questionId: string,
): Steps<CloseoutBypassCheck[]> {
  const { closeoutBypassCheck: check } = q.t;
  const rows = yield* q.all(
    q.orm.select().from(check).where(eq(check.questionId, questionId)).orderBy(asc(check.ordinal)),
  );
  return rows.map((row) => ({
    questionId: row.questionId,
    checkId: row.checkId,
    kind: row.kind,
    state: row.state,
    attempt: row.attempt,
    message: row.message,
    reason: row.reason,
    approvedBy: row.approvedBy,
    approvedByName: row.approvedByName,
    approvedAt: row.approvedAt,
  }));
}

/** Records who bypassed which offered check and why. Returns false when a check was not offered or already decided. */
export function* approveCloseoutBypassChecksSteps(
  q: Q,
  questionId: string,
  input: {
    checks: readonly { checkId: string; reason: string }[];
    approvedBy: string;
    approvedByName: string;
    now: number;
  },
): Steps<boolean> {
  const { closeoutBypassCheck: table } = q.t;
  for (const check of input.checks) {
    const updated = yield* q.all(
      q.orm
        .update(table)
        .set({
          reason: check.reason,
          approvedBy: input.approvedBy,
          approvedByName: input.approvedByName,
          approvedAt: input.now,
        })
        .where(
          and(
            eq(table.questionId, questionId),
            eq(table.checkId, check.checkId),
            isNull(table.approvedAt),
          ),
        )
        .returning({ checkId: table.checkId }),
    );
    if (updated.length === 0) return false;
  }
  return true;
}

/** The synchronous `approveCloseoutBypassChecksSteps`, for callers that are not async yet. */
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
