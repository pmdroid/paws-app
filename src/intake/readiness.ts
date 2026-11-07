import { journalCaught } from "../journal";
import type { Database } from "bun:sqlite";
import { delegationWorkspaceId, readItemDelegation } from "../db";
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
  const item = readItemDelegation(db, itemId);
  if (!item || item.cancelRequested) return "cancelled";
  const workspaceId = delegationWorkspaceId(db, item.delegationId);
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
  const delegationId = readItemDelegation(db, itemId)?.delegationId;
  const workspaceId =
    delegationId === undefined ? undefined : delegationWorkspaceId(db, delegationId);
  if (workspaceId === undefined) return [];
  try {
    return itemBlockers(db, { itemId, workspaceId });
  } catch (caughtError1) {
    journalCaught(caughtError1, "readiness.blockingIssues.itemBlockers", itemId);
    return [];
  }
}
