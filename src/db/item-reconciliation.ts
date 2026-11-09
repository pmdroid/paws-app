import type { Database } from "bun:sqlite";
import {
  and,
  asc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
import {
  delegationHasOpenWork,
  delegationIssueIdSql,
  parentIssueIdSql,
  parentTaskKeySql,
} from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonFromText, jsonText, jsonValue } from "./json-text";

export type ReconciliationRequest = { itemId: string; token: string };

export type ReconciliationEffect = { itemId: string; kind: string; token: string };

export type ReconciliationIdentity = {
  delegationId: string;
  issueId: string;
  taskKey: string | null;
  sessionId: string;
  organizationId: string;
  teamId: string;
  appUserId: string;
  clientId: string;
  creatorId: string | null;
  actorId: string | null;
  generation: number;
};

export type ReconciliationItem = {
  id: string;
  issueId: string;
  brief: string | null;
  hash: string | null;
  revision: number | null;
  present: number | null;
};

export type ReconciliationTarget = { itemId: string; workspaceId: string };

export type RelationItem = ReconciliationTarget & { issueId: string; delegationId: string };

function run<T>(db: Database, body: (q: Q) => Steps<T>): T {
  return settled(sqliteDb(db).run(body));
}

export function* listItemReconciliationRequestsSteps(
  q: Q,
  delegationId: string,
): Steps<ReconciliationRequest[]> {
  const { itemReconciliationRequest: r, workItem } = q.t;
  return yield* q.all(
    q.orm
      .select({ itemId: r.itemId, token: r.token })
      .from(r)
      .innerJoin(workItem, eq(workItem.id, r.itemId))
      .where(eq(workItem.delegationId, delegationId))
      .orderBy(asc(r.itemId)),
  );
}

export function listItemReconciliationRequests(
  db: Database,
  delegationId: string,
): ReconciliationRequest[] {
  return run(db, (q) => listItemReconciliationRequestsSteps(q, delegationId));
}

export function* readReconciliationIdentitySteps(
  q: Q,
  itemId: string,
  workspaceId: string,
): Steps<ReconciliationIdentity | null> {
  const { linearSession: s, workItem: i, workspace: w, workspaceUser: u } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        delegationId: i.delegationId,
        issueId: sql<string>`${sql.raw(delegationIssueIdSql("work_item", q.dialect))}`,
        taskKey: sql<string | null>`${sql.raw(parentTaskKeySql("work_item", q.dialect))}`,
        sessionId: s.sessionId,
        organizationId: s.organizationId,
        teamId: s.teamId,
        appUserId: s.appUserId,
        clientId: s.oauthClientId,
        creatorId: s.creatorId,
        actorId: sql<string | null>`COALESCE(${u.linearUserId}, ${i.delegatedBy}, ${s.creatorId})`,
        generation: s.generation,
      })
      .from(i)
      .innerJoin(s, eq(s.sessionId, i.sessionKey))
      .innerJoin(w, eq(w.linearOrganizationId, s.organizationId))
      .leftJoin(u, eq(u.id, i.ownerUserId))
      .where(
        and(
          eq(i.id, itemId),
          eq(w.id, workspaceId),
          sql.raw(delegationHasOpenWork("work_item.delegation_id")),
          isNull(s.stoppedAt),
          isNotNull(s.teamId),
          isNotNull(s.appUserId),
          isNotNull(s.oauthClientId),
        ),
      ),
  );
  return (row as ReconciliationIdentity | undefined) ?? null;
}

export function readReconciliationIdentity(
  db: Database,
  itemId: string,
  workspaceId: string,
): ReconciliationIdentity | null {
  return run(db, (q) => readReconciliationIdentitySteps(q, itemId, workspaceId));
}

export function* listReconciliationItemsSteps(
  q: Q,
  delegationId: string,
): Steps<ReconciliationItem[]> {
  const { workItem: i, workItemSpecification: p } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: i.id,
        issueId: i.linearIssueId,
        brief: jsonText(q, i.brief),
        hash: p.hash,
        revision: p.revision,
        present: p.present,
      })
      .from(i)
      .leftJoin(p, eq(p.itemId, i.id))
      .where(eq(i.delegationId, delegationId))
      .orderBy(asc(i.id)),
  );
  return rows as ReconciliationItem[];
}

export function listReconciliationItems(db: Database, delegationId: string): ReconciliationItem[] {
  return run(db, (q) => listReconciliationItemsSteps(q, delegationId));
}

