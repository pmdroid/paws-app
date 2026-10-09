import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";

export type StoredQuestion = {
  id: string;
  itemId: string;
  runId: string | null;
  sessionId: string;
  body: string;
  options: string[];
  status: "open" | "answered";
  answer: string | null;
  answeredBy: string | null;
  createdAt: number;
  answeredAt: number | null;
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
};

export function openQuestion(
  db: Database,
  input: {
    itemId: string;
    runId?: string | null;
    sessionId: string;
    body: string;
    options?: readonly string[];
    now?: number;
  },
): StoredQuestion {
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
       WHERE session_id = ? AND status = 'open'
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
  input: { answer: string; answeredBy: string; now?: number },
): StoredQuestion | null {
  const now = input.now ?? Date.now();
  const updated = db.run(
    `UPDATE question
     SET status = 'answered', answer = ?, answered_by = ?, answered_at = ?
     WHERE id = ? AND status = 'open'`,
    [input.answer, input.answeredBy, now, id],
  );
  if (updated.changes === 0) return null;
  return getQuestion(db, id);
}

function mapQuestion(row: QuestionRow): StoredQuestion {
  return {
    id: row.id,
    itemId: row.item_id,
    runId: row.run_id,
    sessionId: row.session_id,
    body: row.body,
    options: row.options === null ? [] : (JSON.parse(row.options) as string[]),
    status: row.status,
    answer: row.answer,
    answeredBy: row.answered_by,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
  };
}
