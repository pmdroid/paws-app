import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  askedQuestionRow,
  insertQuestionRow,
  nextQueuedQuestionRow,
  openQuestionRow,
  questionEventConsumed,
  questionRow,
  type QuestionRow,
} from "../db";
import type { QuestionOption } from "./channel";

export type QuestionKind =
  | "agent"
  | "clarification"
  | "repository"
  | "runner-wait"
  | "runner-repository"
  | "closeout-help"
  | "ci-help"
  | "time-limit"
  | "visual-review"
  | "github-auth"
  | "plan-approval"
  | "link"
  | "push-outage"
  | "policy-outage";

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
  insertQuestionRow(db, {
    id,
    itemId: input.itemId,
    runId: input.runId ?? null,
    sessionId: input.sessionId,
    kind: input.kind,
    reason: input.reason ?? input.kind,
    body: input.body,
    context: input.context ?? null,
    options: input.options === undefined ? null : [...input.options],
    status: input.status,
    createdAt: now,
  });
  const stored = getQuestion(db, id);
  if (stored === null) throw new Error("insertQuestion did not store a row");
  return stored;
}

export function getQuestion(db: Database, id: string): StoredQuestion | null {
  const row = questionRow(db, id);
  return row === null ? null : mapQuestion(row);
}

/** Latest unanswered question on this Linear agent session. */
export function findOpenQuestion(db: Database, sessionId: string): StoredQuestion | null {
  const row = openQuestionRow(db, sessionId);
  return row === null ? null : mapQuestion(row);
}

/** The question this run still waits on for one kind, open or queued. */
export function findAskedQuestion(
  db: Database,
  runId: string,
  kind: QuestionKind,
): StoredQuestion | null {
  const row = askedQuestionRow(db, runId, kind);
  return row === null ? null : mapQuestion(row);
}

export function nextQueuedQuestion(db: Database, sessionId: string): StoredQuestion | null {
  const row = nextQueuedQuestionRow(db, sessionId);
  return row === null ? null : mapQuestion(row);
}

export function questionReplyConsumed(db: Database, sessionId: string, eventKey: string): boolean {
  return questionEventConsumed(db, sessionId, eventKey);
}

function mapQuestion(row: QuestionRow): StoredQuestion {
  return {
    id: row.id,
    itemId: row.itemId,
    runId: row.runId,
    sessionId: row.sessionId,
    kind: row.kind as QuestionKind,
    reason: row.reason ?? row.kind,
    body: row.body,
    context: row.context,
    options: row.options === null ? [] : (JSON.parse(row.options) as QuestionOption[]),
    status: row.cancelledAt === null ? (row.status as StoredQuestion["status"]) : "cancelled",
    answer: row.answer,
    answeredBy: row.answeredBy,
    answerEventKey: row.answerEventKey,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    cancelledAt: row.cancelledAt,
  };
}
