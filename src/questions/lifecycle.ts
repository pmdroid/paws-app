import type { Database } from "bun:sqlite";
import {
  enqueueOutboxOnce,
  getLinkAsk,
  getWorkItem,
  immediate,
  journal,
  latestCloseoutIdentity,
  listCloseoutRecoveries,
  type WorkItemRecord,
} from "../db";
import type { QuestionOption } from "./channel";
import { addLinkAskUrl } from "./link-ask";
import { elicitationBody } from "./note";
import type { VisualReviewShown } from "./visual-review";
import {
  findOpenQuestion,
  getQuestion,
  insertQuestion,
  nextQueuedQuestion,
  questionReplyConsumed,
  type QuestionKind,
  type StoredQuestion,
} from "./store";

export type QuestionAsker = {
  itemId: string;
  runId: string | null;
  sessionId: string;
  version?: number;
};

export type Asked = { status: "asked" | "queued"; question: StoredQuestion };

export type QuestionReply = {
  sessionId: string;
  deliveryId: string;
  body: string;
  answeredBy: string;
  now?: number;
};

export type AnswerOutcome =
  | { status: "answered"; question: StoredQuestion; next: StoredQuestion | null }
  | { status: "duplicate" }
  | { status: "unasked" };

export type AnswerEffects = Partial<Record<QuestionKind, (question: StoredQuestion) => void>>;

const SUPERSEDES: Record<QuestionKind, "session" | "item" | null> = {
  agent: null,
  clarification: null,
  repository: null,
  "runner-wait": "session",
  "closeout-help": "item",
  "ci-help": "item",
  "time-limit": null,
  "visual-review": null,
  "github-auth": null,
  "plan-approval": null,
  link: null,
};

const ENDED_STATES = new Set(["cancelled", "merged", "failed", "completed"]);

export function ask(
  db: Database,
  asker: QuestionAsker,
  kind: QuestionKind,
  body: string,
  input: {
    reason?: string;
    options?: readonly QuestionOption[];
    context?: string;
    now?: number;
    amend?: (question: StoredQuestion) => { context: string; options: QuestionOption[] } | null;
  } = {},
): Asked {
  return immediate(db, () => {
    const now = input.now ?? Date.now();
    const waits = findOpenQuestion(db, asker.sessionId) !== null;
    const scope = SUPERSEDES[kind];
    if (waits && scope !== null)
      db.run(
        `UPDATE question SET cancelled_at = ?
         WHERE ${scope === "item" ? "item_id" : "session_id"} = ? AND kind = ?
           AND status = 'queued' AND cancelled_at IS NULL`,
        [now, scope === "item" ? asker.itemId : asker.sessionId, kind],
      );
    const inserted = insertQuestion(db, {
      ...asker,
      kind,
      reason: input.reason ?? kind,
      body,
      ...(input.options === undefined ? {} : { options: input.options }),
      ...(input.context === undefined ? {} : { context: input.context }),
      status: waits ? "queued" : "open",
      now,
    });
    const amended = input.amend?.(inserted) ?? null;
    if (amended !== null)
      db.run("UPDATE question SET context = ?, options = ? WHERE id = ?", [
        amended.context,
        JSON.stringify(amended.options),
        inserted.id,
      ]);
    const question = amended === null ? inserted : getQuestion(db, inserted.id)!;
    if (waits) return { status: "queued", question };
    deliver(db, question, now);
    return { status: "asked", question };
  });
}

export function answer(
  db: Database,
  reply: QuestionReply,
  effects: AnswerEffects = {},
): AnswerOutcome {
  return immediate(db, () => {
    if (questionReplyConsumed(db, reply.sessionId, reply.deliveryId))
      return { status: "duplicate" };
    const open = findOpenQuestion(db, reply.sessionId);
    if (open === null) return { status: "unasked" };
    const answered = answerQuestion(db, open.id, {
      answer: reply.body,
      answeredBy: reply.answeredBy,
      eventKey: reply.deliveryId,
      ...(reply.now === undefined ? {} : { now: reply.now }),
    });
    if (answered === null) return { status: "unasked" };
    effects[answered.kind]?.(answered);
    return { status: "answered", question: answered, next: findOpenQuestion(db, reply.sessionId) };
  });
}

