import type { Database } from "bun:sqlite";
import {
  and,
  asc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notInArray,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  delegationHasOpenWork,
  delegationIssueIdSql,
  parentIssueIdSql,
  parentTaskKeySql,
} from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonText, jsonValue } from "./json-text";

export type ReconciliationRequest = { itemId: string; token: string };
export type ReconciliationEffect = { itemId: string; kind: string; token: string };
export type ReconciliationEffectKind = "spec" | "removed" | "canceled";
export type ReconciliationTarget = { itemId: string; workspaceId: string };
export type ReconciliationIdentity = {
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
export type RelationItem = ReconciliationTarget & { issueId: string; delegationId: string };
export type ReconciliationIssueChange = {
  issueId: string;
  organizationId: string;
  parentIssueId?: string | null;
};

const FINISHED = ["completed", "merged", "cancelled"];

function run<T>(db: Database, body: (q: Q) => Steps<T>): T {
  return settled(sqliteDb(db).run(body));
}

function aliases(q: Q) {
  return {
    i: alias(q.t.workItem, "i"),
    s: alias(q.t.linearSession, "s"),
    w: alias(q.t.workspace, "w"),
  };
}

export function* listDelegationReconciliationRequestsSteps(q: Q, delegationId: string) {
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

export function listDelegationReconciliationRequests(
  db: Database,
  delegationId: string,
): ReconciliationRequest[] {
  return run(db, (q) => listDelegationReconciliationRequestsSteps(q, delegationId));
}

export function* readReconciliationAuthoritySteps(
  q: Q,
  target: ReconciliationTarget,
): Steps<(ReconciliationIdentity & { delegationId: string }) | null> {
  const { i, s, w } = aliases(q);
  const u = alias(q.t.workspaceUser, "u");
  const row = yield* q.one(
    q.orm
      .select({
        delegationId: i.delegationId,
        issueId: sql<string>`${sql.raw(delegationIssueIdSql("i", q.dialect))}`,
        taskKey: sql<string | null>`${sql.raw(parentTaskKeySql("i", q.dialect))}`,
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
          eq(i.id, target.itemId),
          eq(w.id, target.workspaceId),
          sql.raw(delegationHasOpenWork("i.delegation_id")),
          isNull(s.stoppedAt),
          isNotNull(s.teamId),
          isNotNull(s.appUserId),
          isNotNull(s.oauthClientId),
        ),
      ),
  );
  return (row as (ReconciliationIdentity & { delegationId: string }) | undefined) ?? null;
}

export function readReconciliationAuthority(
  db: Database,
  target: ReconciliationTarget,
): (ReconciliationIdentity & { delegationId: string }) | null {
  return run(db, (q) => readReconciliationAuthoritySteps(q, target));
}

export function* listReconciliationItemsSteps(q: Q, delegationId: string) {
  const { workItem, workItemSpecification: p } = q.t;
  return yield* q.all(
    q.orm
      .select({
        id: workItem.id,
        issueId: workItem.linearIssueId,
        brief: jsonText(q, workItem.brief) as SQL<string | null>,
        hash: p.hash,
        revision: p.revision,
        present: p.present,
      })
      .from(workItem)
      .leftJoin(p, eq(p.itemId, workItem.id))
      .where(eq(workItem.delegationId, delegationId))
      .orderBy(asc(workItem.id)),
  );
}

export function listReconciliationItems(db: Database, delegationId: string): ReconciliationItem[] {
  return run(db, (q) => listReconciliationItemsSteps(q, delegationId));
}

export function* delegationReconciliationChangesSteps(q: Q, delegationId: string) {
  const { delegationReconciliation: r } = q.t;
  const row = yield* q.one(
    q.orm.select({ changes: r.changes }).from(r).where(eq(r.delegationId, delegationId)),
  );
  return row?.changes;
}

export function delegationReconciliationChanges(
  db: Database,
  delegationId: string,
): number | undefined {
  return run(db, (q) => delegationReconciliationChangesSteps(q, delegationId));
}

export function* markSpecificationAbsentSteps(q: Q, itemId: string, hash: string) {
  const { workItemSpecification: p } = q.t;
  yield* q.exec(
    q.orm
      .insert(p)
      .values({ itemId, hash, revision: 1, present: 0 })
      .onConflictDoUpdate({ target: p.itemId, set: { present: 0 } }),
  );
}

export function markSpecificationAbsent(db: Database, itemId: string, hash: string): void {
  run(db, (q) => markSpecificationAbsentSteps(q, itemId, hash));
}

export function* saveSpecificationSteps(q: Q, itemId: string, hash: string) {
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

export function saveSpecification(db: Database, itemId: string, hash: string): void {
  run(db, (q) => saveSpecificationSteps(q, itemId, hash));
}

type ReconciledItem = {
  brief: unknown;
  title: string;
  linearIdentifier: string;
  position: number;
};

export function* updateReconciledItemSteps(q: Q, itemId: string, item: ReconciledItem) {
  const { workItem } = q.t;
  yield* q.exec(
    q.orm
      .update(workItem)
      .set({ ...item, brief: jsonValue(q, item.brief) })
      .where(eq(workItem.id, itemId)),
  );
}

export function updateReconciledItem(db: Database, itemId: string, item: ReconciledItem): void {
  run(db, (q) => updateReconciledItemSteps(q, itemId, item));
}

export function* clearDelegationDependencyScopesSteps(q: Q, delegationId: string) {
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

export function* saveReconciliationEffectSteps(
  q: Q,
  itemId: string,
  kind: ReconciliationEffectKind,
  token: string,
) {
  const { itemReconciliationEffect: e } = q.t;
  yield* q.exec(
    q.orm
      .insert(e)
      .values({ itemId, kind, token })
      .onConflictDoUpdate({ target: [e.itemId, e.kind], set: { token: sql`excluded.token` } }),
  );
}

export function saveReconciliationEffect(
  db: Database,
  itemId: string,
  kind: ReconciliationEffectKind,
  token: string,
): void {
  run(db, (q) => saveReconciliationEffectSteps(q, itemId, kind, token));
}

export function* listDelegationReconciliationEffectsSteps(q: Q, delegationId: string) {
  const { itemReconciliationEffect: e, workItem } = q.t;
  return yield* q.all(
    q.orm
      .select({ itemId: e.itemId, kind: e.kind, token: e.token })
      .from(e)
      .innerJoin(workItem, eq(workItem.id, e.itemId))
      .where(eq(workItem.delegationId, delegationId)),
  );
}

export function listDelegationReconciliationEffects(
  db: Database,
  delegationId: string,
): ReconciliationEffect[] {
  return run(db, (q) => listDelegationReconciliationEffectsSteps(q, delegationId));
}

export function* delegationHasOpenItemSteps(q: Q, delegationId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workItem)
      .where(and(eq(workItem.delegationId, delegationId), notInArray(workItem.state, FINISHED))),
  );
  return row !== undefined;
}

export function delegationHasOpenItem(db: Database, delegationId: string): boolean {
  return run(db, (q) => delegationHasOpenItemSteps(q, delegationId));
}

export function* markDelegationReconciledSteps(
  q: Q,
  delegationId: string,
  reconciledChanges: number,
  reconciledAt: number,
) {
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

export function markDelegationReconciled(
  db: Database,
  delegationId: string,
  reconciledChanges: number,
  reconciledAt: number,
): void {
  run(db, (q) => markDelegationReconciledSteps(q, delegationId, reconciledChanges, reconciledAt));
}

export function* countDelegationChangeSteps(q: Q, itemId: string) {
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

export function countDelegationChange(db: Database, itemId: string): void {
  run(db, (q) => countDelegationChangeSteps(q, itemId));
}

export function* requestItemReconciliationSteps(
  q: Q,
  itemId: string,
  workspaceId: string,
  token: string,
) {
  const { itemReconciliationRequest: r } = q.t;
  const rows = yield* q.all(
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
  return rows.length;
}

export function requestItemReconciliation(
  db: Database,
  itemId: string,
  workspaceId: string,
  token: string,
): number {
  return run(db, (q) => requestItemReconciliationSteps(q, itemId, workspaceId, token));
}

export function* deleteReconciliationRequestSteps(
  q: Q,
  itemId: string,
  workspaceId: string,
  token: string,
) {
  const { itemReconciliationRequest: r } = q.t;
  yield* q.exec(
    q.orm
      .delete(r)
      .where(and(eq(r.itemId, itemId), eq(r.workspaceId, workspaceId), eq(r.token, token))),
  );
}

export function deleteReconciliationRequest(
  db: Database,
  itemId: string,
  workspaceId: string,
  token: string,
): void {
  run(db, (q) => deleteReconciliationRequestSteps(q, itemId, workspaceId, token));
}

export function* deleteReconciliationEffectSteps(q: Q, effect: ReconciliationEffect) {
  const { itemReconciliationEffect: e } = q.t;
  yield* q.exec(
    q.orm
      .delete(e)
      .where(and(eq(e.itemId, effect.itemId), eq(e.kind, effect.kind), eq(e.token, effect.token))),
  );
}

export function deleteReconciliationEffect(db: Database, effect: ReconciliationEffect): void {
  run(db, (q) => deleteReconciliationEffectSteps(q, effect));
}

export function* delegationReconciliationDueSteps(q: Q, itemId: string, refreshedBefore: number) {
  const { delegationReconciliation: r, workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ itemId: workItem.id })
      .from(workItem)
      .leftJoin(r, eq(r.delegationId, workItem.delegationId))
      .where(
        and(
          eq(workItem.id, itemId),
          or(
            isNull(r.reconciledAt),
            sql`${r.changes}>${r.reconciledChanges}`,
            lte(r.reconciledAt, refreshedBefore),
          ),
        ),
      ),
  );
  return row !== undefined;
}

export function delegationReconciliationDue(
  db: Database,
  itemId: string,
  refreshedBefore: number,
): boolean {
  return run(db, (q) => delegationReconciliationDueSteps(q, itemId, refreshedBefore));
}

export function* activeReconciliationTargetsSteps(q: Q, issue?: ReconciliationIssueChange) {
  const { i, s, w } = aliases(q);
  const parentIssue = sql.raw(parentIssueIdSql("i", q.dialect));
  const touched = issue
    ? [
        eq(s.organizationId, issue.organizationId),
        or(
          sql`${parentIssue}=${issue.issueId}`,
          sql`EXISTS(SELECT 1 FROM work_item hit WHERE hit.delegation_id=i.delegation_id AND hit.linear_issue_id=${issue.issueId})`,
          sql`EXISTS(SELECT 1 FROM task_block b WHERE b.blocker_linear_issue_id=${issue.issueId} AND i.delegation_id=(
            SELECT bi.delegation_id FROM work_item bi
            WHERE bi.linear_issue_id=b.blocked_linear_issue_id AND bi.state<>'cancelled'
            AND NOT EXISTS(SELECT 1 FROM work_item_specification p WHERE p.item_id=bi.id AND p.present=0)
            ORDER BY bi.created_at DESC, bi.id DESC LIMIT 1))`,
          ...(issue.parentIssueId ? [sql`${parentIssue}=${issue.parentIssueId}`] : []),
        ),
      ]
    : [];
  return yield* q.all(
    q.orm
      .selectDistinct({ itemId: i.id, workspaceId: w.id })
      .from(i)
      .innerJoin(s, eq(s.sessionId, i.sessionKey))
      .innerJoin(w, eq(w.linearOrganizationId, s.organizationId))
      .where(
        and(
          sql.raw(delegationHasOpenWork("i.delegation_id")),
          isNotNull(i.sessionKey),
          isNull(s.stoppedAt),
          ...touched,
        ),
      ),
  );
}

export function activeReconciliationTargets(
  db: Database,
  issue?: ReconciliationIssueChange,
): ReconciliationTarget[] {
  return run(db, (q) => activeReconciliationTargetsSteps(q, issue));
}

export function* listRelationItemsSteps(q: Q, scope: { blocked: boolean; itemId?: string }) {
  const { i, s, w } = aliases(q);
  const { itemDependencySnapshot: d, workItemSpecification: p } = q.t;
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
          sql.raw(delegationHasOpenWork("i.delegation_id")),
          isNull(s.stoppedAt),
          notInArray(i.state, FINISHED),
          sql`COALESCE(${p.present},1)=1`,
          ...(scope.blocked
            ? [
                eq(i.state, "queued"),
                sql`EXISTS(SELECT 1 FROM item_hold h WHERE h.item_id=i.id AND h.reason='blocked')`,
              ]
            : []),
          ...(scope.itemId === undefined ? [] : [eq(i.id, scope.itemId)]),
        ),
      )
      .orderBy(asc(i.id)),
  );
}

export function listRelationItems(
  db: Database,
  scope: { blocked: boolean; itemId?: string },
): RelationItem[] {
  return run(db, (q) => listRelationItemsSteps(q, scope));
}
