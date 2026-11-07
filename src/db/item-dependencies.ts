import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";
import {
  delegationHasOpenWork,
  parentIssueIdSql,
  type TaskMode,
  type WorkItemState,
} from "../core";
import { orm } from "./orm";
import { itemDependencySnapshot, taskBlock, workItem } from "./schema";
import type { TaskBlock } from "./task-blocks";

export type DependencyItem = {
  id: string;
  delegationId: string;
  linearIssueId: string;
  identifier: string;
  title: string;
  state: WorkItemState;
  cancelRequested: number;
  mode: TaskMode | null;
  brief: string | null;
};

export type DependencyIdentity = {
  delegationIssueId: string;
  sessionId: string;
  organizationId: string;
  clientId: string;
  appUserId: string;
  sessionGeneration: number;
  teamId: string;
  ownerActorId: string | null;
  creatorId: string | null;
};

export type DependencySnapshot = {
  generation: number;
  scope: string;
  linearStates: string;
  linearIdentifiers: string;
  workspaceId: string;
};

export type ManagedBlockerItem = {
  state: WorkItemState;
  mode: TaskMode | null;
  cancelRequested: number;
  mergeSha: string | null;
};

const itemColumns =
  sql.raw(`i.id,i.delegation_id AS delegationId,i.linear_issue_id AS linearIssueId,
  i.linear_identifier AS identifier,i.title,i.state,i.cancel_requested AS cancelRequested,
  t.mode,i.brief`);

export function itemSpecificationPresent(db: Database, itemId: string): number | null {
  return (
    orm(db).all<{ present: number }>(
      sql`SELECT COALESCE(p.present,1) AS present FROM work_item i
       LEFT JOIN work_item_specification p ON p.item_id=i.id WHERE i.id=${itemId}`,
    )[0]?.present ?? null
  );
}

export function readDependencyScope(
  db: Database,
  itemId: string,
  workspaceId: string,
): (DependencyItem & DependencyIdentity) | null {
  return (
    orm(db).all<DependencyItem & DependencyIdentity>(
      sql`SELECT ${itemColumns},${sql.raw(parentIssueIdSql("i"))} AS delegationIssueId,s.session_id AS sessionId,
       s.organization_id AS organizationId,s.oauth_client_id AS clientId,s.app_user_id AS appUserId,
       s.generation AS sessionGeneration,s.team_id AS teamId,
       COALESCE((SELECT u.linear_user_id FROM workspace_user u
         JOIN work_item oi ON oi.owner_user_id=u.id
         WHERE oi.delegation_id=i.delegation_id AND oi.session_key=s.session_id
         ORDER BY oi.created_at, oi.position, oi.id LIMIT 1),
       (SELECT oi.delegated_by FROM work_item oi
         WHERE oi.delegation_id=i.delegation_id AND oi.session_key=s.session_id AND oi.delegated_by IS NOT NULL
         ORDER BY oi.created_at, oi.position, oi.id LIMIT 1), s.creator_id) AS ownerActorId,
       s.creator_id AS creatorId
       FROM work_item i
       JOIN linear_session s ON s.session_id=(
         SELECT si.session_key FROM work_item si
         JOIN linear_session ls ON ls.session_id=si.session_key AND ls.stopped_at IS NULL
         WHERE si.delegation_id=i.delegation_id
         ORDER BY si.created_at, si.position, si.id LIMIT 1)
       JOIN workspace w ON w.linear_organization_id=s.organization_id
       LEFT JOIN work_item_task t ON t.item_id=i.id
       LEFT JOIN work_item_specification p ON p.item_id=i.id
       WHERE i.id=${itemId} AND w.id=${workspaceId} AND ${sql.raw(delegationHasOpenWork("i.delegation_id"))}
       AND s.stopped_at IS NULL
       AND s.oauth_client_id IS NOT NULL AND s.app_user_id IS NOT NULL
       AND s.team_id IS NOT NULL AND COALESCE(p.present,1)=1`,
    )[0] ?? null
  );
}

export function listPresentDelegationItems(db: Database, delegationId: string): DependencyItem[] {
  return orm(db).all<DependencyItem>(
    sql`SELECT ${itemColumns} FROM work_item i
       LEFT JOIN work_item_task t ON t.item_id=i.id
       LEFT JOIN work_item_specification p ON p.item_id=i.id
       WHERE i.delegation_id=${delegationId} AND COALESCE(p.present,1)=1 ORDER BY i.position,i.id`,
  );
}

export function readDependencySnapshot(db: Database, itemId: string): DependencySnapshot | null {
  return (
    orm(db)
      .select({
        generation: itemDependencySnapshot.generation,
        scope: itemDependencySnapshot.scope,
        linearStates: itemDependencySnapshot.linearStates,
        linearIdentifiers: itemDependencySnapshot.linearIdentifiers,
        workspaceId: itemDependencySnapshot.workspaceId,
      })
      .from(itemDependencySnapshot)
      .where(eq(itemDependencySnapshot.itemId, itemId))
      .get() ?? null
  );
}