export function* delegationReconciliationChangesSteps(q: Q, delegationId: string): Steps<number> {
  const { delegationReconciliation: r } = q.t;
  const row = yield* q.one(
    q.orm.select({ changes: r.changes }).from(r).where(eq(r.delegationId, delegationId)),
  );
  return row?.changes ?? 0;
}

export function delegationReconciliationChanges(db: Database, delegationId: string): number {
  return run(db, (q) => delegationReconciliationChangesSteps(q, delegationId));
}

export function* markItemSpecificationAbsentSteps(q: Q, itemId: string, hash: string): Steps<void> {
  const { workItemSpecification: p } = q.t;
  yield* q.exec(
    q.orm
      .insert(p)
      .values({ itemId, hash, revision: 1, present: 0 })
      .onConflictDoUpdate({ target: p.itemId, set: { present: 0 } }),
  );
}

export function markItemSpecificationAbsent(db: Database, itemId: string, hash: string): void {
  run(db, (q) => markItemSpecificationAbsentSteps(q, itemId, hash));
}

export function* saveItemSpecificationSteps(q: Q, itemId: string, hash: string): Steps<void> {
  const { workItemSpecification: p } = q.t;
  yield* q.exec(
    q.orm
      .insert(p)
      .values({ itemId, hash, revision: 1, present: 1 })
      .onConflictDoUpdate({
        target: p.itemId,
        set: {
          hash: sql`excluded.hash`,
          revision: sql`${p.revision}+CASE WHEN ${p.hash}<>excluded.hash THEN 1 ELSE 0 END`,
          present: 1,
        },
      }),
  );
}

export function saveItemSpecification(db: Database, itemId: string, hash: string): void {
  run(db, (q) => saveItemSpecificationSteps(q, itemId, hash));
}

type ReconciledItemFields = {
  brief: string;
  title: string;
  linearIdentifier: string;
  position: number;
};

export function* updateReconciledWorkItemSteps(
  q: Q,
  itemId: string,
  fields: ReconciledItemFields,
): Steps<void> {
  const { workItem } = q.t;
  yield* q.exec(
    q.orm
      .update(workItem)
      .set({ ...fields, brief: jsonFromText(q, fields.brief) })
      .where(eq(workItem.id, itemId)),
  );
}

export function updateReconciledWorkItem(
  db: Database,
  itemId: string,
  fields: ReconciledItemFields,
): void {
  run(db, (q) => updateReconciledWorkItemSteps(q, itemId, fields));
}

export function* clearDelegationDependencyScopesSteps(q: Q, delegationId: string): Steps<void> {
  const { itemDependencySnapshot: d, workItem } = q.t;
  yield* q.exec(
    q.orm
      .update(d)
      .set({ scope: jsonValue(q, []) })
      .where(
        inArray(
          d.itemId,
          q.orm
            .select({ id: workItem.id })
            .from(workItem)
            .where(eq(workItem.delegationId, delegationId)),
        ),
      ),
  );
}

export function clearDelegationDependencyScopes(db: Database, delegationId: string): void {
  run(db, (q) => clearDelegationDependencyScopesSteps(q, delegationId));
}

export function* saveItemReconciliationEffectSteps(
  q: Q,
  effect: ReconciliationEffect,
): Steps<void> {
  const { itemReconciliationEffect: e } = q.t;
  yield* q.exec(
    q.orm
      .insert(e)
      .values(effect)
      .onConflictDoUpdate({ target: [e.itemId, e.kind], set: { token: sql`excluded.token` } }),
  );
}

export function saveItemReconciliationEffect(db: Database, effect: ReconciliationEffect): void {
  run(db, (q) => saveItemReconciliationEffectSteps(q, effect));
}

export function* listItemReconciliationEffectsSteps(
  q: Q,
  delegationId: string,
): Steps<ReconciliationEffect[]> {
  const { itemReconciliationEffect: e, workItem } = q.t;
  return yield* q.all(
    q.orm
      .select({ itemId: e.itemId, kind: e.kind, token: e.token })
      .from(e)
      .innerJoin(workItem, eq(workItem.id, e.itemId))
      .where(eq(workItem.delegationId, delegationId)),
  );
}

export function listItemReconciliationEffects(
  db: Database,
  delegationId: string,
): ReconciliationEffect[] {
  return run(db, (q) => listItemReconciliationEffectsSteps(q, delegationId));
}

