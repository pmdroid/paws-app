import { ask, restart } from "./operations";
import type { Database } from "bun:sqlite";
import { JOB_KIND } from "../core";
import {
  applyLinearTurns,
  auditWorkspaceAccess,
  closeLinkAsk,
  delegatedLinearUserId,
  enqueueJobOnce,
  enqueueOutboxOnce,
  getLinkAsk,
  getWorkItem,
  immediate,
  openLinkAsks,
  recordLinkAskDecision,
  type LinkAsk,
  type LinkAskDecision,
  type LinkAskKind,
  type WorkItemRecord,
} from "../db";
import {
  answerQuestion,
  canAnswer,
  cancelQuestion,
  getQuestion,
  LINK_ASK_ANCHORS,
  LINK_ASK_REMINDER_MS,
  linkAskDecidedNote,
  linkAskHandoff,
  linkAskReminderBody,
  openLinkAsk,
  removeLinkAskUrl,
  shortCommit,
  type StoredQuestion,
} from "../questions";
import { projectLeadId } from "../scheduler";
import { postNote } from "./visual-review";

/** A Paws that only listens on localhost has no link a person can open, so it cannot ask this way. */
export const LINK_ASK_NEEDS_PUBLIC_URL =
  "Asking with a link needs a dashboard link a person can open. Set PAWS_PUBLIC_URL.";

export const LINK_ASK_GUIDANCE_NOTE =
  "Sent your reply to the agent as guidance. A reply in Linear decides nothing; Paws asks again on the next commit.";

const ENDED = new Set(["cancelled", "merged", "failed", "completed"]);

/** Whether this Paws can hand out a link the delegator can open. */
export function linkAskAvailable(publicUrl: string | null | undefined): publicUrl is string {
  return typeof publicUrl === "string" && publicUrl.startsWith("https://");
}

/** `https://paws.example/status/issues/PAS-633#closeout` */
export function linkAskUrl(publicUrl: string, item: WorkItemRecord, kind: LinkAskKind): string {
  const issue = encodeURIComponent(item.linearIdentifier ?? item.id);
  return `${publicUrl.replace(/\/+$/, "")}/status/issues/${issue}#${LINK_ASK_ANCHORS[kind]}`;
}

/**
 * Asks the delegator or the project lead for a decision on the item page:
 * one elicitation with a Markdown body and no options, the link on the
 * session, and one reminder after 24 hours. `pending` asks while the item
 * keeps verifying, as a pending-human check does.
 */
export function askWithLink(
  db: Database,
  input: {
    item: WorkItemRecord;
    runId: string | null;
    kind: LinkAskKind;
    head: string;
    title?: string;
    detail: string;
    publicUrl: string | null;
    now: number;
    pending?: boolean;
  },
): { question: StoredQuestion; linkAsk: LinkAsk } {
  if (!linkAskAvailable(input.publicUrl)) throw new Error(LINK_ASK_NEEDS_PUBLIC_URL);
  const { item } = input;
  if (item.sessionKey === null) throw new Error("Question owner is stale");
  const answerers = [delegatedLinearUserId(db, item.id), projectLeadId(db, item.id)].filter(
    (id): id is string => id !== null,
  );
  return immediate(db, () => {
    const opened = openLinkAsk(db, {
      ask: (store, asker, ...rest) =>
        ask(store, { ...asker, ...(input.pending ? { pending: true } : {}) }, ...rest),
      asker: { itemId: item.id, runId: input.runId, sessionId: item.sessionKey! },
      kind: input.kind,
      head: input.head,
      link: linkAskUrl(input.publicUrl!, item, input.kind),
      ...(input.title === undefined ? {} : { title: input.title }),
      detail: input.detail,
      answerers,
      now: input.now,
    });
    enqueueJobOnce(db, {
      queue: JOB_KIND.linkAskReminder,
      jobKey: `link-ask-reminder:${opened.question.id}`,
      payload: { questionId: opened.question.id },
      runAt: input.now + LINK_ASK_REMINDER_MS,
      now: input.now,
    });
    return opened;
  });
}

/** Posts the one reminder while the ask is still open. Returns whether it posted. */
export function remindLinkAsk(db: Database, questionId: string, now: number): boolean {
  return immediate(db, () => {
    const question = getQuestion(db, questionId);
    const linkAsk = getLinkAsk(db, questionId);
    if (question?.status !== "open" || linkAsk === null || linkAsk.closedAt !== null) return false;
    const item = getWorkItem(db, question.itemId);
    if (item === null || item.cancelRequested || ENDED.has(item.state)) return false;
    const before = db
      .query<{ id: number }, [string]>("SELECT id FROM outbox WHERE idempotency_key = ?")
      .get(`link-ask-reminder:${questionId}`);
    if (before !== null) return false;
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: question.sessionId,
      idempotencyKey: `link-ask-reminder:${questionId}`,
      payload: {
        id: crypto.randomUUID(),
        sessionId: question.sessionId,
        questionId,
        body: linkAskReminderBody(linkAsk),
        options: [],
      },
      now,
    });
    return true;
  });
}

/**
 * What an `approve` does for one kind, inside the decision's transaction.
 * Returns false to fall back to handing the decision to the agent.
 */
export type LinkAskEffects = Partial<
  Record<LinkAskKind, (linkAsk: LinkAsk, item: WorkItemRecord, now: number) => boolean>
>;

/**
 * A signed-in person decided on the item page. Checks `canAnswer` against the
 * delegator and the project lead, writes the Audit history row, closes the
 * ask, posts what was decided, and hands the item on.
 */
