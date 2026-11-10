import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, isNull, lte, ne, notExists, notInArray, sql } from "drizzle-orm";
import { delegationIssueIdSql, parentTaskKeySql } from "../core";
import { settled, sqliteDb, type Q, type Steps, type Db } from "./db";
import { hasTableSteps } from "./linear-session-url";

function run<T>(db: Database, steps: (q: Q) => Steps<T>): T {
  return settled(sqliteDb(db).run(steps));
}

export function* itemOwnerUserIdSteps(q: Q, itemId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm.select({ owner: workItem.ownerUserId }).from(workItem).where(eq(workItem.id, itemId)),
  );
  return row?.owner ?? null;
}

export function itemOwnerUserId(db: Database, itemId: string): string | null {
  return run(db, (q) => itemOwnerUserIdSteps(q, itemId));
}

export function* assignUnownedItemSteps(q: Q, itemId: string, ownerUserId: string) {
  const { workItem } = q.t;
  yield* q.exec(
    q.orm
      .update(workItem)
      .set({ ownerUserId })
      .where(and(eq(workItem.id, itemId), isNull(workItem.ownerUserId))),
  );
}

export function assignUnownedItem(db: Database, itemId: string, ownerUserId: string): void {
  run(db, (q) => assignUnownedItemSteps(q, itemId, ownerUserId));
}

export function* setItemBranchNameSteps(q: Q, itemId: string, branchName: string) {
  const { workItem } = q.t;
  yield* q.exec(q.orm.update(workItem).set({ branchName }).where(eq(workItem.id, itemId)));
}

export async function setItemBranchName(
  store: Db,
  itemId: string,
  branchName: string,
): Promise<void> {
  await store.run((q) => setItemBranchNameSteps(q, itemId, branchName));
}

export function* clearItemRecoverySteps(q: Q, itemId: string) {
  const { workItem } = q.t;
  yield* q.exec(
    q.orm
      .update(workItem)
      .set({ cancelRequested: 0, recoveryAttempts: 0 })
      .where(eq(workItem.id, itemId)),
  );
}

export function clearItemRecovery(db: Database, itemId: string): void {
  run(db, (q) => clearItemRecoverySteps(q, itemId));
}

export function* bumpItemVersionSteps(q: Q, itemId: string) {
  const { workItem } = q.t;
  yield* q.exec(
    q.orm
      .update(workItem)
      .set({ version: sql`${workItem.version} + 1` })
      .where(eq(workItem.id, itemId)),
  );
}

export function bumpItemVersion(db: Database, itemId: string): void {
  run(db, (q) => bumpItemVersionSteps(q, itemId));
}

type SessionMove = { delegationId: string; from: string; to: string };

export function* moveDelegationSessionSteps(q: Q, move: SessionMove) {
  const { workItem } = q.t;
  yield* q.exec(
    q.orm
      .update(workItem)
      .set({ sessionKey: move.to })
      .where(and(eq(workItem.delegationId, move.delegationId), eq(workItem.sessionKey, move.from))),
  );
}

export function moveDelegationSession(db: Database, move: SessionMove): void {
  run(db, (q) => moveDelegationSessionSteps(q, move));
}

export function* issueOpenInOtherSessionSteps(q: Q, issueId: string, sessionId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workItem)
      .where(
        and(
          eq(workItem.linearIssueId, issueId),
          ne(workItem.sessionKey, sessionId),
          notInArray(workItem.state, ["completed", "merged", "cancelled"]),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export async function issueOpenInOtherSession(
  store: Db,
  issueId: string,
  sessionId: string,
): Promise<boolean> {
  return store.run((q) => issueOpenInOtherSessionSteps(q, issueId, sessionId));
}

export function* itemContinuedSteps(q: Q, previousItemId: string) {
  const { itemContinuation, workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(itemContinuation)
      .innerJoin(workItem, eq(workItem.id, itemContinuation.itemId))
      .where(
        and(eq(itemContinuation.previousItemId, previousItemId), ne(workItem.state, "cancelled")),
      ),
  );
  return row !== undefined;
}

export async function itemContinued(store: Db, previousItemId: string): Promise<boolean> {
  return store.run((q) => itemContinuedSteps(q, previousItemId));
}

export function* listItemIdsSteps(q: Q, includeArchived: boolean) {
  const { workItem, workItemSpecification } = q.t;
  const archived =
    !includeArchived && (yield* hasTableSteps(q, "work_item_specification"))
      ? notExists(
          q.orm
            .select({ one: sql`1` })
            .from(workItemSpecification)
            .where(
              and(
                eq(workItemSpecification.itemId, workItem.id),
                eq(workItemSpecification.present, 0),
              ),
            ),
        )
      : undefined;
  const rows = yield* q.all(q.orm.select({ id: workItem.id }).from(workItem).where(archived));
  return rows.map((row) => row.id);
}

export function listItemIds(db: Database, includeArchived: boolean): string[] {
  return run(db, (q) => listItemIdsSteps(q, includeArchived));
}

export function* itemParentTaskKeySteps(q: Q, itemId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ taskKey: sql<string | null>`${sql.raw(parentTaskKeySql("work_item", q.dialect))}` })
      .from(workItem)
      .where(eq(workItem.id, itemId)),
  );
  return row?.taskKey ?? null;
}

