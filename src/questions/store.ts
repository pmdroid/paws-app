import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { QuestionOption } from "./channel";

export type StoredQuestion = {
  id: string;
  itemId: string;
  runId: string | null;
  sessionId: string;
  body: string;
  options: QuestionOption[];
  status: "open" | "answered" | "cancelled";
  answer: string | null;
  answeredBy: string | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
};

type QuestionRow = {
  id: string;
  item_id: string;
  run_id: string | null;
  session_id: string;
  body: string;
  options: string | null;
  status: "open" | "answered";
  answer: string | null;
  answered_by: string | null;
  created_at: number;
  answered_at: number | null;
  cancelled_at: number | null;
};

export function openQuestion(
  db: Database,
  input: {
    itemId: string;
    runId?: string | null;
    sessionId: string;
    body: string;
    options?: readonly QuestionOption[];
    now?: number;
  },
): StoredQuestion {
  const existing = findOpenQuestion(db, input.sessionId);
  if (existing !== null) {
    throw new Error(`Session ${input.sessionId} already has an unanswered question`);
  }
  const id = randomUUID();
  const now = input.now ?? Date.now();
  const options = input.options === undefined ? null : JSON.stringify([...input.options]);
  db.run(
    `INSERT INTO question (
       id, item_id, run_id, session_id, body, options, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, 'open', ?)`,
    [id, input.itemId, input.runId ?? null, input.sessionId, input.body, options, now],
  );
  const stored = getQuestion(db, id);
  if (stored === null) throw new Error("openQuestion did not store a row");
  return stored;
}

export function getQuestion(db: Database, id: string): StoredQuestion | null {
  const row = db.query<QuestionRow, [string]>("SELECT * FROM question WHERE id = ?").get(id);
  return row === null ? null : mapQuestion(row);
}

/** Latest unanswered question on this Linear agent session. */
export function findOpenQuestion(db: Database, sessionId: string): StoredQuestion | null {
  const row = db
    .query<QuestionRow, [string]>(
      `SELECT * FROM question
       WHERE session_id = ? AND status = 'open' AND cancelled_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(sessionId);
  return row === null ? null : mapQuestion(row);
}

/** Mark the open question answered. A second delivery does not overwrite it. */
export function answerQuestion(
  db: Database,
  id: string,
  input: { answer: string; answeredBy: string; eventKey?: string; now?: number },
): StoredQuestion | null {
  return db
    .transaction(() => {
      const now = input.now ?? Date.now();
      const updated = db.run(
        `UPDATE question
       SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?, answer_event_key = ?
       WHERE id = ? AND status = 'open' AND cancelled_at IS NULL`,
        [input.answer, input.answeredBy, now, input.eventKey ?? null, id],
      );
      if (updated.changes === 0) return null;
      db.run(
        `UPDATE outbox SET status = 'dropped', error = 'Question already answered.'
       WHERE target = 'linear' AND op = 'elicitation' AND status IN ('pending', 'dead')
         AND json_extract(payload, '$.questionId') = ?`,
        [id],
      );
      return getQuestion(db, id);
    })
    .immediate();
}

export function questionReplyConsumed(db: Database, sessionId: string, eventKey: string): boolean {
  return (
    db
      .query<{ id: string }, [string, string]>(
        "SELECT id FROM question WHERE session_id = ? AND answer_event_key = ?",
      )
      .get(sessionId, eventKey) !== null
  );
}

function mapQuestion(row: QuestionRow): StoredQuestion {
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    sessionId: row.session_id,
    body: row.body,
    options: row.options === null ? [] : (JSON.parse(row.options) as QuestionOption[]),
    status: row.cancelled_at === null ? row.status : "cancelled",
    answer: row.answer,
    answeredBy: row.answered_by,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    cancelledAt: row.cancelled_at,
  };
}
