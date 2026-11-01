import type { Database } from "bun:sqlite";
import type { WorkItemRecord } from "./items";

/** Delivery metadata for the human hold; work_item.state owns the item's lifecycle. */
export type HeldRestartDecision = { jobKey: string; questionId: string | null };

export function heldRestartDecision(
  db: Database,
  item: WorkItemRecord,
): HeldRestartDecision | null {
  return db
    .query<HeldRestartDecision, [string, string | null]>(
      "SELECT job_key AS jobKey, question_id AS questionId FROM restart_decision WHERE item_id=? AND session_id=?",
    )
    .get(item.id, item.sessionKey);
}

/** An uncarried answer remains the decision even while another question waits. */
export function restartDecisionQuestion(
  db: Database,
  item: WorkItemRecord,
): {
  id: string;
  status: "open" | "queued" | "answered";
} | null {
  return db
    .query<
      { id: string; status: "open" | "queued" | "answered" },
      [string, string | null, string | null, string | null]
    >(`
    SELECT q.id,q.status FROM question q
    WHERE q.item_id=?1 AND q.session_id=?2 AND q.reason='restart' AND q.cancelled_at IS NULL
      AND (q.run_id IS NULL OR q.run_id=?3)
      AND (q.status IN ('open','queued') OR (q.status='answered' AND q.handoff_version IS NULL))
    ORDER BY CASE WHEN q.id=?4 AND q.status='answered' THEN 0
      WHEN q.status='open' THEN 1 WHEN q.status='answered' THEN 2 ELSE 3 END,
      q.created_at DESC,q.id DESC LIMIT 1
  `)
    .get(
      item.id,
      item.sessionKey,
      item.currentRunId,
      heldRestartDecision(db, item)?.questionId ?? null,
    );
}

export function rememberRestartDecision(db: Database, item: WorkItemRecord): HeldRestartDecision {
  db.run("DELETE FROM restart_decision WHERE item_id=? AND session_id<>?", [
    item.id,
    item.sessionKey,
  ]);
  db.run("INSERT OR IGNORE INTO restart_decision(item_id,session_id,job_key) VALUES (?,?,?)", [
    item.id,
    item.sessionKey,
    `restart-ask:${item.id}:${item.version}`,
  ]);
  return heldRestartDecision(db, item)!;
}

export function bindRestartDecisionQuestion(
  db: Database,
  item: WorkItemRecord,
  questionId: string,
): void {
  if (rememberRestartDecision(db, item).questionId === questionId) return;
  db.run("UPDATE restart_decision SET question_id=? WHERE item_id=? AND session_id=?", [
    questionId,
    item.id,
    item.sessionKey,
  ]);
}

/** Shared by answer effects and restart admission, including legacy run_id=NULL questions. */
export function restartAnswerAuthorized(
  db: Database,
  item: WorkItemRecord,
  questionId?: string,
): boolean {
  const held = heldRestartDecision(db, item);
  const question = restartDecisionQuestion(db, item);
  return (
    !item.cancelRequested &&
    held !== null &&
    question?.status === "answered" &&
    question.id === held.questionId &&
    (questionId === undefined || question.id === questionId)
  );
}
