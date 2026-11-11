import { journalCaught } from "../journal";
import {
  delegationHasItemWithoutSnapshotSteps,
  delegationHasReconciliationWorkSteps,
  delegationWorkspaceIdSteps,
  readItemDelegationSteps,
  type Q,
  type Steps,
  type Db,
} from "../db";
import { canAdvanceItemSteps, itemBlockersSteps, readyItemsSteps } from "./dependencies";

export type ReadinessPhase = "start" | "merge";
export type ReadinessHold = "reconciling" | "snapshot" | "cancelled" | "blocked";

export function* delegationReadinessSteps(q: Q, delegationId: string): Steps<ReadinessHold | null> {
  if (yield* delegationHasReconciliationWorkSteps(q, delegationId)) return "reconciling";
  return (yield* delegationHasItemWithoutSnapshotSteps(q, delegationId)) ? "snapshot" : null;
}

export function itemReadiness(
  store: Db,
  itemId: string,
  phase: ReadinessPhase,
): Promise<ReadinessHold | null> {
  return store.run((q) => itemReadinessSteps(q, itemId, phase));
}

export function* itemReadinessSteps(
  q: Q,
  itemId: string,
  phase: ReadinessPhase,
): Steps<ReadinessHold | null> {
  const item = yield* readItemDelegationSteps(q, itemId);
  if (!item || item.cancelRequested) return "cancelled";
  const workspaceId = yield* delegationWorkspaceIdSteps(q, item.delegationId);
  if (workspaceId === undefined) return "blocked";
  const target = { itemId, workspaceId };
  try {
    const ready =
      phase === "start"
        ? (yield* readyItemsSteps(q, target)).readyItemIds.includes(itemId)
        : yield* canAdvanceItemSteps(q, target);
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
export function* blockingIssuesSteps(q: Q, itemId: string): Steps<string[]> {
  const delegationId = (yield* readItemDelegationSteps(q, itemId))?.delegationId;
  const workspaceId =
    delegationId === undefined ? undefined : yield* delegationWorkspaceIdSteps(q, delegationId);
  if (workspaceId === undefined) return [];
  try {
    return yield* itemBlockersSteps(q, { itemId, workspaceId });
  } catch (caughtError1) {
    journalCaught(caughtError1, "readiness.blockingIssues.itemBlockers", itemId);
    return [];
  }
}
