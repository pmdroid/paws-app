import { isBlockerSatisfied } from "../core";
import {
  listDelegationExternalEvidenceSteps,
  listManagedBlockerItemsSteps,
  type Q,
  type Steps,
  type Db,
} from "../db";

type Target = { workspaceId: string; itemId: string };
export type MergeEvidence = {
  merged: boolean;
  repository: string;
  targetBranch: string;
  pullRequestNumber: number;
  headSha: string;
  mergeSha: string | null;
};

export function* managedBlockerSatisfiedSteps(
  q: Q,
  target: Target,
  issue: string,
): Steps<boolean | null> {
  const items = yield* listManagedBlockerItemsSteps(q, { ...target, issueId: issue });
  if (items.every((item) => item.state === "cancelled")) return null;
  const active = items.filter((item) => item.state !== "cancelled" && !item.cancelRequested);
  const item = (active.length > 0 ? active : items).at(-1)!;
  return !item.cancelRequested && isBlockerSatisfied(item);
}

export type BlockerEvidence = {
  satisfied: boolean;
  reason: string;
  checkedAt: number;
  merge?: MergeEvidence;
};

export async function readExternalBlockerEvidence(
  store: Db,
  target: { workspaceId: string; delegationId: string },
): Promise<Record<string, BlockerEvidence>> {
  const saved = await store.run((q) =>
    listDelegationExternalEvidenceSteps(q, target.workspaceId, target.delegationId),
  );
  const evidence: Record<string, BlockerEvidence> = {};
  for (const json of saved)
    for (const [id, entry] of Object.entries(JSON.parse(json) as Record<string, BlockerEvidence>))
      if (!evidence[id] || entry.checkedAt >= evidence[id].checkedAt) evidence[id] = entry;
  return evidence;
}
