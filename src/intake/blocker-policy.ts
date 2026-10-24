import { isBlockerSatisfied, type TaskMode, type WorkItemState } from "../core";
import type { Database } from "bun:sqlite";

type Target = { workspaceId: string; itemId: string };
export type MergeEvidence = {
  merged: boolean;
  repository: string;
  targetBranch: string;
  pullRequestNumber: number;
  headSha: string;
  mergeSha: string | null;
};

export function managedBlockerSatisfied(
  db: Database,
  target: Target,
  issue: string,
): boolean | null {
  const items = db
    .query<
      {
        state: WorkItemState;
        mode: TaskMode | null;
        cancelRequested: number;
        mergeSha: string | null;
      },
      [string, string, string]
    >(
      `SELECT i.state,t.mode,i.cancel_requested AS cancelRequested,f.merge_sha AS mergeSha
     FROM work_item i
     JOIN linear_session s ON s.session_id=i.session_key
     JOIN workspace w ON w.linear_organization_id=s.organization_id
     LEFT JOIN work_item_task t ON t.item_id=i.id LEFT JOIN remote_merge_fact f ON f.item_id=i.id
     WHERE w.id=? AND i.linear_issue_id=? AND i.delegation_id<>(SELECT delegation_id FROM work_item WHERE id=?)
     AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=i.id AND p.present=0)
     ORDER BY i.created_at, i.id`,
    )
    .all(target.workspaceId, issue, target.itemId);
  if (items.every((item) => item.state === "cancelled")) return null;
  const active = items.filter((item) => item.state !== "cancelled" && !item.cancelRequested);
  const item = (active.length > 0 ? active : items).at(-1)!;
  return (
    !item.cancelRequested &&
    isBlockerSatisfied(item) &&
    (item.state !== "merged" || !!item.mergeSha)
  );
}

export type BlockerEvidence = {
  satisfied: boolean;
  reason: string;
  checkedAt: number;
  merge?: MergeEvidence;
};

export function readExternalBlockerEvidence(
  db: Database,
  target: { workspaceId: string; delegationId: string },
): Record<string, BlockerEvidence> {
  const rows = db
    .query<{ evidence: string }, [string, string]>(
      `SELECT s.external_evidence AS evidence FROM item_dependency_snapshot s
       JOIN work_item i ON i.id=s.item_id
       WHERE s.workspace_id=? AND i.delegation_id=? ORDER BY s.generation,i.position,i.id`,
    )
    .all(target.workspaceId, target.delegationId);
  const evidence: Record<string, BlockerEvidence> = {};
  for (const row of rows)
    for (const [id, entry] of Object.entries(
      JSON.parse(row.evidence) as Record<string, BlockerEvidence>,
    ))
      if (!evidence[id] || entry.checkedAt >= evidence[id].checkedAt) evidence[id] = entry;
  return evidence;
}
