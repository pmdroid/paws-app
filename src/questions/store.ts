import { randomUUID } from "node:crypto";
import {
  askedQuestionRowSteps,
  insertQuestionRowSteps,
  nextQueuedQuestionRowSteps,
  openQuestionRowSteps,
  questionEventConsumedSteps,
  questionRowByIdSteps,
  type Q,
  type QuestionRow,
  type Steps,
  type Db,
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

export function* openQuestionSteps(q: Q, input: NewQuestion): Steps<StoredQuestion> {
  const existing = yield* findOpenQuestionSteps(q, input.sessionId);
  if (existing !== null) {
    throw new Error(`Session ${input.sessionId} already has an unanswered question`);
  }
  return yield* insertQuestionSteps(q, { ...input, kind: "agent", status: "open" });
}

export function openQuestion(store: Db, input: NewQuestion): Promise<StoredQuestion> {
  return store.run((q) => openQuestionSteps(q, input));
}

type QuestionInsert = NewQuestion & {
  kind: QuestionKind;
  status: "queued" | "open";
  context?: string;
};

export function* insertQuestionSteps(q: Q, input: QuestionInsert): Steps<StoredQuestion> {
  const id = randomUUID();
  const now = input.now ?? Date.now();
  yield* insertQuestionRowSteps(q, {
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
  const stored = yield* getQuestionSteps(q, id);
  if (stored === null) throw new Error("insertQuestion did not store a row");
  return stored;
}

export function* getQuestionSteps(q: Q, id: string): Steps<StoredQuestion | null> {
  const row = yield* questionRowByIdSteps(q, id);
  return row === null ? null : mapQuestion(row);
}

export async function getQuestion(store: Db, id: string): Promise<StoredQuestion | null> {
  return store.run((q) => getQuestionSteps(q, id));
}

export function* findOpenQuestionSteps(q: Q, sessionId: string): Steps<StoredQuestion | null> {
  const row = yield* openQuestionRowSteps(q, sessionId);
  return row === null ? null : mapQuestion(row);
}

/** Latest unanswered question on this Linear agent session. */
export function findOpenQuestion(store: Db, sessionId: string): Promise<StoredQuestion | null> {
  return store.run((q) => findOpenQuestionSteps(q, sessionId));
}

/** The question this run still waits on for one kind, open or queued. */
export function* findAskedQuestionSteps(
  q: Q,
  runId: string,
  kind: QuestionKind,
): Steps<StoredQuestion | null> {
  const row = yield* askedQuestionRowSteps(q, runId, kind);
  return row === null ? null : mapQuestion(row);
}

export function* nextQueuedQuestionSteps(q: Q, sessionId: string): Steps<StoredQuestion | null> {
  const row = yield* nextQueuedQuestionRowSteps(q, sessionId);
  return row === null ? null : mapQuestion(row);
}

export function* questionReplyConsumedSteps(q: Q, sessionId: string, eventKey: string) {
  return yield* questionEventConsumedSteps(q, sessionId, eventKey);
}

function mapQuestion(row: QuestionRow): StoredQuestion {
  const kind = row.kind as QuestionKind;
  return {
    id: row.id,
    itemId: row.itemId,
    runId: row.runId,
    sessionId: row.sessionId,
    kind,
    reason: row.reason ?? kind,
    body: row.body,
    context: row.context,
    options: row.options === null ? [] : (JSON.parse(row.options) as QuestionOption[]),
    status: row.cancelledAt === null ? (row.status as "queued" | "open" | "answered") : "cancelled",
    answer: row.answer,
    answeredBy: row.answeredBy,
    answerEventKey: row.answerEventKey,
    createdAt: row.createdAt,
    answeredAt: row.answeredAt,
    cancelledAt: row.cancelledAt,
  };
}