export function decideLinkAsk(
  db: Database,
  input: {
    questionId: string;
    decision: LinkAskDecision;
    note: string | null;
    answeredBy: string;
    actor: { workspaceId: string; userId: string; name: string };
    now: number;
  },
  effects: LinkAskEffects = {},
): "answered" | "forbidden" | "rejected" {
  return immediate(db, () => {
    const { now } = input;
    const linkAsk = getLinkAsk(db, input.questionId);
    const question = getQuestion(db, input.questionId);
    if (linkAsk === null || linkAsk.closedAt !== null || question?.status !== "open")
      return "rejected";
    const item = getWorkItem(db, linkAsk.itemId);
    if (item === null || item.cancelRequested || ENDED.has(item.state)) return "rejected";
    if (!canAnswer({ kind: "link", allowedIds: linkAsk.answerers }, { id: input.answeredBy }))
      return "forbidden";
    if ((input.decision === "answer") !== (linkAsk.kind === "question")) return "rejected";
    if (input.decision !== "approve" && !input.note) return "rejected";
    const answered = answerQuestion(db, question.id, {
      answer: input.note ? `${input.decision}: ${input.note}` : input.decision,
      answeredBy: input.answeredBy,
      eventKey: `dashboard:${crypto.randomUUID()}`,
      now,
    });
    if (answered === null) return "rejected";
    recordLinkAskDecision(db, linkAsk.questionId, {
      decision: input.decision,
      note: input.note,
      decidedBy: input.answeredBy,
      now,
    });
    auditWorkspaceAccess(db, {
      workspaceId: input.actor.workspaceId,
      userId: input.actor.userId,
      action: `decision.${linkAsk.kind}.${input.decision}`,
      subject: [
        item.linearIdentifier ?? item.id,
        shortCommit(linkAsk.headCommit),
        ...(input.note ? [input.note] : []),
      ].join(" · "),
      now,
    });
    removeLinkAskUrl(db, linkAsk.questionId, now);
    postNote(
      db,
      question.sessionId,
      item,
      linkAskDecidedNote(linkAsk, input.decision, input.actor.name, input.note),
      `link-ask-decided:${linkAsk.questionId}`,
      now,
    );
    const current = getWorkItem(db, item.id)!;
    if (input.decision === "approve" && effects[linkAsk.kind]?.(linkAsk, current, now))
      return "answered";
    handBack(db, current, question, linkAskHandoff(linkAsk, input), now);
    return "answered";
  });
}

/**
 * A reply in Linear while a link ask is open. It is guidance for the agent and
 * never approves, bypasses or answers the ask, whatever it says: the ask
 * closes undecided and the item goes back to the agent with the reply.
 */
export function guideLinkAsk(
  db: Database,
  input: { questionId: string; eventKey: string; body: string; answeredBy: string; now: number },
): boolean {
  return immediate(db, () => {
    const { now } = input;
    const linkAsk = getLinkAsk(db, input.questionId);
    const question = getQuestion(db, input.questionId);
    if (linkAsk === null || linkAsk.closedAt !== null || question?.status !== "open") return false;
    const item = getWorkItem(db, linkAsk.itemId);
    if (item === null || item.cancelRequested || ENDED.has(item.state)) return false;
    const answered = answerQuestion(db, question.id, {
      answer: `guidance: ${input.body}`,
      answeredBy: input.answeredBy,
      eventKey: input.eventKey,
      now,
    });
    if (answered === null) return false;
    closeLinkAsk(db, linkAsk.questionId, {
      reason: "guidance",
      note: input.body,
      by: input.answeredBy,
      now,
    });
    removeLinkAskUrl(db, linkAsk.questionId, now);
    if (item.sessionKey === question.sessionId)
      applyLinearTurns(db, question.sessionId, [input.eventKey], item.id);
    postNote(
      db,
      question.sessionId,
      item,
      LINK_ASK_GUIDANCE_NOTE,
      `link-ask-guidance:${linkAsk.questionId}`,
      now,
    );
    handBack(
      db,
      getWorkItem(db, item.id)!,
      question,
      linkAskHandoff(linkAsk, { decision: "guidance", note: input.body }),
      now,
    );
    return true;
  });
}

/**
 * Head `head` is the item's candidate now. Every open link ask bound to
 * another commit closes undecided; the next one is asked about `head`.
 * Returns how many closed.
 */
export function closeLinkAsksOnHead(
  db: Database,
  itemId: string,
  head: string,
  now: number,
): number {
  return immediate(db, () => {
    const moved = openLinkAsks(db, itemId).filter((entry) => entry.headCommit !== head);
    const item = getWorkItem(db, itemId);
    for (const linkAsk of moved) {
      closeLinkAsk(db, linkAsk.questionId, { reason: "head_moved", now });
      const question = getQuestion(db, linkAsk.questionId);
      if (question?.status === "open" || question?.status === "queued")
        cancelQuestion(db, linkAsk.questionId, now);
      removeLinkAskUrl(db, linkAsk.questionId, now);
      if (item !== null && question !== null && question.status === "open")
        postNote(
          db,
          question.sessionId,
          item,
          `The decision on ${shortCommit(linkAsk.headCommit)} is closed: the branch moved to ${shortCommit(head)}.`,
          `link-ask-moved:${linkAsk.questionId}`,
          now,
        );
    }
    return moved.length;
  });
}

function handBack(
  db: Database,
  item: WorkItemRecord,
  question: StoredQuestion,
  body: string,
  now: number,
): void {
  const jobId = restart(db, item, {
    reason: "answer",
    body,
    jobKey: `resume:link-ask:${question.id}`,
    now,
  });
  if (jobId !== null)
    db.run("UPDATE question SET handoff_version = ? WHERE id = ?", [
      getWorkItem(db, item.id)!.version,
      question.id,
    ]);
}
