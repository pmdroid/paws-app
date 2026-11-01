import type { Database } from "bun:sqlite";
import { validateSubIssueDrafts, type FiledSubIssue, type SubIssueDraft } from "../core";
import { applyWorkItemEvent, cancelAdvancingJobs, getWorkItem } from "./items";
import { markRun } from "./runs";
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

type PlanProposalRow = {
  question_id: string;
  item_id: string;
  parent_issue_id: string;
  repository: string | null;
  drafts: string;
  created_at: number;
  filed: string | null;
  filed_at: number | null;
};

export function savePlanProposal(
  db: Database,
  input: {
    questionId: string;
    itemId: string;
    parentIssueId: string;
    repository: string | null;
    drafts: readonly SubIssueDraft[];
    now: number;
  },
): PlanProposal {
  const drafts = validateSubIssueDrafts(input.drafts);
  db.run(
    `INSERT INTO plan_proposal (question_id, item_id, parent_issue_id, repository, drafts, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.questionId,
      input.itemId,
      input.parentIssueId,
      input.repository,
      JSON.stringify(drafts),
      input.now,
    ],
  );
  return getPlanProposal(db, input.questionId)!;
}

export function getPlanProposal(db: Database, questionId: string): PlanProposal | null {
  const row = db
    .query<PlanProposalRow, [string]>("SELECT * FROM plan_proposal WHERE question_id = ?")
    .get(questionId);
  return row === null
    ? null
    : {
        questionId: row.question_id,
        itemId: row.item_id,
        parentIssueId: row.parent_issue_id,
        repository: row.repository,
        drafts: validateSubIssueDrafts(JSON.parse(row.drafts)),
        createdAt: row.created_at,
        filed: row.filed === null ? null : (JSON.parse(row.filed) as FiledSubIssue[]),
        filedAt: row.filed_at,
      };
}

/** Record what the tracker filed. The first record wins, so a retried delivery keeps it. */
export function recordPlanFiled(
  db: Database,
  questionId: string,
  filed: readonly FiledSubIssue[],
  now: number,
): PlanProposal {
  return immediate(db, () => {
    db.run(
      "UPDATE plan_proposal SET filed = ?, filed_at = ? WHERE question_id = ? AND filed IS NULL",
      [JSON.stringify(filed), now, questionId],
    );
    const proposal = getPlanProposal(db, questionId);
    if (proposal === null) throw new Error(`Plan proposal ${questionId} is missing`);
    return proposal;
  });
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
