import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { QuestionOption } from "./channel";

export type QuestionKind =
  | "agent"
  | "clarification"
  | "repository"
  | "runner-wait"
  | "closeout-help"
  | "ci-help"
  | "time-limit"
  | "visual-review"
  | "github-auth"
  | "plan-approval";

export type StoredQuestion = {
  id: string;
  itemId: string;
  runId: string | null;
  sessionId: string;
  kind: QuestionKind;
  reason: string;
  body: string;
  context: string | null;
  options: QuestionOption[];
  status: "queued" | "open" | "answered" | "cancelled";
  answer: string | null;
  answeredBy: string | null;
  answerEventKey: string | null;
  createdAt: number;
  answeredAt: number | null;
  cancelledAt: number | null;
};

type QuestionRow = {
  id: string;
  item_id: string;
  run_id: string | null;
  session_id: string;
  kind: QuestionKind;
  reason: string | null;
  body: string;
  context: string | null;
  options: string | null;
  status: "queued" | "open" | "answered";
  answer: string | null;
  answered_by: string | null;
  answer_event_key: string | null;
  created_at: number;
  answered_at: number | null;
  cancelled_at: number | null;
};

export type NewQuestion = {
  itemId: string;
  runId?: string | null;
  sessionId: string;
  body: string;
  reason?: string;
  options?: readonly QuestionOption[];
  now?: number;
};

export function openQuestion(db: Database, input: NewQuestion): StoredQuestion {
  const existing = findOpenQuestion(db, input.sessionId);
  if (existing !== null) {
    throw new Error(`Session ${input.sessionId} already has an unanswered question`);
  }
  return insertQuestion(db, { ...input, kind: "agent", status: "open" });
}

export function insertQuestion(
  db: Database,
  input: NewQuestion & { kind: QuestionKind; status: "queued" | "open"; context?: string },
): StoredQuestion {
  const id = randomUUID();
  const now = input.now ?? Date.now();
  const options = input.options === undefined ? null : JSON.stringify([...input.options]);
  db.run(
    `INSERT INTO question (
       id, item_id, run_id, session_id, kind, reason, body, context, options, status, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.itemId,
      input.runId ?? null,
      input.sessionId,
      input.kind,
      input.reason ?? input.kind,
      input.body,
      input.context ?? null,
      options,
      input.status,
      now,
    ],
  );
  const stored = getQuestion(db, id);
  if (stored === null) throw new Error("insertQuestion did not store a row");
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

/** The question this run still waits on for one kind, open or queued. */
export function findAskedQuestion(
  db: Database,
  runId: string,
  kind: QuestionKind,
): StoredQuestion | null {
  const row = db
    .query<QuestionRow, [string, string]>(
      `SELECT * FROM question
       WHERE run_id = ? AND kind = ? AND status IN ('open', 'queued') AND cancelled_at IS NULL
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
    )
    .get(runId, kind);
  return row === null ? null : mapQuestion(row);
}

export function nextQueuedQuestion(db: Database, sessionId: string): StoredQuestion | null {
  const row = db
    .query<QuestionRow, [string]>(
      `SELECT * FROM question
       WHERE session_id = ? AND status = 'queued' AND cancelled_at IS NULL
       ORDER BY created_at, rowid
       LIMIT 1`,
    )
    .get(sessionId);
  return row === null ? null : mapQuestion(row);
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
    kind: row.kind,
    reason: row.reason ?? row.kind,
    body: row.body,
    context: row.context,
    options: row.options === null ? [] : (JSON.parse(row.options) as QuestionOption[]),
    status: row.cancelled_at === null ? row.status : "cancelled",
    answer: row.answer,
    answeredBy: row.answered_by,
    answerEventKey: row.answer_event_key,
    createdAt: row.created_at,
    answeredAt: row.answered_at,
    cancelledAt: row.cancelled_at,
  };
}
