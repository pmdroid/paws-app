import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { JOB_KIND, riskLine } from "../core";
import {
  applyLinearCommand,
  applyWorkItemEvent,
  enqueueJobOnce,
  enqueueOutboxOnce,
  getCandidateRisk,
  getWorkItem,
  listLinkAsks,
  openLinkAsks,
  saveCheckpoint,
  type CandidateRisk,
  type LinkAsk,
  type WorkItemRecord,
} from "../db";
import type { RiskApproval } from "../merge";
import { shortCommit } from "../questions";
import { askWithLink, closeLinkAsksOnHead, linkAskAvailable } from "./link-ask";

/** Why Settings › Merging shows the risk gate as off on a Paws without an https dashboard link. */
export const RISK_GATE_NEEDS_PUBLIC_URL =
  "The risk gate is off: a high-risk pull request is approved on the issue page in Paws, so it needs a dashboard link a person can open. Set PAWS_PUBLIC_URL to an https address. Until then high-risk pull requests merge like any other.";

/** What Paws posts when a Linear reply on the risk approval became a change request. */
export const RISK_REPLY_NOTE =
  "Sent your reply to the agent as the changes you want. A reply in Linear never approves high-risk changes; approve them in Paws.";

/** Why a Linear reply from someone else does not request changes on the risk approval. */
export const RISK_ANSWERERS =
  "Only the person who delegated this issue or the Linear project's lead can answer this risk approval. The task keeps waiting.";

/** Whether the risk gate is on: only a Paws with an https dashboard link can ask for the approval. */
export function riskGateOn(publicUrl: string | null | undefined): boolean {
  return linkAskAvailable(publicUrl);
}

/**
 * Whether head S may merge as far as its risk goes. A normal-tier head, or any head on a Paws
 * whose risk gate is off, needs nothing. A high-risk or unclassified head needs a person's
 * approval of S in Paws, or of an earlier head with the same patch against main (`samePatch`),
 * as after a rebase. A Linear reply never approves, so only `approve` decisions count.
 */
export async function riskApprovalFor(
  db: Database,
  input: {
    itemId: string;
    head: string;
    publicUrl: string | null | undefined;
    /** Whether `approved` carries the same patch as S against `base`. */
    samePatch: (approved: string, base: string) => Promise<boolean>;
  },
): Promise<RiskApproval> {
  if (!riskGateOn(input.publicUrl)) return "not_required";
  const risk = getCandidateRisk(db, input.itemId, input.head);
  if (risk?.tier === "normal") return "not_required";
  const approvals = riskApprovals(db, input.itemId);
  if (approvals.some((ask) => ask.headCommit === input.head)) return "approved";
  if (risk === null) return "missing";
  for (const ask of approvals.toReversed())
    if (await input.samePatch(ask.headCommit, risk.base)) return "approved";
  return "missing";
}

/** Risk link asks a signed-in person approved on the item page, oldest first. */
export function riskApprovals(db: Database, itemId: string): LinkAsk[] {
  return listLinkAsks(db, itemId).filter(
    (ask) => ask.kind === "risk" && ask.decision === "approve" && ask.decidedBy !== null,
  );
}

/** The open risk ask of the item, if any. */
export function openRiskAsk(db: Database, itemId: string): LinkAsk | null {
  return openLinkAsks(db, itemId).find((ask) => ask.kind === "risk") ?? null;
}

/** "High-risk paths changed: `src/auth/session.ts`." for Linear and the Risk card. */
export function riskAskDetail(risk: CandidateRisk | null): string {
  const line = riskLine(risk);
  return risk === null
    ? `${line}. Approve only after you checked what it changes.`
    : `High-risk paths changed: ${line.replace(/^Risk: high — /, "")}.`;
}

/**
 * Holds high-risk head S out of the merge queue and asks the delegator or the project lead to
 * approve it on the item page: one elicitation with a Markdown body and no options, the link on
 * the session while it is open, and one reminder after 24 hours. Asks bound to other heads close.
 */
