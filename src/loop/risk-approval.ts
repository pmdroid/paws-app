import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { JOB_KIND, riskLine } from "../core";
import {
  applyLinearCommand,
  applyWorkItemEvent,
  deleteRiskFix,
  enqueueJobOnce,
  enqueueOutboxOnce,
  immediate,
  getCandidateRisk,
  getAutomaticRiskApproval,
  saveAutomaticRiskApproval,
  listCloseoutProgress,
  getRiskFix,
  getWorkItem,
  listLinkAsks,
  openLinkAsks,
  saveCheckpoint,
  saveRiskFix,
  type CandidateRisk,
  type LinkAsk,
  type RiskFix,
  type WorkItemRecord,
} from "../db";
import { journalCaught } from "../journal";
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

/** The files a fix changed since `approved`, and which of them a high-risk glob matched. */
export type FixRisk = { changed: string[]; paths: string[] };

/**
 * Whether head S may merge as far as its risk goes. A normal-tier head, or any head on a Paws
 * whose risk gate is off, needs nothing. A high-risk or unclassified head needs a person's
 * approval of S in Paws, or of an earlier head with the same patch against main (`samePatch`),
 * as after a rebase. A Linear reply never approves, so only `approve` decisions count.
 * An exact manual approval takes precedence over automatic approval. Automatic approval needs
 * clean evidence on this exact head and base, and never carries to a fix or rebase.
 *
 * A fix Paws made after the latest approval (CI, a review, a comment) keeps that approval when
 * none of the files the fix itself changed since the approved head is a high-risk path. A fix
 * is commits on top of the approved patch; a rebase that changed the patch is not one and asks. The
 * comparison is recorded for S either way: it names the approved head and why the approval
 * carried over, or the high-risk paths the next ask lists.
 */
export async function riskApprovalFor(
  db: Database,
  input: {
    itemId: string;
    head: string;
    publicUrl: string | null | undefined;
    /** Whether `approved` carries the same patch as S against `base`. */
    samePatch: (approved: string, base: string) => Promise<boolean>;
    /** What the fix from `approved` to S changed, against main's `base`. Null when unreadable. */
    fixRisk?: (approved: string, base: string) => Promise<FixRisk | null>;
    automatic?: AutomaticRiskChecks;
    now?: number;
  },
): Promise<RiskApproval> {
  if (!riskGateOn(input.publicUrl)) return "not_required";
  const risk = getCandidateRisk(db, input.itemId, input.head);
  if (risk?.tier === "normal") return "not_required";
  const approvals = riskApprovals(db, input.itemId);
  if (approvals.some((ask) => ask.headCommit === input.head)) return "approved";
  if (risk?.tier === "high" && automaticEnabled(input.automatic, input.itemId)) {
    if (getAutomaticRiskApproval(db, input.itemId, input.head) !== null) return "approved";
    const evidenceIds = await cleanReviewEvidence(db, risk, input.automatic);
    if (evidenceIds !== null) {
      const now = input.now ?? Date.now();
      immediate(db, () => {
        saveAutomaticRiskApproval(db, {
          itemId: input.itemId,
          head: input.head,
          approvedBy: "paws:clean-reviews",
          evidenceIds,
          approvedAt: now,
        });
        const item = getWorkItem(db, input.itemId);
        if (item?.sessionKey)
          postRiskActivity(db, {
            sessionId: item.sessionKey,
            item,
            kind: "response",
            body: `Approved automatically: both reviews clean. Commit ${shortCommit(input.head)} joins the merge queue.`,
            key: `automatic:${input.itemId}:${input.head}`,
            now,
          });
      });
      return "approved";
    }
  }
  if (risk === null) return "missing";
  for (const ask of approvals.toReversed())
    if (await input.samePatch(ask.headCommit, risk.base)) return "approved";
  const latest = approvals.at(-1);
  if (latest === undefined || input.fixRisk === undefined) return "missing";
  const fix = await fixSinceApproval(db, {
    itemId: input.itemId,
    head: input.head,
    approved: latest,
    base: risk.base,
    fixRisk: input.fixRisk,
    now: input.now ?? Date.now(),
  });
  return fix !== null && fix.paths.length === 0 ? "approved" : "missing";
}

/** Inputs read from the candidate checkout and Closeout's structured evidence store. */
export type AutomaticRiskChecks = {
  /** Read only for a classified high-risk head without a manual approval. */
  enabled: () => boolean;
  /** Trusted policy inputs, including skills and imports outside .agents. Null is unreadable. */
  policyPaths: (digest: string) => Promise<readonly string[] | null>;
  changedPaths: (base: string) => Promise<string[]>;
  reviews: (
    taskId: string,
    head: string,
    scope: { policyDigest: string; base: string },
  ) => Promise<
    Array<{
      itemId: string;
      attempt: number;
      findings: Array<{ severity: string }>;
    }>
  >;
};