/** Mark the open question answered. A second delivery does not overwrite it. */
export function answerQuestion(
  db: Database,
  id: string,
  input: { answer: string; answeredBy: string; eventKey?: string; now?: number },
): StoredQuestion | null {
  return immediate(db, () => {
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
    const answered = getQuestion(db, id);
    if (answered !== null) promoteNext(db, answered.sessionId, now);
    return answered;
  });
}

export function cancelQuestion(db: Database, id: string, now = Date.now()): void {
  immediate(db, () => {
    const question = getQuestion(db, id);
    if (question?.status !== "open" && question?.status !== "queued") return;
    db.run("UPDATE question SET cancelled_at = ? WHERE id = ?", [now, id]);
    promoteNext(db, question.sessionId, now);
  });
}

export function cancelItemQuestions(db: Database, itemId: string, now = Date.now()): void {
  immediate(db, () => {
    const sessions = db
      .query<{ sessionId: string }, [string]>(
        `SELECT DISTINCT session_id AS sessionId FROM question
         WHERE item_id = ? AND status IN ('open', 'queued') AND cancelled_at IS NULL`,
      )
      .all(itemId);
    db.run(
      `UPDATE question SET cancelled_at = ?
       WHERE item_id = ? AND status IN ('open', 'queued') AND cancelled_at IS NULL`,
      [now, itemId],
    );
    for (const { sessionId } of sessions) promoteNext(db, sessionId, now);
  });
}

function promoteNext(db: Database, sessionId: string, now: number): void {
  if (findOpenQuestion(db, sessionId) !== null) return;
  let next = nextQueuedQuestion(db, sessionId);
  while (next !== null) {
    const stale = staleReason(db, next);
    if (stale === null) {
      db.run("UPDATE question SET status = 'open', created_at = ? WHERE id = ?", [now, next.id]);
      deliver(db, next, now);
      return;
    }
    db.run("UPDATE question SET cancelled_at = ? WHERE id = ?", [now, next.id]);
    journal(`question ${next.id} dropped from the queue: ${stale}`);
    next = nextQueuedQuestion(db, sessionId);
  }
}

function staleReason(db: Database, question: StoredQuestion): string | null {
  const item = getWorkItem(db, question.itemId);
  if (item === null) return "its task is gone";
  if (item.cancelRequested || ENDED_STATES.has(item.state)) return `its task is ${item.state}`;
  if (question.runId !== null && item.currentRunId !== question.runId)
    return "its run is no longer current";
  if (item.sessionKey !== question.sessionId && item.linearIssueId !== question.sessionId)
    return "its session moved";
  if (question.kind === "closeout-help") return closeoutCandidateMoved(db, question, item);
  if (question.kind === "link") {
    const head = getLinkAsk(db, question.id)?.headCommit;
    if (head !== undefined && item.checkpoint?.wipCommit && item.checkpoint.wipCommit !== head)
      return "its commit moved";
  }
  return null;
}

function closeoutCandidateMoved(
  db: Database,
  question: StoredQuestion,
  item: WorkItemRecord,
): string | null {
  const recovery = listCloseoutRecoveries(db, item.id).find(
    (entry) => entry.questionId === question.id,
  );
  if (recovery === undefined || recovery.head === "") return null;
  if (item.checkpoint?.wipCommit !== recovery.head) return "its candidate moved";
  const latest = latestCloseoutIdentity(db, item.id);
  if (latest?.head === recovery.head && latest.policyDigest !== recovery.policyDigest)
    return "its Closeout policy changed";
  return null;
}

function deliver(db: Database, question: StoredQuestion, now: number): void {
  if (question.kind === "github-auth") return;
  if (question.kind === "link") addLinkAskUrl(db, question, now);
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "elicitation",
    orderingKey: question.sessionId,
    idempotencyKey: `question:${question.id}`,
    payload: {
      id: question.id,
      sessionId: question.sessionId,
      questionId: question.id,
      options: question.options,
      ...(question.kind === "visual-review"
        ? { body: question.body, ...(JSON.parse(question.context ?? "{}") as VisualReviewShown) }
        : question.kind === "link"
          ? // The Markdown body carries the link; the context only feeds the session link.
            { body: question.body }
          : {
              body: elicitationBody(question.body, question.context ?? undefined, question.options),
            }),
    },
    now,
  });
}
