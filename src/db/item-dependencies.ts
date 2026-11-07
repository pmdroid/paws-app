import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, inArray, isNotNull, ne, notInArray, sql } from "drizzle-orm";
import {
  delegationHasOpenWork,
  parentIssueIdSql,
  type TaskMode,
  type WorkItemState,
} from "../core";
import { settled, sqliteDb, type Q } from "./db";
import { orm } from "./orm";
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

function jsonText(q: Q, value: unknown): string {
  return q.dialect === "sqlite" ? (value as string) : JSON.stringify(value);
}

function jsonValue(q: Q, text: string): string {
  return q.dialect === "sqlite" ? text : (JSON.parse(text) as string);
}

export function* itemSpecificationPresentSteps(q: Q, itemId: string) {
  const { workItem, workItemSpecification } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ present: sql<number>`COALESCE(${workItemSpecification.present},1)` })
      .from(workItem)
      .leftJoin(workItemSpecification, eq(workItemSpecification.itemId, workItem.id))
      .where(eq(workItem.id, itemId)),
  );
  return row?.present ?? null;
}

export function itemSpecificationPresent(db: Database, itemId: string): number | null {
  return settled(sqliteDb(db).run((q) => itemSpecificationPresentSteps(q, itemId)));
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

export function* listPresentDelegationItemsSteps(q: Q, delegationId: string) {
  const { workItem, workItemSpecification, workItemTask } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: workItem.id,
        delegationId: workItem.delegationId,
        linearIssueId: workItem.linearIssueId,
        identifier: workItem.linearIdentifier,
        title: workItem.title,
        state: workItem.state,
        cancelRequested: workItem.cancelRequested,
        mode: workItemTask.mode,
        brief: workItem.brief,
      })
      .from(workItem)
      .leftJoin(workItemTask, eq(workItemTask.itemId, workItem.id))
      .leftJoin(workItemSpecification, eq(workItemSpecification.itemId, workItem.id))
      .where(
        and(
          eq(workItem.delegationId, delegationId),
          sql`COALESCE(${workItemSpecification.present},1)=1`,
        ),
      )
      .orderBy(asc(workItem.position), asc(workItem.id)),
  );
  return rows.map((row): DependencyItem => ({
    ...row,
    state: row.state as WorkItemState,
    mode: row.mode as TaskMode | null,
    brief: row.brief === null ? null : jsonText(q, row.brief),
  }));
}

export function listPresentDelegationItems(db: Database, delegationId: string): DependencyItem[] {
  return settled(sqliteDb(db).run((q) => listPresentDelegationItemsSteps(q, delegationId)));
}

export function* readDependencySnapshotSteps(q: Q, itemId: string) {
  const { itemDependencySnapshot } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        generation: itemDependencySnapshot.generation,
        scope: itemDependencySnapshot.scope,
        linearStates: itemDependencySnapshot.linearStates,
        linearIdentifiers: itemDependencySnapshot.linearIdentifiers,
        workspaceId: itemDependencySnapshot.workspaceId,
      })
      .from(itemDependencySnapshot)
      .where(eq(itemDependencySnapshot.itemId, itemId)),
  );
  if (!row) return null;
  return {
    generation: row.generation,
    scope: jsonText(q, row.scope),
    linearStates: jsonText(q, row.linearStates),
    linearIdentifiers: jsonText(q, row.linearIdentifiers),
    workspaceId: row.workspaceId,
  } satisfies DependencySnapshot;
}

export function readDependencySnapshot(db: Database, itemId: string): DependencySnapshot | null {
  return settled(sqliteDb(db).run((q) => readDependencySnapshotSteps(q, itemId)));
}

export function* dependencySnapshotGenerationSteps(q: Q, itemId: string) {
  const { itemDependencySnapshot } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ generation: itemDependencySnapshot.generation })
      .from(itemDependencySnapshot)
      .where(eq(itemDependencySnapshot.itemId, itemId)),
  );
  return row?.generation;
}

export function dependencySnapshotGeneration(db: Database, itemId: string): number | undefined {
  return settled(sqliteDb(db).run((q) => dependencySnapshotGenerationSteps(q, itemId)));
}

export function* delegationHasItemWithoutSnapshotSteps(q: Q, delegationId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: workItem.id })
      .from(workItem)
      .where(
        and(
          eq(workItem.delegationId, delegationId),
          notInArray(workItem.state, ["completed", "merged", "cancelled"]),
          sql`NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=${workItem.id} AND p.present=0)`,
          sql`NOT EXISTS(SELECT 1 FROM item_dependency_snapshot s WHERE s.item_id=${workItem.id})`,
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function delegationHasItemWithoutSnapshot(db: Database, delegationId: string): boolean {
  return settled(sqliteDb(db).run((q) => delegationHasItemWithoutSnapshotSteps(q, delegationId)));
}

export function* delegationHasReconciliationWorkSteps(q: Q, delegationId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: workItem.id })
      .from(workItem)
      .where(
        and(
          eq(workItem.delegationId, delegationId),
          sql`(EXISTS(SELECT 1 FROM item_reconciliation_request r WHERE r.item_id=${workItem.id})
            OR EXISTS(SELECT 1 FROM item_reconciliation_effect e WHERE e.item_id=${workItem.id}))`,
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function delegationHasReconciliationWork(db: Database, delegationId: string): boolean {
  return settled(sqliteDb(db).run((q) => delegationHasReconciliationWorkSteps(q, delegationId)));
}

export function* listBlocksOfSteps(q: Q, blockedLinearIssueIds: string[]) {
  if (blockedLinearIssueIds.length === 0) return [];
  const { taskBlock } = q.t;
  return yield* q.all(
    q.orm
      .select({
        blockerLinearIssueId: taskBlock.blockerLinearIssueId,
        blockedLinearIssueId: taskBlock.blockedLinearIssueId,
      })
      .from(taskBlock)
      .where(inArray(taskBlock.blockedLinearIssueId, blockedLinearIssueIds)),
  );
}

export function listBlocksOf(db: Database, blockedLinearIssueIds: string[]): TaskBlock[] {
  return settled(sqliteDb(db).run((q) => listBlocksOfSteps(q, blockedLinearIssueIds)));
}

export function* latestIssueIdentifierSteps(q: Q, linearIssueId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ identifier: workItem.linearIdentifier })
      .from(workItem)
      .where(and(eq(workItem.linearIssueId, linearIssueId), isNotNull(workItem.linearIdentifier)))
      .orderBy(desc(workItem.createdAt), desc(workItem.id))
      .limit(1),
  );
  return row?.identifier ?? undefined;
}

