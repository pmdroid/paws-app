import type { Database } from "bun:sqlite";
import { isBlockerSatisfied, type WorkItemState } from "../core";
import { getTaskMode } from "../db";
import {
  canAdvanceItem,
  delegationSnapshotsComplete,
  hasPendingDelegationChanges,
  readyItems,
} from "./dependencies";

export type ReadinessPhase = "start" | "merge";
export type ReadinessHold = "reconciling" | "snapshot" | "cancelled" | "blocked";

export function delegationReadiness(db: Database, delegationId: string): ReadinessHold | null {
  if (hasPendingDelegationChanges(db, delegationId)) return "reconciling";
  return delegationSnapshotsComplete(db, delegationId) ? null : "snapshot";
}

export function itemReadiness(
  db: Database,
  itemId: string,
  phase: ReadinessPhase,
): ReadinessHold | null {
  const item = db
    .query<{ delegationId: string; issueId: string; cancelRequested: number }, [string]>(
      "SELECT delegation_id AS delegationId,linear_issue_id AS issueId,cancel_requested AS cancelRequested FROM work_item WHERE id=?",
    )
    .get(itemId);
  if (!item || item.cancelRequested) return "cancelled";
  const workspaceId = db
    .query<{ id: string }, [string]>(
      `SELECT w.id FROM workspace w JOIN linear_session s ON s.organization_id=w.linear_organization_id JOIN work_item i ON i.session_key=s.session_id WHERE i.delegation_id=? LIMIT 1`,
    )
    .get(item.delegationId)?.id;
  if (workspaceId === undefined) return legacyBlocksClear(db, item) ? null : "blocked";
  const target = { itemId, workspaceId };
  try {
    const ready =
      phase === "start"
        ? readyItems(db, target).readyItemIds.includes(itemId)
        : canAdvanceItem(db, target);
    return ready ? null : "blocked";
  } catch {
    return "blocked";
  }
}

function legacyBlocksClear(db: Database, item: { delegationId: string; issueId: string }) {
  const blockers = db
    .query<{ id: string }, [string, string]>(
      `SELECT blocker_linear_issue_id AS id FROM task_block
       WHERE blocked_linear_issue_id = ?
       AND EXISTS (
         SELECT 1 FROM work_item
         WHERE delegation_id = ? AND linear_issue_id = task_block.blocker_linear_issue_id
       )`,
    )
    .all(item.issueId, item.delegationId);
  const latest = new Map(
    db
      .query<{ id: string; issueId: string; state: WorkItemState }, [string]>(
        `SELECT i.id,i.linear_issue_id AS issueId,i.state FROM work_item i WHERE i.delegation_id=?
         AND NOT EXISTS(SELECT 1 FROM work_item_specification s WHERE s.item_id=i.id AND s.present=0)
         ORDER BY i.position,i.rowid`,
      )
      .all(item.delegationId)
      .map((entry) => [entry.issueId, entry]),
  );
  return blockers.every(({ id }) => {
    const blocker = latest.get(id);
    return !!blocker && isBlockerSatisfied({ ...blocker, mode: getTaskMode(db, blocker.id) });
  });
}
