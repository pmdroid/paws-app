import type { Database } from "bun:sqlite";
import { dashboardPath, dashboardUrl } from "../dashboard-links";
import {
  endPolicyOutage,
  getPolicyOutage,
  getWorkItem,
  immediate,
  recordPolicyOutage,
  setPolicyOutageQuestion,
  type PolicyOutage,
  type WorkItemRecord,
} from "../db";
import type { DecisionDocument } from "../closeout";
import { journal } from "../journal";
import { cancelQuestion, getQuestion } from "../questions";
import { ask } from "./operations";

export type MainPolicyError = {
  message: string;
  path: string;
  main: string;
  commit: string | null;
};

export function holdForPolicyOutage(
  db: Database,
  input: {
    item: WorkItemRecord;
    repository: string;
    unreadable: MainPolicyError;
    now: number;
    publicUrl: string | null;
  },
): string {
  const outage = immediate(db, () => {
    const before = getPolicyOutage(db, input.repository);
    const recorded = recordPolicyOutage(db, {
      repository: input.repository,
      error: input.unreadable.message,
      policyPath: input.unreadable.path,
      main: input.unreadable.main,
      changedBy: input.unreadable.commit,
      now: input.now,
    });
    if (before?.questionId && recorded.questionId === null)
      cancelQuestion(db, before.questionId, input.now);
    if (before === null)
      journal(`closeout policy on main of ${input.repository} does not load: ${recorded.error}`);
    if (askable(db, recorded)) askAboutPolicy(db, recorded, input.item, input.now);
    return getPolicyOutage(db, input.repository)!;
  });
  return policyOutageWait(outage, questionLink(db, outage, input.item.id, input.publicUrl));
}

export function policyLoads(db: Database, repository: string, now: number): PolicyOutage | null {
  const ended = immediate(db, () => {
    const outage = endPolicyOutage(db, repository);
    if (outage?.questionId) cancelQuestion(db, outage.questionId, now);
    return outage;
  });
  if (ended) journal(`closeout policy on main of ${repository} loads again`);
  return ended;
}

export function policyOutageWait(outage: PolicyOutage, link: string | null = null): string {
  const wait = `The Closeout policy on main doesn't load: ${outage.error}. Paws merges again once it's fixed.`;
  return link ? `${wait} [Open question](${link}).` : wait;
}

export function policyOutageQuestion(outage: PolicyOutage): string {
  const changed = outage.changedBy
    ? `Commit ${outage.changedBy} last changed it on main.`
    : "Paws could not tell which commit last changed it on main.";
  return [
    `The Closeout policy on main of ${outage.repository} doesn't load, so Closeout can't judge any change there. Accepted pull requests wait in the merge queue instead of going back to Closeout.`,
    `Please fix \`${outage.policyPath}\` on main. ${changed} This question settles by itself once the policy on main loads again, and the merge queue goes on.`,
    "Load error:",
    "```",
    outage.error,
    "```",
  ].join("\n\n");
}

export function policyLoadFailed(decision: DecisionDocument | null | undefined): boolean {
  return (
    decision?.decision === "blocked" &&
    decision.policy.digest === null &&
    !decision.policy.absent &&
    decision.items.length === 0 &&
    !(decision.message ?? "").startsWith("origin/main is unavailable")
  );
}

export function policyOutageNote(
  db: Database,
  repository: string,
  itemId: string,
  publicUrl: string | null,
): string {
  const outage = getPolicyOutage(db, repository);
  if (outage === null)
    return "The Closeout policy on main doesn't load, so every task in this repository waits for one fix on main.";
  const changed = outage.changedBy ? ` Commit ${outage.changedBy} last changed it.` : "";
  const link = questionLink(db, outage, itemId, publicUrl);
  return `The Closeout policy on main is broken for the whole repository.${changed}${link ? ` One fix on main unblocks every task: [open question](${link}).` : ""}`;
}

function askable(db: Database, outage: PolicyOutage): boolean {
  if (outage.questionId === null) return true;
  return getQuestion(db, outage.questionId)?.status === "cancelled";
}

function askAboutPolicy(
  db: Database,
  outage: PolicyOutage,
  item: WorkItemRecord,
  now: number,
): void {
  const current = getWorkItem(db, item.id);
  if (!current?.sessionKey || current.cancelRequested) return;
  const asked = ask(
    db,
    {
      itemId: current.id,
      runId: current.currentRunId,
      sessionId: current.sessionKey,
      workspace: true,
    },
    "policy-outage",
    policyOutageQuestion(outage),
    { reason: "policy_outage", now },
  );
  setPolicyOutageQuestion(db, outage.repository, { id: asked.question.id, itemId: current.id });
}

function questionLink(
  db: Database,
  outage: PolicyOutage,
  itemId: string,
  publicUrl: string | null,
): string | null {
  if (outage.questionId === null || outage.questionItemId === itemId) return null;
  const status = getQuestion(db, outage.questionId)?.status;
  if (status !== "open" && status !== "queued") return null;
  const page = `/questions/${encodeURIComponent(outage.questionId)}`;
  return publicUrl ? dashboardUrl(publicUrl, page) : dashboardPath(page);
}