export function itemParentTaskKey(db: Database, itemId: string): string | null {
  return run(db, (q) => itemParentTaskKeySteps(q, itemId));
}

export function* itemDelegationIssueIdSteps(q: Q, itemId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        issueId: sql<string | null>`${sql.raw(delegationIssueIdSql("work_item", q.dialect))}`,
      })
      .from(workItem)
      .where(eq(workItem.id, itemId)),
  );
  return row?.issueId ?? null;
}

export async function itemDelegationIssueId(store: Db, itemId: string): Promise<string | null> {
  return store.run((q) => itemDelegationIssueIdSteps(q, itemId));
}

export function* recentRepositoryNamesSteps(q: Q, limit: number) {
  const { workItem, workItemRepository } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        name: sql<string>`lower(${workItemRepository.owner} || '/' || ${workItemRepository.repo})`,
      })
      .from(workItemRepository)
      .innerJoin(workItem, eq(workItem.id, workItemRepository.itemId))
      .orderBy(desc(workItem.createdAt))
      .limit(limit),
  );
  return rows.map((row) => row.name);
}

export async function recentRepositoryNames(store: Db, limit: number): Promise<string[]> {
  return store.run((q) => recentRepositoryNamesSteps(q, limit));
}

export function* latestRestartEventSteps(q: Q, itemId: string) {
  const { workItemEvent } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ reason: workItemEvent.reason, version: workItemEvent.version })
      .from(workItemEvent)
      .where(and(eq(workItemEvent.itemId, itemId), eq(workItemEvent.kind, "restart")))
      .orderBy(desc(workItemEvent.id))
      .limit(1),
  );
  return row ? { reason: row.reason!, version: row.version } : null;
}

export function latestRestartEvent(
  db: Database,
  itemId: string,
): { reason: string; version: number } | null {
  return run(db, (q) => latestRestartEventSteps(q, itemId));
}

/** The parent task key of the delegation's first item. */
export function* delegationParentTaskKeySteps(q: Q, delegationId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ taskKey: sql<string | null>`${sql.raw(parentTaskKeySql("work_item", q.dialect))}` })
      .from(workItem)
      .where(eq(workItem.delegationId, delegationId))
      .orderBy(asc(workItem.createdAt), asc(workItem.position), asc(workItem.id))
      .limit(1),
  );
  return row?.taskKey ?? null;
}

export async function delegationParentTaskKey(
  store: Db,
  delegationId: string,
): Promise<string | null> {
  return store.run((q) => delegationParentTaskKeySteps(q, delegationId));
}

/** Whether an item other than `itemId` that has not ended is on this branch. */
export function* branchHeldByOtherItemSteps(q: Q, branchName: string, itemId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workItem)
      .where(
        and(
          eq(workItem.branchName, branchName),
          ne(workItem.id, itemId),
          notInArray(workItem.state, ["completed", "merged", "cancelled"]),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export async function branchHeldByOtherItem(
  store: Db,
  branchName: string,
  itemId: string,
): Promise<boolean> {
  return store.run((q) => branchHeldByOtherItemSteps(q, branchName, itemId));
}

/** Every item delegated from this Linear issue, newest first. */
export function* itemsForLinearIssueSteps(q: Q, issueId: string) {
  const { workItem } = q.t;
  return yield* q.all(
    q.orm
      .select({ id: workItem.id, state: workItem.state, createdAt: workItem.createdAt })
      .from(workItem)
      .where(eq(workItem.linearIssueId, issueId))
      .orderBy(desc(workItem.createdAt), asc(workItem.id)),
  );
}

export async function itemsForLinearIssue(
  store: Db,
  issueId: string,
): Promise<{ id: string; state: string; createdAt: number }[]> {
  return store.run((q) => itemsForLinearIssueSteps(q, issueId));
}

/** The issue's items created by `createdBy`, oldest first, with each one's Linear organization. */
export function* issueItemsCreatedBySteps(q: Q, issueId: string, createdBy: number) {
  const { linearSession, workItem } = q.t;
  return yield* q.all(
    q.orm
      .select({
        id: workItem.id,
        identifier: workItem.linearIdentifier,
        state: workItem.state,
        sessionKey: workItem.sessionKey,
        organizationId: linearSession.organizationId,
      })
      .from(workItem)
      .leftJoin(linearSession, eq(linearSession.sessionId, workItem.sessionKey))
      .where(and(eq(workItem.linearIssueId, issueId), lte(workItem.createdAt, createdBy)))
      .orderBy(asc(workItem.createdAt), asc(workItem.id)),
  );
}

export async function issueItemsCreatedBy(
  store: Db,
  issueId: string,
  createdBy: number,
): Promise<
  {
    id: string;
    identifier: string;
    state: string;
    sessionKey: string | null;
    organizationId: string | null;
  }[]
> {
  return store.run((q) => issueItemsCreatedBySteps(q, issueId, createdBy));
}
