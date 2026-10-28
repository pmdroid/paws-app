import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import {
  canAdvanceItem,
  delegationSnapshotsComplete,
  hasPendingDelegationChanges,
  itemBlockers,
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
  const workspaceId = delegationWorkspace(db, item.delegationId);
  if (workspaceId === undefined) return "blocked";
  const target = { itemId, workspaceId };
  try {
    const ready =
      phase === "start"
        ? readyItems(db, target).readyItemIds.includes(itemId)
        : canAdvanceItem(db, target);
    return ready ? null : "blocked";
  } catch (caughtError1) {
    journalCaught(caughtError1, "readiness.itemReadiness.includes", itemId);
    return "blocked";
  }
}

/**
 * Identifiers of the issues that keep `itemId` held as "blocked". Empty only when readiness holds
 * it for something other than a blocker, which is an inconsistency for the caller to report.
 */
export function blockingIssues(db: Database, itemId: string): string[] {
  const delegationId = db
    .query<{ delegationId: string }, [string]>(
      "SELECT delegation_id AS delegationId FROM work_item WHERE id=?",
    )
    .get(itemId)?.delegationId;
  const workspaceId =
    delegationId === undefined ? undefined : delegationWorkspace(db, delegationId);
  if (workspaceId === undefined) return [];
  try {
    return itemBlockers(db, { itemId, workspaceId });
  } catch (caughtError1) {
    journalCaught(caughtError1, "readiness.blockingIssues.itemBlockers", itemId);
    return [];
  }
}

function delegationWorkspace(db: Database, delegationId: string): string | undefined {
  return db
    .query<{ id: string }, [string]>(
      `SELECT w.id FROM workspace w JOIN linear_session s ON s.organization_id=w.linear_organization_id JOIN work_item i ON i.session_key=s.session_id WHERE i.delegation_id=? LIMIT 1`,
    )
    .get(delegationId)?.id;
}
