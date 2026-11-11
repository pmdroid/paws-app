import { and, eq, isNull } from "drizzle-orm";
import { validateSubIssueDrafts, type FiledSubIssue, type SubIssueDraft } from "../core";
import { type Q, type Steps, type Db } from "./db";
import { applyWorkItemEventSteps, cancelAdvancingJobsSteps, getWorkItemSteps } from "./items";
import { markRunSteps } from "./runs";
import { jsonText, jsonValue } from "./json-text";
import { getTaskModeSteps } from "./tasks";

/** The sub-issues one plan run proposed, keyed by the question that asks to file them. */
export type PlanProposal = {
  questionId: string;
  itemId: string;
  parentIssueId: string;
  repository: string | null;
  drafts: SubIssueDraft[];
  createdAt: number;
  filed: FiledSubIssue[] | null;
  filedAt: number | null;
};

type PlanProposalInput = {
  questionId: string;
  itemId: string;
  parentIssueId: string;
  repository: string | null;
  drafts: readonly SubIssueDraft[];
  now: number;
};

export function* savePlanProposalSteps(q: Q, input: PlanProposalInput): Steps<PlanProposal> {
  const drafts = validateSubIssueDrafts(input.drafts);
  yield* q.exec(
    q.orm.insert(q.t.planProposal).values({
      questionId: input.questionId,
      itemId: input.itemId,
      parentIssueId: input.parentIssueId,
      repository: input.repository,
      drafts: jsonValue(q, drafts),
      createdAt: input.now,
    }),
  );
  return (yield* getPlanProposalSteps(q, input.questionId))!;
}

export async function savePlanProposal(store: Db, input: PlanProposalInput): Promise<PlanProposal> {
  return store.run((q) => savePlanProposalSteps(q, input));
}

export function* getPlanProposalSteps(q: Q, questionId: string): Steps<PlanProposal | null> {
  const { planProposal } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        questionId: planProposal.questionId,
        itemId: planProposal.itemId,
        parentIssueId: planProposal.parentIssueId,
        repository: planProposal.repository,
        drafts: jsonText(q, planProposal.drafts),
        createdAt: planProposal.createdAt,
        filed: jsonText(q, planProposal.filed),
        filedAt: planProposal.filedAt,
      })
      .from(planProposal)
      .where(eq(planProposal.questionId, questionId)),
  );
  return row === undefined
    ? null
    : {
        ...row,
        drafts: validateSubIssueDrafts(JSON.parse(row.drafts)),
        filed: row.filed === null ? null : (JSON.parse(row.filed) as FiledSubIssue[]),
      };
}

export async function getPlanProposal(store: Db, questionId: string): Promise<PlanProposal | null> {
  return store.run((q) => getPlanProposalSteps(q, questionId));
}

export function* recordPlanFiledSteps(
  q: Q,
  questionId: string,
  filed: readonly FiledSubIssue[],
  now: number,
): Steps<PlanProposal> {
  const { planProposal } = q.t;
  yield* q.exec(
    q.orm
      .update(planProposal)
      .set({ filed: jsonValue(q, filed), filedAt: now })
      .where(and(eq(planProposal.questionId, questionId), isNull(planProposal.filed))),
  );
  const proposal = yield* getPlanProposalSteps(q, questionId);
  if (proposal === null) throw new Error(`Plan proposal ${questionId} is missing`);
  return proposal;
}

export async function recordPlanFiled(
  store: Db,
  questionId: string,
  filed: readonly FiledSubIssue[],
  now: number,
): Promise<PlanProposal> {
  return store.transaction((q) => recordPlanFiledSteps(q, questionId, filed, now));
}

export function* completePlanTaskSteps(q: Q, itemId: string, now: number) {
  const item = yield* getWorkItemSteps(q, itemId);
  if (!item || item.state !== "awaiting_input" || item.cancelRequested)
    throw new Error("Plan task is no longer waiting for approval");
  if ((yield* getTaskModeSteps(q, itemId)) !== "plan")
    throw new Error("Only plan tasks complete at the plan approval");
  yield* applyWorkItemEventSteps(q, itemId, "answer_completed", { now });
  if (item.currentRunId) yield* markRunSteps(q, item.currentRunId, "ended", now);
  yield* cancelAdvancingJobsSteps(q, itemId, "plan_completed", now);
}

export async function completePlanTask(store: Db, itemId: string, now: number): Promise<void> {
  await store.transaction((q) => completePlanTaskSteps(q, itemId, now));
}
