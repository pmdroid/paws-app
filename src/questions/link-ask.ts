import type { Database } from "bun:sqlite";
import {
  enqueueOutboxOnce,
  getLinkAsk,
  insertLinkAsk,
  type LinkAsk,
  type LinkAskDecision,
  type LinkAskKind,
} from "../db";
import { ask as askQuestion, type QuestionAsker } from "./lifecycle";
import type { StoredQuestion } from "./store";

/** The button on the overview's Needs you list and the session link label. */
export const LINK_ASK_ACTIONS: Record<LinkAskKind, string> = {
  bypass: "Review bypass",
  screenshots: "Review screenshots",
  risk: "Review risk",
  question: "Answer question",
};

/** The card on the item page each kind opens: `/status/issues/PAS-633#closeout`. */
export const LINK_ASK_ANCHORS: Record<LinkAskKind, string> = {
  bypass: "closeout",
  screenshots: "visual-review",
  risk: "risk",
  question: "question",
};

/** The last line of the Linear message: what a reply does, and what it never does. */
export const LINK_ASK_REPLY: Record<LinkAskKind, string> = {
  bypass: "Reply here to send the agent guidance instead. A reply here cannot bypass a check.",
  screenshots:
    "Reply here to send the agent the changes you want instead. A reply here cannot approve the screens.",
  risk: "Reply here to send the agent guidance instead. A reply here cannot approve the risk.",
  question:
    "Reply here to send the agent guidance instead. A reply here does not answer the question.",
};

/** Paws reminds once after this long without a decision. There is no timeout. */
export const LINK_ASK_REMINDER_MS = 24 * 60 * 60 * 1000;

export function linkAskTitle(kind: LinkAskKind, head: string): string {
  const commit = shortCommit(head);
  switch (kind) {
    case "bypass":
      return `Closeout needs your decision on ${commit}.`;
    case "screenshots":
      return `The screens of ${commit} need your visual review.`;
    case "risk":
      return `High-risk changes in ${commit} need your approval.`;
    case "question":
      return `Paws needs your answer on ${commit}.`;
  }
}

/** The Markdown of the one elicitation: what needs a decision, the commit, and the link. */
export function linkAskBody(input: {
  kind: LinkAskKind;
  title: string;
  detail: string;
  link: string;
}): string {
  return [
    `**${input.title}**${input.detail.trim() ? `\n${input.detail.trim()}` : ""}`,
    `Decide in Paws: ${input.link}`,
    LINK_ASK_REPLY[input.kind],
  ].join("\n\n");
}

export function linkAskReminderBody(ask: LinkAsk): string {
  return [
    `**Still waiting for your decision on ${shortCommit(ask.headCommit)}.**`,
    `Decide in Paws: ${ask.link}`,
    LINK_ASK_REPLY[ask.kind],
  ].join("\n\n");
}

/** What the person did, after their name: "approved the high-risk changes in 7f65200 in Paws". */
function decided(ask: LinkAsk, decision: LinkAskDecision): string {
  const commit = shortCommit(ask.headCommit);
  if (decision === "answer") return "answered in Paws";
  if (decision === "changes") return `requested changes to ${commit} in Paws`;
  return {
    bypass: `bypassed the failed checks on ${commit} in Paws`,
    screenshots: `accepted the screens of ${commit} in Paws`,
    risk: `approved the high-risk changes in ${commit} in Paws`,
    question: "answered in Paws",
  }[ask.kind];
}

/** The note Paws posts once a person decided on the item page. */
export function linkAskDecidedNote(
  ask: LinkAsk,
  decision: LinkAskDecision,
  by: string,
  note: string | null,
): string {
  const what = `${by} ${decided(ask, decision)}`;
  return note ? `${what}: ${note}` : `${what}.`;
}

/** The handoff the agent gets when a decision or a guidance reply sends the item back. */
export function linkAskHandoff(
  ask: LinkAsk,
  input: { decision: LinkAskDecision | "guidance"; note: string | null },
): string {
  const note = input.note?.trim() ?? "";
  const lead =
    input.decision === "guidance"
      ? `A person replied in Linear while Paws waited for a decision on ${shortCommit(ask.headCommit)} (${LINK_ASK_ACTIONS[ask.kind].toLowerCase()}). The reply is guidance and approves nothing:`
      : input.decision === "answer"
        ? `A person answered in Paws: ${ask.title}`
        : `A person ${decided(ask, input.decision)}${note ? ":" : "."}`;
  return ["Handoff from the previous session.", lead, ...(note ? [note] : [])].join("\n");
}

export function shortCommit(head: string): string {
  return head.slice(0, 7);
}

/**
 * Opens one link ask: an elicitation with a Markdown body and no options, bound
 * to `head`, answered on the item page by one of `answerers`. Call inside a transaction.
 */
export function openLinkAsk(
  db: Database,
  input: {
    ask?: typeof askQuestion;
    asker: QuestionAsker;
    kind: LinkAskKind;
    head: string;
    link: string;
    title?: string;
    detail: string;
    answerers: readonly string[];
    now: number;
  },
): { question: StoredQuestion; linkAsk: LinkAsk } {
  const title = input.title ?? linkAskTitle(input.kind, input.head);
  const { question } = (input.ask ?? askQuestion)(
    db,
    input.asker,
    "link",
    linkAskBody({ kind: input.kind, title, detail: input.detail, link: input.link }),
    {
      reason: `link:${input.kind}`,
      context: JSON.stringify({ link: input.link, label: LINK_ASK_ACTIONS[input.kind] }),
      now: input.now,
    },
  );
  const linkAsk = insertLinkAsk(db, {
    questionId: question.id,
    itemId: input.asker.itemId,
    kind: input.kind,
    headCommit: input.head,
    link: input.link,
    title,
    detail: input.detail,
    answerers: [...new Set(input.answerers.filter((id) => id.trim() !== ""))],
    createdAt: input.now,
  });
  return { question, linkAsk };
}

/** Adds the ask's link to the session while it is open. */
export function addLinkAskUrl(db: Database, question: StoredQuestion, now: number): void {
  const shown = linkAskShown(question);
  if (shown === null) return;
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "linear.session.links",
    orderingKey: question.sessionId,
    priority: 5,
    idempotencyKey: `link-ask-url:${question.id}`,
    payload: { sessionId: question.sessionId, addedExternalUrls: [shown] },
    now,
  });
}

/** Takes the link off the session once the ask closed. */
export function removeLinkAskUrl(db: Database, questionId: string, now: number): void {
  const ask = getLinkAsk(db, questionId);
  const sessionId = db
    .query<{ sessionId: string }, [string]>(
      "SELECT session_id AS sessionId FROM question WHERE id = ?",
    )
    .get(questionId)?.sessionId;
  if (ask === null || sessionId === undefined) return;
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "linear.session.links",
    orderingKey: sessionId,
    priority: 5,
    idempotencyKey: `link-ask-url-removed:${questionId}`,
    payload: { sessionId, removedExternalUrls: [ask.link] },
    now,
  });
}

function linkAskShown(question: StoredQuestion): { label: string; url: string } | null {
  // Paws writes this context itself in openLinkAsk.
  const context = JSON.parse(question.context ?? "{}") as { link?: unknown; label?: unknown };
  return typeof context.link === "string" && typeof context.label === "string"
    ? { label: context.label, url: context.link }
    : null;
}
