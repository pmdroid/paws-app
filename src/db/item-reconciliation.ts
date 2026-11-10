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
import { type Q, type Steps, type Db } from "./db";
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

export async function listItemReconciliationRequests(
  store: Db,
  delegationId: string,
): Promise<ReconciliationRequest[]> {
  return store.run((q) => listItemReconciliationRequestsSteps(q, delegationId));
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

export async function readReconciliationIdentity(
  store: Db,
  itemId: string,
  workspaceId: string,
): Promise<ReconciliationIdentity | null> {
  return store.run((q) => readReconciliationIdentitySteps(q, itemId, workspaceId));
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

export async function listReconciliationItems(
  store: Db,
  delegationId: string,
): Promise<ReconciliationItem[]> {
  return store.run((q) => listReconciliationItemsSteps(q, delegationId));
}

export function* delegationReconciliationChangesSteps(q: Q, delegationId: string): Steps<number> {
  const { delegationReconciliation: r } = q.t;
  const row = yield* q.one(
    q.orm.select({ changes: r.changes }).from(r).where(eq(r.delegationId, delegationId)),
  );
  return row?.changes ?? 0;
}

export async function delegationReconciliationChanges(
  store: Db,
  delegationId: string,
): Promise<number> {
  return store.run((q) => delegationReconciliationChangesSteps(q, delegationId));
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

export async function markItemSpecificationAbsent(
  store: Db,
  itemId: string,
  hash: string,
): Promise<void> {
  await store.run((q) => markItemSpecificationAbsentSteps(q, itemId, hash));
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

export async function saveItemSpecification(
  store: Db,
  itemId: string,
  hash: string,
): Promise<void> {
  await store.run((q) => saveItemSpecificationSteps(q, itemId, hash));
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

export async function updateReconciledWorkItem(
  store: Db,
  itemId: string,
  fields: ReconciledItemFields,
): Promise<void> {
  await store.run((q) => updateReconciledWorkItemSteps(q, itemId, fields));
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

export async function clearDelegationDependencyScopes(
  store: Db,
  delegationId: string,
): Promise<void> {
  await store.run((q) => clearDelegationDependencyScopesSteps(q, delegationId));
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

export async function saveItemReconciliationEffect(
  store: Db,
  effect: ReconciliationEffect,
): Promise<void> {
  await store.run((q) => saveItemReconciliationEffectSteps(q, effect));
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

export async function listItemReconciliationEffects(
  store: Db,
  delegationId: string,
): Promise<ReconciliationEffect[]> {
  return store.run((q) => listItemReconciliationEffectsSteps(q, delegationId));
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

export async function delegationHasOpenItem(store: Db, delegationId: string): Promise<boolean> {
  return store.run((q) => delegationHasOpenItemSteps(q, delegationId));
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

export async function recordDelegationReconciled(
  store: Db,
  delegationId: string,
  reconciledChanges: number,
  reconciledAt: number,
): Promise<void> {
  await store.run((q) =>
    recordDelegationReconciledSteps(q, delegationId, reconciledChanges, reconciledAt),
  );
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

export async function deleteItemReconciliationRequest(
  store: Db,
  itemId: string,
  workspaceId: string,
  token: string,
): Promise<void> {
  await store.run((q) => deleteItemReconciliationRequestSteps(q, itemId, workspaceId, token));
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

export async function deleteItemReconciliationEffect(
  store: Db,
  effect: ReconciliationEffect,
): Promise<void> {
  await store.run((q) => deleteItemReconciliationEffectSteps(q, effect));
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

export async function requestItemReconciliation(
  store: Db,
  itemId: string,
  workspaceId: string,
  token: string,
): Promise<boolean> {
  return store.run((q) => requestItemReconciliationSteps(q, itemId, workspaceId, token));
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

export async function listReconciliationTargets(
  store: Db,
  issue?: ChangedIssue,
): Promise<ReconciliationTarget[]> {
  return store.run((q) => listReconciliationTargetsSteps(q, issue));
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

export async function countDelegationReconciliationChange(
  store: Db,
  itemId: string,
): Promise<void> {
  await store.run((q) => countDelegationReconciliationChangeSteps(q, itemId));
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

export async function itemReconciliationDue(
  store: Db,
  itemId: string,
  cutoff: number,
): Promise<boolean> {
  return store.run((q) => itemReconciliationDueSteps(q, itemId, cutoff));
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

export async function listRelationItems(
  store: Db,
  filter: RelationItemFilter,
): Promise<RelationItem[]> {
  return store.run((q) => listRelationItemsSteps(q, filter));
}