export function dependencySnapshotGeneration(db: Database, itemId: string): number | undefined {
  return orm(db)
    .select({ generation: itemDependencySnapshot.generation })
    .from(itemDependencySnapshot)
    .where(eq(itemDependencySnapshot.itemId, itemId))
    .get()?.generation;
}

export function delegationHasItemWithoutSnapshot(db: Database, delegationId: string): boolean {
  return (
    orm(db).all(
      sql`SELECT 1 FROM work_item i WHERE i.delegation_id=${delegationId} AND i.state NOT IN ('completed','merged','cancelled')
         AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=i.id AND p.present=0)
         AND NOT EXISTS(SELECT 1 FROM item_dependency_snapshot s WHERE s.item_id=i.id)`,
    ).length > 0
  );
}

export function delegationHasReconciliationWork(db: Database, delegationId: string): boolean {
  return (
    orm(db).all(
      sql`SELECT 1 FROM item_reconciliation_request r JOIN work_item i ON i.id=r.item_id WHERE i.delegation_id=${delegationId}
         UNION ALL SELECT 1 FROM item_reconciliation_effect e JOIN work_item i ON i.id=e.item_id WHERE i.delegation_id=${delegationId} LIMIT 1`,
    ).length > 0
  );
}

export function listBlocksOf(db: Database, blockedLinearIssueIds: string[]): TaskBlock[] {
  if (blockedLinearIssueIds.length === 0) return [];
  return orm(db)
    .select({
      blockerLinearIssueId: taskBlock.blockerLinearIssueId,
      blockedLinearIssueId: taskBlock.blockedLinearIssueId,
    })
    .from(taskBlock)
    .where(inArray(taskBlock.blockedLinearIssueId, blockedLinearIssueIds))
    .all();
}

export function latestIssueIdentifier(db: Database, linearIssueId: string): string | undefined {
  return orm(db)
    .select({ identifier: workItem.linearIdentifier })
    .from(workItem)
    .where(and(eq(workItem.linearIssueId, linearIssueId), isNotNull(workItem.linearIdentifier)))
    .orderBy(desc(workItem.createdAt), desc(workItem.id))
    .limit(1)
    .get()?.identifier;
}

export function saveDependencySnapshot(
  db: Database,
  snapshot: {
    itemId: string;
    workspaceId: string;
    generation: number;
    scope: string;
    linearStates: string;
    linearIdentifiers: string;
  },
): void {
  orm(db).run(
    sql`INSERT INTO item_dependency_snapshot(item_id,workspace_id,generation,scope,linear_states,linear_identifiers,external_evidence)
         VALUES(${snapshot.itemId},${snapshot.workspaceId},${snapshot.generation},${snapshot.scope},${snapshot.linearStates},${snapshot.linearIdentifiers},'{}') ON CONFLICT(item_id) DO UPDATE SET
         generation=excluded.generation,scope=excluded.scope,linear_states=excluded.linear_states,
         linear_identifiers=excluded.linear_identifiers,external_evidence=excluded.external_evidence
         WHERE item_dependency_snapshot.workspace_id=excluded.workspace_id`,
  );
}

export function listManagedBlockerItems(
  db: Database,
  input: { workspaceId: string; issueId: string; itemId: string },
): ManagedBlockerItem[] {
  return orm(db).all<ManagedBlockerItem>(
    sql`SELECT i.state,t.mode,i.cancel_requested AS cancelRequested,f.merge_sha AS mergeSha
     FROM work_item i
     JOIN linear_session s ON s.session_id=i.session_key
     JOIN workspace w ON w.linear_organization_id=s.organization_id
     LEFT JOIN work_item_task t ON t.item_id=i.id LEFT JOIN remote_merge_fact f ON f.item_id=i.id
     WHERE w.id=${input.workspaceId} AND i.linear_issue_id=${input.issueId} AND i.delegation_id<>(SELECT delegation_id FROM work_item WHERE id=${input.itemId})
     AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=i.id AND p.present=0)
     ORDER BY i.created_at, i.id`,
  );
}

export function listDelegationExternalEvidence(
  db: Database,
  workspaceId: string,
  delegationId: string,
): string[] {
  return orm(db)
    .select({ evidence: itemDependencySnapshot.externalEvidence })
    .from(itemDependencySnapshot)
    .innerJoin(workItem, eq(workItem.id, itemDependencySnapshot.itemId))
    .where(
      and(
        eq(itemDependencySnapshot.workspaceId, workspaceId),
        eq(workItem.delegationId, delegationId),
      ),
    )
    .orderBy(asc(itemDependencySnapshot.generation), asc(workItem.position), asc(workItem.id))
    .all()
    .map((row) => row.evidence);
}