/** A missing or unreadable setting leaves the person gate in place. */
function automaticEnabled(
  checks: AutomaticRiskChecks | undefined,
  itemId: string,
): checks is AutomaticRiskChecks {
  try {
    return checks?.enabled() === true;
  } catch (error) {
    journalCaught(error, "risk-approval.automaticEnabled", itemId);
    return false;
  }
}

/** A bypass, skipped review, missing record or unreadable checkout always leaves the person gate. */
async function cleanReviewEvidence(
  db: Database,
  risk: CandidateRisk,
  checks: AutomaticRiskChecks,
): Promise<string[] | null> {
  const run = listCloseoutProgress(db, risk.itemId, risk.head).at(-1);
  if (
    run?.decision !== "accepted" ||
    run.base !== risk.base ||
    run.steps.some(
      (step) =>
        step.state !== "passed" &&
        !(
          step.state === "skipped" &&
          (step.detail === "no changed path matches" ||
            (step.kind === "review" &&
              /^\d+ changed lines, under minChangedLines \d+$/.test(step.detail ?? "")))
        ),
    )
  )
    return null;
  const reviews = ["security-review", "independent-review"].map((id) =>
    run.steps.find((step) => step.id === id && step.kind === "review"),
  );
  if (!reviews.every((step) => step?.state === "passed" && step.evidencePath && step.attempt > 0))
    return null;
  try {
    const records = await checks.reviews(run.taskId, risk.head, {
      policyDigest: run.policyDigest,
      base: run.base,
    });
    for (const step of reviews) {
      const record = records.find(
        (entry) => entry.itemId === step!.id && entry.attempt === step!.attempt,
      );
      if (!record || record.findings.some((finding) => finding.severity !== "P3")) return null;
    }
    const changed = await checks.changedPaths(risk.base);
    if (
      changed.some(
        (path) =>
          path === ".paws" ||
          path.startsWith(".paws/") ||
          path === ".agents" ||
          path.startsWith(".agents/"),
      )
    )
      return null;
    const policyPaths = await checks.policyPaths(run.policyDigest);
    if (policyPaths === null || changed.some((path) => policyPaths.includes(path))) return null;
    return reviews.map((step) => step!.evidencePath!);
  } catch (error) {
    journalCaught(error, "risk-approval.cleanReviewEvidence", risk.itemId);
    return null;
  }
}

/**
 * Compares S with the approved ask and records the result. It runs on every read: the high-risk
 * paths come from Settings and `.paws/high-risk-paths`, which can change before S merges, so a
 * stored comparison is never trusted. A fix Paws cannot read drops any earlier record of S.
 */
async function fixSinceApproval(
  db: Database,
  input: {
    itemId: string;
    head: string;
    approved: LinkAsk;
    base: string;
    fixRisk: (approved: string, base: string) => Promise<FixRisk | null>;
    now: number;
  },
): Promise<RiskFix | null> {
  const fix = await input.fixRisk(input.approved.headCommit, input.base);
  if (fix === null) {
    deleteRiskFix(db, input.itemId, input.head);
    return null;
  }
  const row: RiskFix = {
    itemId: input.itemId,
    head: input.head,
    approvedHead: input.approved.headCommit,
    approvedQuestionId: input.approved.questionId,
    changed: [...fix.changed].sort(),
    paths: [...fix.paths].sort(),
    recordedAt: input.now,
  };
  saveRiskFix(db, row);
  return row;
}

/** "`a.ts`, `b.ts` and 3 more", as `riskLine` lists paths. */
function listedPaths(paths: string[]): string {
  return riskLine({ tier: "high", paths }).replace(/^Risk: high — /, "");
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

/**
 * "High-risk paths changed: `src/auth/session.ts`." for Linear and the Risk card. After an
 * approval only the fix's own high-risk paths since the approved head are listed.
 */
export function riskAskDetail(risk: CandidateRisk | null, fix: RiskFix | null = null): string {
  if (fix !== null && fix.paths.length > 0)
    return `High-risk paths the fix changed since the approved ${shortCommit(fix.approvedHead)}: ${listedPaths(fix.paths)}.`;
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
    detail: riskAskDetail(
      getCandidateRisk(db, item.id, input.head),
      getRiskFix(db, item.id, input.head),
    ),
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