export function* delegationHasOpenItemSteps(q: Q, delegationId: string): Steps<boolean> {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: workItem.id })
      .from(workItem)
      .where(
        and(
          eq(workItem.delegationId, delegationId),
          notInArray(workItem.state, ["completed", "merged", "cancelled"]),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export function delegationHasOpenItem(db: Database, delegationId: string): boolean {
  return run(db, (q) => delegationHasOpenItemSteps(q, delegationId));
}

export function* recordDelegationReconciledSteps(
  q: Q,
  delegationId: string,
  reconciledChanges: number,
  reconciledAt: number,
): Steps<void> {
  const { delegationReconciliation: r } = q.t;
  yield* q.exec(
    q.orm
      .insert(r)
      .values({ delegationId, reconciledChanges, reconciledAt })
      .onConflictDoUpdate({
        target: r.delegationId,
        set: {
          reconciledChanges: sql`excluded.reconciled_changes`,
          reconciledAt: sql`excluded.reconciled_at`,
        },
      }),
  );
}

export function recordDelegationReconciled(
  db: Database,
  delegationId: string,
  reconciledChanges: number,
  reconciledAt: number,
): void {
  run(db, (q) => recordDelegationReconciledSteps(q, delegationId, reconciledChanges, reconciledAt));
}

export function* deleteItemReconciliationRequestSteps(
  q: Q,
  itemId: string,
  workspaceId: string,
  token: string,
): Steps<void> {
  const { itemReconciliationRequest: r } = q.t;
  yield* q.exec(
    q.orm
      .delete(r)
      .where(and(eq(r.itemId, itemId), eq(r.workspaceId, workspaceId), eq(r.token, token))),
  );
}

export function deleteItemReconciliationRequest(
  db: Database,
  itemId: string,
  workspaceId: string,
  token: string,
): void {
  run(db, (q) => deleteItemReconciliationRequestSteps(q, itemId, workspaceId, token));
}

export function* deleteItemReconciliationEffectSteps(
  q: Q,
  effect: ReconciliationEffect,
): Steps<void> {
  const { itemReconciliationEffect: e } = q.t;
  yield* q.exec(
    q.orm
      .delete(e)
      .where(and(eq(e.itemId, effect.itemId), eq(e.kind, effect.kind), eq(e.token, effect.token))),
  );
}

export function deleteItemReconciliationEffect(db: Database, effect: ReconciliationEffect): void {
  run(db, (q) => deleteItemReconciliationEffectSteps(q, effect));
}

/** False when the item already has a request from another workspace. */
export function* requestItemReconciliationSteps(
  q: Q,
  itemId: string,
  workspaceId: string,
  token: string,
): Steps<boolean> {
  const { itemReconciliationRequest: r } = q.t;
  const accepted = yield* q.all(
    q.orm
      .insert(r)
      .values({ itemId, workspaceId, token })
      .onConflictDoUpdate({
        target: r.itemId,
        set: { token: sql`excluded.token` },
        setWhere: sql`${r.workspaceId}=excluded.workspace_id`,
      })
      .returning({ itemId: r.itemId }),
  );
  return accepted.length > 0;
}

export function requestItemReconciliation(
  db: Database,
  itemId: string,
  workspaceId: string,
  token: string,
): boolean {
  return run(db, (q) => requestItemReconciliationSteps(q, itemId, workspaceId, token));
}

type ChangedIssue = {
  issueId: string;
  organizationId: string;
  parentIssueId?: string | null;
};

/** Open items with a live session. An `issue` narrows them to the items that issue can affect. */
export function* listReconciliationTargetsSteps(
  q: Q,
  issue?: ChangedIssue,
): Steps<ReconciliationTarget[]> {
  const { linearSession: s, workItem: i, workspace: w } = q.t;
  const parentIssueId = sql.raw(parentIssueIdSql("work_item", q.dialect));
  return yield* q.all(
    q.orm
      .selectDistinct({ itemId: i.id, workspaceId: w.id })
      .from(i)
      .innerJoin(s, eq(s.sessionId, i.sessionKey))
      .innerJoin(w, eq(w.linearOrganizationId, s.organizationId))
      .where(
        and(
          sql.raw(delegationHasOpenWork("work_item.delegation_id")),
          isNotNull(i.sessionKey),
          isNull(s.stoppedAt),
          issue && eq(s.organizationId, issue.organizationId),
          issue &&
            or(
              sql`${parentIssueId}=${issue.issueId}`,
              sql`EXISTS(SELECT 1 FROM work_item hit WHERE hit.delegation_id=work_item.delegation_id AND hit.linear_issue_id=${issue.issueId})`,
              sql`EXISTS(SELECT 1 FROM task_block b WHERE b.blocker_linear_issue_id=${issue.issueId} AND work_item.delegation_id=(
                SELECT bi.delegation_id FROM work_item bi
                WHERE bi.linear_issue_id=b.blocked_linear_issue_id AND bi.state<>'cancelled'
                AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=bi.id AND p.present=0)
                ORDER BY bi.created_at DESC, bi.id DESC LIMIT 1))`,
              issue.parentIssueId === undefined || issue.parentIssueId === null
                ? undefined
                : sql`${parentIssueId}=${issue.parentIssueId}`,
            ),
        ),
      ),
  );
}

export function listReconciliationTargets(
  db: Database,
  issue?: ChangedIssue,
): ReconciliationTarget[] {
  return run(db, (q) => listReconciliationTargetsSteps(q, issue));
}

export function* countDelegationReconciliationChangeSteps(q: Q, itemId: string): Steps<void> {
  const { delegationReconciliation: r, workItem } = q.t;
  const item = yield* q.one(
    q.orm
      .select({ delegationId: workItem.delegationId })
      .from(workItem)
      .where(eq(workItem.id, itemId)),
  );
  if (!item) return;
  yield* q.exec(
    q.orm
      .insert(r)
      .values({ delegationId: item.delegationId, changes: 1 })
      .onConflictDoUpdate({ target: r.delegationId, set: { changes: sql`${r.changes}+1` } }),
  );
}

export function countDelegationReconciliationChange(db: Database, itemId: string): void {
  run(db, (q) => countDelegationReconciliationChangeSteps(q, itemId));
}

/** A delegation is due when it was never reconciled, changed since, or last ran by `cutoff`. */
export function* itemReconciliationDueSteps(q: Q, itemId: string, cutoff: number): Steps<boolean> {
  const { delegationReconciliation: r, workItem: i } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ itemId: i.id })
      .from(i)
      .leftJoin(r, eq(r.delegationId, i.delegationId))
      .where(
        and(
          eq(i.id, itemId),
          or(
            isNull(r.reconciledAt),
            gt(r.changes, r.reconciledChanges),
            lte(r.reconciledAt, cutoff),
          ),
        ),
      ),
  );
  return row !== undefined;
}

