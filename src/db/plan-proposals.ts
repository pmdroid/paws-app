import type { Database } from "bun:sqlite";
import { and, eq, isNull } from "drizzle-orm";
import { validateSubIssueDrafts, type FiledSubIssue, type SubIssueDraft } from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { applyWorkItemEvent, cancelAdvancingJobs, getWorkItem } from "./items";
import { markRun } from "./runs";
import { jsonText } from "./json-text";
import { getTaskMode } from "./tasks";
import { immediate } from "./tx";

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

const jsonIn = (q: Q, value: unknown) => (q.dialect === "sqlite" ? JSON.stringify(value) : value);

export function* savePlanProposalSteps(q: Q, input: PlanProposalInput): Steps<PlanProposal> {
  const drafts = validateSubIssueDrafts(input.drafts);
  yield* q.exec(
    q.orm.insert(q.t.planProposal).values({
      questionId: input.questionId,
      itemId: input.itemId,
      parentIssueId: input.parentIssueId,
      repository: input.repository,
      drafts: jsonIn(q, drafts),
      createdAt: input.now,
    }),
  );
  return (yield* getPlanProposalSteps(q, input.questionId))!;
}

export function savePlanProposal(db: Database, input: PlanProposalInput): PlanProposal {
  return settled(sqliteDb(db).run((q) => savePlanProposalSteps(q, input)));
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

export function getPlanProposal(db: Database, questionId: string): PlanProposal | null {
  return settled(sqliteDb(db).run((q) => getPlanProposalSteps(q, questionId)));
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
      .set({ filed: jsonIn(q, filed), filedAt: now })
      .where(and(eq(planProposal.questionId, questionId), isNull(planProposal.filed))),
  );
  const proposal = yield* getPlanProposalSteps(q, questionId);
  if (proposal === null) throw new Error(`Plan proposal ${questionId} is missing`);
  return proposal;
}

export function recordPlanFiled(
  db: Database,
  questionId: string,
  filed: readonly FiledSubIssue[],
  now: number,
): PlanProposal {
  return settled(sqliteDb(db).transaction((q) => recordPlanFiledSteps(q, questionId, filed, now)));
}

export function completePlanTask(db: Database, itemId: string, now: number): void {
  immediate(db, () => {
    const item = getWorkItem(db, itemId);
    if (!item || item.state !== "awaiting_input" || item.cancelRequested)
      throw new Error("Plan task is no longer waiting for approval");
    if (getTaskMode(db, itemId) !== "plan")
      throw new Error("Only plan tasks complete at the plan approval");
    applyWorkItemEvent(db, itemId, "answer_completed", { now });
    if (item.currentRunId) markRun(db, item.currentRunId, "ended", now);
    cancelAdvancingJobs(db, itemId, "plan_completed", now);
  });
}
