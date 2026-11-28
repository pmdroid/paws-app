import { eq, inArray, sql } from "drizzle-orm";
import type { Q, Steps } from "./db";
import {
  listBlocksOfSteps,
  listDependencyScopesSteps,
  listDependencySnapshotsSteps,
  listPresentItemsOfDelegationsSteps,
} from "./item-dependencies";
import { listConfirmedMergeShasSteps } from "./remote-merges";
import type { TaskBlock } from "./task-blocks";

export type ReadinessInputs =
  ReturnType<typeof readinessInputsSteps> extends Steps<infer T> ? T : never;

export function* readinessInputsSteps(q: Q, itemIds: readonly string[]) {
  const t = q.t;
  const ids = [...new Set(itemIds)];
  const rows = yield* q.all(
    q.orm
      .select({
        id: t.workItem.id,
        delegationId: t.workItem.delegationId,
        issueId: t.workItem.linearIssueId,
        cancelRequested: t.workItem.cancelRequested,
        present: sql<number>`COALESCE(${t.workItemSpecification.present},1)`.mapWith(Number),
      })
      .from(t.workItem)
      .leftJoin(t.workItemSpecification, eq(t.workItemSpecification.itemId, t.workItem.id))
      .where(inArray(t.workItem.id, ids)),
  );
  const delegationIds = [...new Set(rows.map((row) => row.delegationId))];
  const flags = yield* q.all(
    q.orm
      .select({
        id: t.workItem.delegationId,
        workspaceId: sql<string | null>`MIN((SELECT w.id FROM workspace w
          JOIN linear_session s ON s.organization_id=w.linear_organization_id
          WHERE s.session_id=${t.workItem.sessionKey}))`,
        reconciling: sql<boolean>`BOOL_OR(EXISTS(SELECT 1 FROM item_reconciliation_request r WHERE r.item_id=${t.workItem.id})
          OR EXISTS(SELECT 1 FROM item_reconciliation_effect e WHERE e.item_id=${t.workItem.id}))`,
        withoutSnapshot: sql<boolean>`BOOL_OR(${t.workItem.state} NOT IN ('completed','merged','cancelled')
          AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=${t.workItem.id} AND p.present=0)
          AND NOT EXISTS(SELECT 1 FROM item_dependency_snapshot s WHERE s.item_id=${t.workItem.id}))`,
      })
      .from(t.workItem)
      .where(inArray(t.workItem.delegationId, delegationIds))
      .groupBy(t.workItem.delegationId),
  );
  const siblings = yield* listPresentItemsOfDelegationsSteps(q, delegationIds);
  const issueIds = [...new Set(siblings.map((item) => item.linearIssueId))];
  const blocks = new Map<string, TaskBlock[]>(issueIds.map((id) => [id, []]));
  for (const edge of yield* listBlocksOfSteps(q, issueIds))
    blocks.get(edge.blockedLinearIssueId)!.push(edge);
  const merges = new Map<string, string | null>(siblings.map((item) => [item.id, null]));
  for (const [id, sha] of yield* listConfirmedMergeShasSteps(q, [...merges.keys()]))
    merges.set(id, sha);
  const members = Map.groupBy(siblings, (item) => item.delegationId);
  return {
    items: new Map(rows.map(({ id, ...row }) => [id, row])),
    delegations: new Map(
      flags.map(({ id, workspaceId, reconciling, withoutSnapshot }) => [
        id,
        {
          workspaceId: workspaceId ?? undefined,
          reconciling: Boolean(reconciling),
          withoutSnapshot: Boolean(withoutSnapshot),
          items: members.get(id) ?? [],
        },
      ]),
    ),
    scopes: yield* listDependencyScopesSteps(q, ids),
    snapshots: yield* listDependencySnapshotsSteps(q, ids),
    blocks,
    merges,
  };
}