export function askRiskApproval(
  db: Database,
  input: { item: WorkItemRecord; head: string; publicUrl: string | null; now: number },
): "asked" | "unavailable" {
  const item = getWorkItem(db, input.item.id);
  if (item === null || item.cancelRequested || item.state !== "merge_queue") return "unavailable";
  if (!riskGateOn(input.publicUrl) || item.sessionKey === null) return "unavailable";
  closeLinkAsksOnHead(db, item.id, input.head, input.now);
  if (openRiskAsk(db, item.id) !== null) return "asked";
  askWithLink(db, {
    item,
    runId: item.currentRunId,
    kind: "risk",
    head: input.head,
    detail: riskAskDetail(getCandidateRisk(db, item.id, input.head)),
    publicUrl: input.publicUrl,
    now: input.now,
  });
  return "asked";
}

/**
 * A person approved S on the item page: the item verifies S again from Closeout's recorded
 * results and, once accepted, joins the merge queue, where `mergeable(S)` finds the approval.
 */
export function approveRisk(
  db: Database,
  linkAsk: LinkAsk,
  item: WorkItemRecord,
  now: number,
): boolean {
  if (item.state !== "awaiting_input") return false;
  applyWorkItemEvent(db, item.id, "answer_received");
  applyWorkItemEvent(db, item.id, "turn_ended");
  if (item.checkpoint)
    saveCheckpoint(db, item.id, {
      ...item.checkpoint,
      phase: "verifying",
      wipCommit: linkAsk.headCommit,
    });
  enqueueJobOnce(db, {
    queue: JOB_KIND.reverify,
    jobKey: `risk-approved:${linkAsk.questionId}`,
    payload: { itemId: item.id, decide: true },
    now,
  });
  return true;
}

/**
 * Stop on the Risk card: the item stops and its pull request stays open. Posts the stop
 * response in Linear. Returns whether the item stopped.
 */
export function stopForRisk(
  db: Database,
  linkAsk: LinkAsk,
  item: WorkItemRecord,
  by: string,
  now: number,
): boolean {
  return applyLinearCommand(
    db,
    { type: "stop", source: "dashboard", itemId: item.id, requestedAt: now },
    now,
    `${by} stopped this in Paws instead of approving the high-risk changes in ${shortCommit(linkAsk.headCommit)}. The pull request stays open.`,
    { keepPullRequest: true },
  ).applied;
}

/** The line Paws posts once a person approved or requested changes on the Risk card. */
export function riskDecidedNote(
  linkAsk: LinkAsk,
  decision: "approve" | "changes",
  by: string,
  note: string | null,
): string {
  const commit = shortCommit(linkAsk.headCommit);
  const what =
    decision === "approve"
      ? `${by} approved the high-risk changes in ${commit} in Paws. The pull request joins the merge queue.`
      : `${by} requested changes to ${commit} in Paws. The agent picks them up.`;
  return note ? `${what}\n\n${note}` : what;
}

/**
 * The handoff for a Linear reply on the risk approval: the reply is the change request, as
 * Request changes on the Risk card, and approves nothing.
 */
export function riskReplyHandoff(linkAsk: LinkAsk, reply: string): string {
  return [
    "Handoff from the previous session.",
    `A person replied in Linear while Paws waited for the risk approval of ${shortCommit(linkAsk.headCommit)}. Treat the reply as requested changes; it approves nothing:`,
    reply.trim(),
  ].join("\n");
}

/**
 * A risk decision on the session. Posted after the pull request response, so the key carries
 * the `risk-approval:` prefix the activity gate lets through: a `response` for an approval and
 * a `thought` for a change request.
 */
export function postRiskActivity(
  db: Database,
  input: {
    sessionId: string;
    item: WorkItemRecord;
    kind: "response" | "thought";
    body: string;
    key: string;
    now: number;
  },
): void {
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: input.sessionId,
    idempotencyKey: `risk-approval:${input.key}`,
    delivery: "critical",
    payload: {
      id: randomUUID(),
      sessionId: input.sessionId,
      itemId: input.item.id,
      issueId: input.item.linearIssueId,
      kind: input.kind,
      body: input.body,
    },
    now: input.now,
  });
}
