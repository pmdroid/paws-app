import type { Database } from "bun:sqlite";
import {
  enqueueOutboxOnce,
  getLinkAsk,
  insertLinkAsk,
  type LinkAsk,
  type LinkAskDecision,
  type LinkAskKind,
  type LinkAskRounds,
} from "../db";
import { ask as askQuestion, type QuestionAsker } from "./lifecycle";
import type { StoredQuestion } from "./store";

/** The button on the overview's Needs you list and the session link label. */
export const LINK_ASK_ACTIONS: Record<LinkAskKind, string> = {
  bypass: "Review bypass",
  screenshots: "Review screenshots",
  preview: "Review in Paws",
  risk: "Review risk",
  question: "Answer question",
  rounds: "Answer question",
  rule: "Review rule",
};

/** The card on the item page each kind opens: `/status/issues/PAS-633#closeout`. */
export const LINK_ASK_ANCHORS: Record<LinkAskKind, string> = {
  bypass: "closeout",
  screenshots: "visual-review",
  preview: "live-preview",
  risk: "risk",
  question: "question",
  rounds: "review-rounds",
  rule: "rule",
};

/** The last line of the Linear message: what a reply does, and what it never does. */
export const LINK_ASK_REPLY: Record<LinkAskKind, string> = {
  preview: "Reply here to request changes. A Linear reply cannot accept a live preview.",
  bypass: "Reply here to send the agent guidance instead. A reply here cannot bypass a check.",
  screenshots:
    "Reply here to send the agent the changes you want instead. A reply here cannot approve the screens.",
  risk: "Reply here to send the agent guidance instead. A reply here cannot approve the risk.",
  question:
    "Reply here to send the agent guidance instead. A reply here does not answer the question.",
  rounds:
    "A reply here asks the agent to rethink the approach, with your reply as the note and the open findings.",
  rule: "Reply here to send the finding back to the agent instead. A reply here cannot approve the break.",
};

/** Paws reminds once after this long without a decision. There is no timeout. */
export const LINK_ASK_REMINDER_MS = 24 * 60 * 60 * 1000;

export function linkAskTitle(kind: LinkAskKind, head: string): string {
  const commit = shortCommit(head);
  switch (kind) {
    case "bypass":
      return `Closeout needs your decision on ${commit}.`;
    case "preview":
      return `Try the live preview of ${commit} and accept it in Paws.`;
    case "screenshots":
      return `The screens of ${commit} need your visual review.`;
    case "risk":
      return `High-risk changes in ${commit} need your approval.`;
    case "question":
      return `Paws needs your answer on ${commit}.`;
    case "rounds":
      return `Review rounds ran out on ${commit}.`;
    case "rule":
      return `A rule broke on ${commit} and needs your decision.`;
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
    input.kind === "preview" ? `[Review in Paws](${input.link})` : `Decide in Paws: ${input.link}`,
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
  if (decision === "changes")
    return ask.kind === "rule"
      ? `sent the rule finding on ${commit} back to the agent in Paws`
      : `requested changes to ${commit} in Paws`;
  if (decision === "rethink") return "asked the agent to rethink the approach in Paws";
  if (decision === "continue") return `allowed ${moreRounds(ask)} in Paws`;
  if (decision === "stop") return `stopped the work at ${commit} in Paws`;
  return {
    bypass: `bypassed the failed checks on ${commit} in Paws`,
    screenshots: `accepted the screens of ${commit} in Paws`,
    preview: `accepted the live preview of ${commit} in Paws`,
    risk: `approved the high-risk changes in ${commit} in Paws`,
    question: "answered in Paws",
    rounds: "answered in Paws",
    rule: `approved the rule break on ${commit} in Paws`,
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

/** "4 more review rounds", or "more review rounds" when the policy limit is unknown. */
function moreRounds(ask: LinkAsk): string {
  const limit = ask.rounds?.limit ?? null;
  return limit === null ? "more review rounds" : `${limit} more review rounds`;
}

/** The handoff the agent gets when a decision or a guidance reply sends the item back. */
export function linkAskHandoff(
  ask: LinkAsk,
  input: {
    decision: LinkAskDecision | "guidance";
    note: string | null;
    /** On a `rule` ask: the rule findings the agent fixes, as `onFail: fix` would hand them over. */
    findings?: string;
  },
): string {
  const note = input.note?.trim() ?? "";
  // A reply in Linear on a rounds ask is Rethink the approach with the reply as the note.
  if (ask.kind === "rounds") return roundsHandoff(ask, input.decision, note);
  const lead =
    input.decision === "guidance"
      ? `A person replied in Linear while Paws waited for a decision on ${shortCommit(ask.headCommit)} (${LINK_ASK_ACTIONS[ask.kind].toLowerCase()}). The reply is guidance and approves nothing:`
      : input.decision === "answer"
        ? `A person answered in Paws: ${ask.title}`
        : `A person ${decided(ask, input.decision)}${note ? ":" : "."}`;
  const findings = input.findings?.trim() ?? "";
  return [
    "Handoff from the previous session.",
    lead,
    ...(note ? [note] : []),
    ...(findings
      ? [
          "The rule below is set to onFail: approve, and nobody approved the break. Fix the finding:",
          findings,
        ]
      : []),
  ].join("\n");
}

function roundsHandoff(ask: LinkAsk, decision: LinkAskDecision | "guidance", note: string): string {
  const count = ask.rounds?.rounds.length ?? 0;
  const lead =
    decision === "continue"
      ? `The independent review failed ${count} rounds in a row. A person allowed ${moreRounds(ask)}: fix the open findings.`
      : `The independent review failed ${count} rounds in a row and the fixes kept missing. A person asked you to rethink the approach: step back from patching each finding, find what the findings have in common${ask.rounds?.bugClass ? ` (most are ${ask.rounds.bugClass})` : ""}, and change the design so that class of bug cannot occur.`;
  return [
    "Handoff from the previous session.",
    lead,
    ...(note ? [`Note from the person: ${note}`] : []),
    ...(ask.rounds?.handoff ? [ask.rounds.handoff] : []),
  ].join("\n");
}

/** The detail of a rounds ask: how many rounds failed and the class of bug that keeps coming back. */
export function reviewRoundsDetail(rounds: LinkAskRounds): string {
  const count = rounds.rounds.length;
  const open = rounds.open.length;
  const recurring =
    rounds.bugClass === null
      ? ""
      : ` The class of bug that keeps coming back is "${rounds.bugClass}"${
          open > 0
            ? ` (${rounds.open.filter((finding) => finding.bugClass === rounds.bugClass).length} of ${open} open findings)`
            : ""
        }.`;
  return `The independent review failed ${count} ${count === 1 ? "round" : "rounds"} and ${open} ${open === 1 ? "finding is" : "findings are"} still open.${recurring} Rethink the approach, keep going, or stop.`;
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
    rounds?: LinkAskRounds;
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
    ...(input.rounds === undefined ? {} : { rounds: input.rounds }),
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