export function itemReconciliationDue(db: Database, itemId: string, cutoff: number): boolean {
  return run(db, (q) => itemReconciliationDueSteps(q, itemId, cutoff));
}

type RelationItemFilter = { blockedOnly: boolean; itemId?: string };

/** Open items with a saved dependency snapshot, in `work_item.id` order. */
export function* listRelationItemsSteps(q: Q, filter: RelationItemFilter): Steps<RelationItem[]> {
  const {
    itemDependencySnapshot: d,
    linearSession: s,
    workItem: i,
    workItemSpecification: p,
    workspace: w,
  } = q.t;
  return yield* q.all(
    q.orm
      .selectDistinct({
        itemId: i.id,
        workspaceId: w.id,
        issueId: i.linearIssueId,
        delegationId: i.delegationId,
      })
      .from(i)
      .innerJoin(s, eq(s.sessionId, i.sessionKey))
      .innerJoin(w, eq(w.linearOrganizationId, s.organizationId))
      .innerJoin(d, eq(d.itemId, i.id))
      .leftJoin(p, eq(p.itemId, i.id))
      .where(
        and(
          sql.raw(delegationHasOpenWork("work_item.delegation_id")),
          isNull(s.stoppedAt),
          notInArray(i.state, ["completed", "merged", "cancelled"]),
          sql`COALESCE(${p.present},1)=1`,
          filter.blockedOnly
            ? and(
                eq(i.state, "queued"),
                sql`EXISTS(SELECT 1 FROM item_hold h WHERE h.item_id=${i.id} AND h.reason='blocked')`,
              )
            : undefined,
          filter.itemId === undefined ? undefined : eq(i.id, filter.itemId),
        ),
      )
      .orderBy(asc(i.id)),
  );
}

export function listRelationItems(db: Database, filter: RelationItemFilter): RelationItem[] {
  return run(db, (q) => listRelationItemsSteps(q, filter));
}
