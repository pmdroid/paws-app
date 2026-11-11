import type { Database } from "bun:sqlite";
import {
  activeItemQuestionsSteps,
  amendQuestionRowSteps,
  cancelQueuedQuestionsSteps,
  closeLinkAskSteps,
  dropQuestionElicitationsSteps,
  enqueueOutboxOnceSteps,
  getLinkAskSteps,
  getWorkItemSteps,
  journal,
  latestCloseoutIdentitySteps,
  listCloseoutRecoveriesSteps,
  markQuestionAnsweredSteps,
  promoteQuestionRowSteps,
  setQuestionCancelledSteps,
  settled,
  sqliteDb,
  type Q,
  type Steps,
  type WorkItemRecord,
  type LinkAskKind,
} from "../db";
import type { QuestionOption } from "./channel";
import { addLinkAskUrlSteps, removeLinkAskUrlSteps } from "./link-ask";
import { elicitationBody } from "./note";
import type { VisualReviewShown } from "./visual-review";
import {
  findOpenQuestionSteps,
  getQuestionSteps,
  insertQuestionSteps,
  nextQueuedQuestionSteps,
  questionReplyConsumedSteps,
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

export type AnswerEffects = Partial<
  Record<QuestionKind, (q: Q, question: StoredQuestion) => Steps<void>>
>;

const SUPERSEDES: Record<QuestionKind, "session" | "item" | null> = {
  agent: null,
  clarification: null,
  repository: null,
  "runner-wait": "session",
  "runner-repository": "item",
  "closeout-help": "item",
  "ci-help": "item",
  "time-limit": null,
  "visual-review": null,
  "github-auth": null,
  "plan-approval": null,
  link: null,
  "push-outage": null,
  "policy-outage": null,
};

const ENDED_STATES = new Set(["cancelled", "merged", "failed", "completed"]);

type AskInput = {
  reason?: string;
  options?: readonly QuestionOption[];
  context?: string;
  now?: number;
  amend?: (
    q: Q,
    question: StoredQuestion,
  ) => Steps<{ context: string; options: QuestionOption[] } | null>;
};

export function* askSteps(
  q: Q,
  asker: QuestionAsker,
  kind: QuestionKind,
  body: string,
  input: AskInput = {},
): Steps<Asked> {
  const now = input.now ?? Date.now();
  const waits = (yield* findOpenQuestionSteps(q, asker.sessionId)) !== null;
  const scope = SUPERSEDES[kind];
  if (waits && scope !== null)
    yield* cancelQueuedQuestionsSteps(
      q,
      scope === "item" ? { itemId: asker.itemId } : { sessionId: asker.sessionId },
      kind,
      now,
    );
  const inserted = yield* insertQuestionSteps(q, {
    ...asker,
    kind,
    reason: input.reason ?? kind,
    body,
    ...(input.options === undefined ? {} : { options: input.options }),
    ...(input.context === undefined ? {} : { context: input.context }),
    status: waits ? "queued" : "open",
    now,
  });
  const amended = input.amend ? yield* input.amend(q, inserted) : null;
  if (amended !== null) yield* amendQuestionRowSteps(q, inserted.id, amended);
  const question = amended === null ? inserted : (yield* getQuestionSteps(q, inserted.id))!;
  if (waits) return { status: "queued", question };
  yield* deliverSteps(q, question, now);
  return { status: "asked", question };
}

export function* answerSteps(
  q: Q,
  reply: QuestionReply,
  effects: AnswerEffects = {},
): Steps<AnswerOutcome> {
  if (yield* questionReplyConsumedSteps(q, reply.sessionId, reply.deliveryId))
    return { status: "duplicate" };
  const open = yield* findOpenQuestionSteps(q, reply.sessionId);
  if (open === null) return { status: "unasked" };
  const answered = yield* answerQuestionSteps(q, open.id, {
    answer: reply.body,
    answeredBy: reply.answeredBy,
    eventKey: reply.deliveryId,
    ...(reply.now === undefined ? {} : { now: reply.now }),
  });
  if (answered === null) return { status: "unasked" };
  const effect = effects[answered.kind];
  if (effect) yield* effect(q, answered);
  return {
    status: "answered",
    question: answered,
    next: yield* findOpenQuestionSteps(q, reply.sessionId),
  };
}

type AnswerInput = { answer: string; answeredBy: string; eventKey?: string; now?: number };

export function* answerQuestionSteps(
  q: Q,
  id: string,
  input: AnswerInput,
): Steps<StoredQuestion | null> {
  const now = input.now ?? Date.now();
  const updated = yield* markQuestionAnsweredSteps(q, id, {
    answer: input.answer,
    answeredBy: input.answeredBy,
    answeredAt: now,
    answerEventKey: input.eventKey ?? null,
  });
  if (!updated) return null;
  yield* dropQuestionElicitationsSteps(q, id, "Question already answered.");
  const answered = yield* getQuestionSteps(q, id);
  if (answered !== null) yield* promoteNextSteps(q, answered.sessionId, now);
  return answered;
}

export function* cancelQuestionSteps(q: Q, id: string, now = Date.now()): Steps<void> {
  const question = yield* getQuestionSteps(q, id);
  if (question?.status !== "open" && question?.status !== "queued") return;
  yield* setQuestionCancelledSteps(q, id, now);
  yield* promoteNextSteps(q, question.sessionId, now);
}

// Opaque agent questions and infrastructure/human holds are not known to be obsolete.
const CRITERIA_QUESTIONS: Record<QuestionKind, boolean> = {
  agent: false,
  clarification: false,
  repository: false,
  "runner-wait": false,
  "runner-repository": false,
  "closeout-help": true,
  "ci-help": true,
  "time-limit": false,
  "visual-review": true,
  "github-auth": false,
  "plan-approval": true,
  link: false,
  "push-outage": false,
  "policy-outage": false,
};

const CRITERIA_LINK_ASKS: Record<LinkAskKind, boolean> = {
  bypass: true,
  screenshots: true,
  risk: true,
  question: false,
  rounds: true,
  rule: true,
};

/** The criteria scope retires candidate/plan decisions and preserves unrelated holds. */
export function* cancelItemQuestionsSteps(
  q: Q,
  itemId: string,
  now = Date.now(),
  scope: "all" | "criteria" = "all",
): Steps<void> {
  const questions = [];
  for (const row of yield* activeItemQuestionsSteps(q, itemId)) {
    const question = { ...row, kind: row.kind as QuestionKind };
    if (scope === "all" || CRITERIA_QUESTIONS[question.kind]) {
      questions.push(question);
      continue;
    }
    const link = question.kind === "link" ? yield* getLinkAskSteps(q, question.id) : null;
    if (link !== null && CRITERIA_LINK_ASKS[link.kind]) questions.push(question);
  }
  for (const question of questions) {
    yield* setQuestionCancelledSteps(q, question.id, now);
    yield* dropQuestionElicitationsSteps(q, question.id, "Question cancelled.");
    if (
      question.kind === "link" &&
      (yield* closeLinkAskSteps(q, question.id, { reason: "cancelled", now }))
    )
      yield* removeLinkAskUrlSteps(q, question.id, now);
  }
  for (const sessionId of new Set(questions.map((question) => question.sessionId)))
    yield* promoteNextSteps(q, sessionId, now);
}

function* promoteNextSteps(q: Q, sessionId: string, now: number): Steps<void> {
  if ((yield* findOpenQuestionSteps(q, sessionId)) !== null) return;
  let next = yield* nextQueuedQuestionSteps(q, sessionId);
  while (next !== null) {
    const stale = yield* staleReasonSteps(q, next);
    if (stale === null) {
      yield* promoteQuestionRowSteps(q, next.id, now);
      yield* deliverSteps(q, next, now);
      return;
    }
    yield* setQuestionCancelledSteps(q, next.id, now);
    journal(`question ${next.id} dropped from the queue: ${stale}`);
    next = yield* nextQueuedQuestionSteps(q, sessionId);
  }
}

function* staleReasonSteps(q: Q, question: StoredQuestion): Steps<string | null> {
  const item = yield* getWorkItemSteps(q, question.itemId);
  if (item === null) return "its task is gone";
  if (item.cancelRequested || ENDED_STATES.has(item.state)) return `its task is ${item.state}`;
  if (question.runId !== null && item.currentRunId !== question.runId)
    return "its run is no longer current";
  if (item.sessionKey !== question.sessionId && item.linearIssueId !== question.sessionId)
    return "its session moved";
  if (question.kind === "closeout-help")
    return yield* closeoutCandidateMovedSteps(q, question, item);
  if (question.kind === "link") {
    const head = (yield* getLinkAskSteps(q, question.id))?.headCommit;
    if (head !== undefined && item.checkpoint?.wipCommit && item.checkpoint.wipCommit !== head)
      return "its commit moved";
  }
  return null;
}

function* closeoutCandidateMovedSteps(
  q: Q,
  question: StoredQuestion,
  item: WorkItemRecord,
): Steps<string | null> {
  const recovery = (yield* listCloseoutRecoveriesSteps(q, item.id)).find(
    (entry) => entry.questionId === question.id,
  );
  if (recovery === undefined || recovery.head === "") return null;
  if (item.checkpoint?.wipCommit !== recovery.head) return "its candidate moved";
  const latest = yield* latestCloseoutIdentitySteps(q, item.id);
  if (latest?.head === recovery.head && latest.policyDigest !== recovery.policyDigest)
    return "its Closeout policy changed";
  return null;
}

function* deliverSteps(q: Q, question: StoredQuestion, now: number): Steps<void> {
  if (question.kind === "github-auth") return;
  if (question.kind === "link") yield* addLinkAskUrlSteps(q, question, now);
  yield* enqueueOutboxOnceSteps(q, {
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