export function latestIssueIdentifier(db: Database, linearIssueId: string): string | undefined {
  return settled(sqliteDb(db).run((q) => latestIssueIdentifierSteps(q, linearIssueId)));
}

type NewDependencySnapshot = {
  itemId: string;
  workspaceId: string;
  generation: number;
  scope: string;
  linearStates: string;
  linearIdentifiers: string;
};

export function* saveDependencySnapshotSteps(q: Q, snapshot: NewDependencySnapshot) {
  const { itemDependencySnapshot } = q.t;
  yield* q.exec(
    q.orm
      .insert(itemDependencySnapshot)
      .values({
        itemId: snapshot.itemId,
        workspaceId: snapshot.workspaceId,
        generation: snapshot.generation,
        scope: jsonValue(q, snapshot.scope),
        linearStates: jsonValue(q, snapshot.linearStates),
        linearIdentifiers: jsonValue(q, snapshot.linearIdentifiers),
        externalEvidence: jsonValue(q, "{}"),
      })
      .onConflictDoUpdate({
        target: itemDependencySnapshot.itemId,
        set: {
          generation: sql`excluded.generation`,
          scope: sql`excluded.scope`,
          linearStates: sql`excluded.linear_states`,
          linearIdentifiers: sql`excluded.linear_identifiers`,
          externalEvidence: sql`excluded.external_evidence`,
        },
        setWhere: sql`${itemDependencySnapshot.workspaceId}=excluded.workspace_id`,
      }),
  );
}

export function saveDependencySnapshot(db: Database, snapshot: NewDependencySnapshot): void {
  settled(sqliteDb(db).run((q) => saveDependencySnapshotSteps(q, snapshot)));
}

export function* listManagedBlockerItemsSteps(
  q: Q,
  input: { workspaceId: string; issueId: string; itemId: string },
) {
  const { linearSession, remoteMergeFact, workItem, workItemTask, workspace } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        state: workItem.state,
        mode: workItemTask.mode,
        cancelRequested: workItem.cancelRequested,
        mergeSha: remoteMergeFact.mergeSha,
      })
      .from(workItem)
      .innerJoin(linearSession, eq(linearSession.sessionId, workItem.sessionKey))
      .innerJoin(workspace, eq(workspace.linearOrganizationId, linearSession.organizationId))
      .leftJoin(workItemTask, eq(workItemTask.itemId, workItem.id))
      .leftJoin(remoteMergeFact, eq(remoteMergeFact.itemId, workItem.id))
      .where(
        and(
          eq(workspace.id, input.workspaceId),
          eq(workItem.linearIssueId, input.issueId),
          ne(
            workItem.delegationId,
            sql`(SELECT delegation_id FROM work_item WHERE id=${input.itemId})`,
          ),
          sql`NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=${workItem.id} AND p.present=0)`,
        ),
      )
      .orderBy(asc(workItem.createdAt), asc(workItem.id)),
  );
  return rows.map((row): ManagedBlockerItem => ({
    ...row,
    state: row.state as WorkItemState,
    mode: row.mode as TaskMode | null,
  }));
}

export function listManagedBlockerItems(
  db: Database,
  input: { workspaceId: string; issueId: string; itemId: string },
): ManagedBlockerItem[] {
  return settled(sqliteDb(db).run((q) => listManagedBlockerItemsSteps(q, input)));
}

export function* listDelegationExternalEvidenceSteps(
  q: Q,
  workspaceId: string,
  delegationId: string,
) {
  const { itemDependencySnapshot, workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ evidence: itemDependencySnapshot.externalEvidence })
      .from(itemDependencySnapshot)
      .innerJoin(workItem, eq(workItem.id, itemDependencySnapshot.itemId))
      .where(
        and(
          eq(itemDependencySnapshot.workspaceId, workspaceId),
          eq(workItem.delegationId, delegationId),
        ),
      )
      .orderBy(asc(itemDependencySnapshot.generation), asc(workItem.position), asc(workItem.id)),
  );
  return rows.map((row) => jsonText(q, row.evidence));
}

export function listDelegationExternalEvidence(
  db: Database,
  workspaceId: string,
  delegationId: string,
): string[] {
  return settled(
    sqliteDb(db).run((q) => listDelegationExternalEvidenceSteps(q, workspaceId, delegationId)),
  );
}
