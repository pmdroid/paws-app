import { dashboardPath, dashboardUrl } from "../dashboard-links";
import {
  endPolicyOutageSteps,
  getPolicyOutageSteps,
  getWorkItemSteps,
  recordPolicyOutageSteps,
  setPolicyOutageQuestionSteps,
  type Db,
  type Q,
  type Steps,
  type PolicyOutage,
  type WorkItemRecord,
} from "../db";
import type { DecisionDocument } from "../closeout";
import { journal } from "../journal";
import { cancelQuestionSteps, getQuestionSteps } from "../questions";
import { askSteps } from "./operations";

export type MainPolicyError = {
  message: string;
  path: string;
  main: string;
  commit: string | null;
};

export async function holdForPolicyOutage(
  store: Db,
  input: {
    item: WorkItemRecord;
    repository: string;
    unreadable: MainPolicyError;
    now: number;
    publicUrl: string | null;
  },
): Promise<string> {
  const outage = await store.transaction(function* (q) {
    const before = yield* getPolicyOutageSteps(q, input.repository);
    const recorded = yield* recordPolicyOutageSteps(q, {
      repository: input.repository,
      error: input.unreadable.message,
      policyPath: input.unreadable.path,
      main: input.unreadable.main,
      changedBy: input.unreadable.commit,
      now: input.now,
    });
    if (before?.questionId && recorded.questionId === null)
      yield* cancelQuestionSteps(q, before.questionId, input.now);
    if (before === null)
      journal(`closeout policy on main of ${input.repository} does not load: ${recorded.error}`);
    if (yield* askableSteps(q, recorded))
      yield* askAboutPolicySteps(q, recorded, input.item, input.now);
    return (yield* getPolicyOutageSteps(q, input.repository))!;
  });
  return policyOutageWait(
    outage,
    await store.run((q) => questionLinkSteps(q, outage, input.item.id, input.publicUrl)),
  );
}

export async function policyLoads(
  store: Db,
  repository: string,
  now: number,
): Promise<PolicyOutage | null> {
  const ended = await store.transaction(function* (q) {
    const outage = yield* endPolicyOutageSteps(q, repository);
    if (outage?.questionId) yield* cancelQuestionSteps(q, outage.questionId, now);
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

export async function policyOutageNote(
  store: Db,
  repository: string,
  itemId: string,
  publicUrl: string | null,
  unreadable: MainPolicyError | null = null,
): Promise<string> {
  const outage = await store.run((q) => getPolicyOutageSteps(q, repository));
  const changedBy = unreadable?.commit ?? outage?.changedBy ?? null;
  const changed = changedBy
    ? ` Commit ${changedBy} last changed \`${unreadable?.path ?? outage?.policyPath}\`.`
    : "";
  if (outage === null)
    return `The Closeout policy on main doesn't load, so every task in this repository waits for one fix on main.${changed}`;
  const link = await store.run((q) => questionLinkSteps(q, outage, itemId, publicUrl));
  return `The Closeout policy on main is broken for the whole repository.${changed}${link ? ` One fix on main unblocks every task: [open question](${link}).` : ""}`;
}

function* askableSteps(q: Q, outage: PolicyOutage): Steps<boolean> {
  if (outage.questionId === null) return true;
  return (yield* getQuestionSteps(q, outage.questionId))?.status === "cancelled";
}

function* askAboutPolicySteps(
  q: Q,
  outage: PolicyOutage,
  item: WorkItemRecord,
  now: number,
): Steps<void> {
  const current = yield* getWorkItemSteps(q, item.id);
  if (!current?.sessionKey || current.cancelRequested) return;
  const asked = yield* askSteps(
    q,
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
  yield* setPolicyOutageQuestionSteps(q, outage.repository, {
    id: asked.question.id,
    itemId: current.id,
  });
}

function* questionLinkSteps(
  q: Q,
  outage: PolicyOutage,
  itemId: string,
  publicUrl: string | null,
): Steps<string | null> {
  if (outage.questionId === null || outage.questionItemId === itemId) return null;
  const status = (yield* getQuestionSteps(q, outage.questionId))?.status;
  if (status !== "open" && status !== "queued") return null;
  const page = `/questions/${encodeURIComponent(outage.questionId)}`;
  return publicUrl ? dashboardUrl(publicUrl, page) : dashboardPath(page);
}
