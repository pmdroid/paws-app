import { and, asc, eq, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import type { TaskMode, WorkItemState } from "../core";
import { type Q, type Steps, type Db } from "./db";
import type { ManagedBlockerItem } from "./item-dependencies";
import { jsonValue, parsedJson } from "./json-text";

export type ParentDelegationRow<Edge> = {
  delegationId: string;
  workspaceId: string;
  organizationId: string;
  sessionId: string;
  ownerUserId: string;
  edges: Edge[];
  stoppedAt: number | null;
};

export type ParentSubIssueRow = {
  parentDelegationId: string;
  issueId: string;
  identifier: string;
  title: string;
  url: string | null;
  sessionId: string | null;
  delegationId: string | null;
};

function subColumns(q: Q) {
  const { parentDelegationIssue: c } = q.t;
  return {
    parentDelegationId: c.parentDelegationId,
    issueId: c.issueId,
    identifier: c.identifier,
    title: c.title,
    url: c.url,
    sessionId: c.sessionId,
    delegationId: c.delegationId,
  };
}

export function* readParentDelegationSteps<Edge>(
  q: Q,
  delegationId: string,
): Steps<ParentDelegationRow<Edge> | null> {
  const { parentDelegation: p } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        delegationId: p.delegationId,
        workspaceId: p.workspaceId,
        organizationId: p.organizationId,
        sessionId: p.sessionId,
        ownerUserId: p.ownerUserId,
        edges: p.edges,
        stoppedAt: p.stoppedAt,
      })
      .from(p)
      .where(eq(p.delegationId, delegationId)),
  );
  return row ? { ...row, edges: parsedJson<Edge[]>(q, row.edges) } : null;
}

export async function readParentDelegation<Edge>(
  store: Db,
  delegationId: string,
): Promise<ParentDelegationRow<Edge> | null> {
  return store.run((q) => readParentDelegationSteps(q, delegationId));
}

export function* listParentSubIssuesSteps(q: Q, parentDelegationId: string) {
  const { parentDelegationIssue: c } = q.t;
  return yield* q.all(
    q.orm
      .select(subColumns(q))
      .from(c)
      .where(and(eq(c.parentDelegationId, parentDelegationId), isNull(c.releasedAt)))
      .orderBy(asc(c.position), asc(c.issueId)),
  );
}

export async function listParentSubIssues(
  store: Db,
  parentDelegationId: string,
): Promise<ParentSubIssueRow[]> {
  return store.run((q) => listParentSubIssuesSteps(q, parentDelegationId));
}

export function* parentSubIssueForSessionSteps(q: Q, sessionId: string) {
  const { parentDelegationIssue: c } = q.t;
  return (
    (yield* q.one(
      q.orm
        .select(subColumns(q))
        .from(c)
        .where(and(eq(c.sessionId, sessionId), isNull(c.releasedAt))),
    )) ?? null
  );
}

export async function parentSubIssueForSession(
  store: Db,
  sessionId: string,
): Promise<ParentSubIssueRow | null> {
  return store.run((q) => parentSubIssueForSessionSteps(q, sessionId));
}

export function* activeParentSubIssueSteps(q: Q, issueId: string, organizationId: string) {
  const { parentDelegationIssue: c, workspace: w } = q.t;
  return (
    (yield* q.one(
      q.orm
        .select(subColumns(q))
        .from(c)
        .innerJoin(w, eq(w.id, c.workspaceId))
        .where(
          and(
            eq(c.issueId, issueId),
            isNull(c.releasedAt),
            eq(w.linearOrganizationId, organizationId),
          ),
        ),
    )) ?? null
  );
}

export async function activeParentSubIssue(
  store: Db,
  issueId: string,
  organizationId: string,
): Promise<ParentSubIssueRow | null> {
  return store.run((q) => activeParentSubIssueSteps(q, issueId, organizationId));
}

export function* parentSubIssueActiveSteps(q: Q, workspaceId: string, issueId: string) {
  const { parentDelegationIssue: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(c)
      .where(and(eq(c.workspaceId, workspaceId), eq(c.issueId, issueId), isNull(c.releasedAt))),
  );
  return row !== undefined;
}

export async function parentSubIssueActive(
  store: Db,
  workspaceId: string,
  issueId: string,
): Promise<boolean> {
  return store.run((q) => parentSubIssueActiveSteps(q, workspaceId, issueId));
}

export function* parentSubIssueIdentifierSteps(
  q: Q,
  parentDelegationId: string,
  issueId: string,
): Steps<string | undefined> {
  const { parentDelegationIssue: c } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ identifier: c.identifier })
      .from(c)
      .where(and(eq(c.parentDelegationId, parentDelegationId), eq(c.issueId, issueId))),
  );
  return row?.identifier;
}

export async function parentSubIssueIdentifier(
  store: Db,
  parentDelegationId: string,
  issueId: string,
): Promise<string | undefined> {
  return store.run((q) => parentSubIssueIdentifierSteps(q, parentDelegationId, issueId));
}

export function* parentDelegationActiveSteps(q: Q, workspaceId: string, parentIssueId: string) {
  const { parentDelegation: p } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(p)
      .where(
        and(
          eq(p.workspaceId, workspaceId),
          eq(p.parentIssueId, parentIssueId),
          isNull(p.stoppedAt),
        ),
      ),
  );
  return row !== undefined;
}

export async function parentDelegationActive(
  store: Db,
  workspaceId: string,
  parentIssueId: string,
): Promise<boolean> {
  return store.run((q) => parentDelegationActiveSteps(q, workspaceId, parentIssueId));
}

export function* listActiveParentDelegationIdsSteps(q: Q) {
  const { parentDelegation: p } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: p.delegationId })
      .from(p)
      .where(isNull(p.stoppedAt))
      .orderBy(asc(p.createdAt)),
  );
  return rows.map((row) => row.id);
}

export async function listActiveParentDelegationIds(store: Db): Promise<string[]> {
  return store.run((q) => listActiveParentDelegationIdsSteps(q));
}

type NewParentDelegation<Edge> = {
  delegationId: string;
  workspaceId: string;
  organizationId: string;
  parentIssueId: string;
  parentIdentifier: string;
  title: string;
  sessionId: string;
  ownerUserId: string;
  edges: readonly Edge[];
  createdAt: number;
};

export function* insertParentDelegationSteps<Edge>(q: Q, parent: NewParentDelegation<Edge>) {
  yield* q.exec(
    q.orm
      .insert(q.t.parentDelegation)
      .values({ ...parent, edges: jsonValue(q, parent.edges) as Edge[] }),
  );
}

export async function insertParentDelegation<Edge>(store: Db, parent: NewParentDelegation<Edge>) {
  return store.run((q) => insertParentDelegationSteps(q, parent));
}

type NewParentSubIssue = {
  parentDelegationId: string;
  workspaceId: string;
  issueId: string;
  identifier: string;
  title: string;
  url: string | null;
  position: number;
};

export function* insertParentSubIssueSteps(q: Q, sub: NewParentSubIssue) {
  yield* q.exec(q.orm.insert(q.t.parentDelegationIssue).values(sub));
}

export async function insertParentSubIssue(store: Db, sub: NewParentSubIssue): Promise<void> {
  await store.run((q) => insertParentSubIssueSteps(q, sub));
}

export function* claimParentSubIssueSessionSteps(
  q: Q,
  parentDelegationId: string,
  issueId: string,
  sessionId: string,
) {
  const { parentDelegationIssue: c } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(c)
      .set({ sessionId })
      .where(
        and(
          eq(c.parentDelegationId, parentDelegationId),
          eq(c.issueId, issueId),
          isNull(c.sessionId),
          isNull(c.releasedAt),
        ),
      )
      .returning({ issueId: c.issueId }),
  );
  return rows.length;
}

export async function claimParentSubIssueSession(
  store: Db,
  parentDelegationId: string,
  issueId: string,
  sessionId: string,
): Promise<number> {
  return store.run((q) =>
    claimParentSubIssueSessionSteps(q, parentDelegationId, issueId, sessionId),
  );
}

export function* moveParentSubIssueSessionSteps(
  q: Q,
  move: { parentDelegationId: string; issueId: string; from: string; to: string },
) {
  const { parentDelegationIssue: c } = q.t;
  yield* q.exec(
    q.orm
      .update(c)
      .set({ sessionId: move.to, delegationId: null })
      .where(
        and(
          eq(c.parentDelegationId, move.parentDelegationId),
          eq(c.issueId, move.issueId),
          eq(c.sessionId, move.from),
        ),
      ),
  );
}

export async function moveParentSubIssueSession(
  store: Db,
  move: { parentDelegationId: string; issueId: string; from: string; to: string },
): Promise<void> {
  await store.run((q) => moveParentSubIssueSessionSteps(q, move));
}

export function* setParentSubIssueDelegationSteps(q: Q, sessionId: string, delegationId: string) {
  const { parentDelegationIssue: c } = q.t;
  yield* q.exec(q.orm.update(c).set({ delegationId }).where(eq(c.sessionId, sessionId)));
}

export async function setParentSubIssueDelegation(
  store: Db,
  sessionId: string,
  delegationId: string,
): Promise<void> {
  await store.run((q) => setParentSubIssueDelegationSteps(q, sessionId, delegationId));
}

export function* setParentDelegationErrorSteps(
  q: Q,
  delegationId: string,
  lastError: string | null,
) {
  const { parentDelegation: p } = q.t;
  yield* q.exec(q.orm.update(p).set({ lastError }).where(eq(p.delegationId, delegationId)));
}

export async function setParentDelegationError(
  store: Db,
  delegationId: string,
  lastError: string | null,
): Promise<void> {
  await store.run((q) => setParentDelegationErrorSteps(q, delegationId, lastError));
}

export function* listIssueBlockerItemsSteps(q: Q, workspaceId: string, issueId: string) {
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
          eq(workspace.id, workspaceId),
          eq(workItem.linearIssueId, issueId),
          ne(workItem.state, "cancelled"),
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

export async function listIssueBlockerItems(
  store: Db,
  workspaceId: string,
  issueId: string,
): Promise<ManagedBlockerItem[]> {
  return store.run((q) => listIssueBlockerItemsSteps(q, workspaceId, issueId));
}

export function* workspaceIssueHasOpenItemSteps(q: Q, workspaceId: string, issueId: string) {
  const { linearSession, workItem, workspace } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workItem)
      .innerJoin(linearSession, eq(linearSession.sessionId, workItem.sessionKey))
      .innerJoin(workspace, eq(workspace.linearOrganizationId, linearSession.organizationId))
      .where(
        and(
          eq(workspace.id, workspaceId),
          eq(workItem.linearIssueId, issueId),
          notInArray(workItem.state, ["completed", "merged", "cancelled"]),
        ),
      )
      .limit(1),
  );
  return row !== undefined;
}

export async function workspaceIssueHasOpenItem(
  store: Db,
  workspaceId: string,
  issueId: string,
): Promise<boolean> {
  return store.run((q) => workspaceIssueHasOpenItemSteps(q, workspaceId, issueId));
}

export function* delegationHasLiveItemSteps(q: Q, delegationId: string) {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(workItem)
      .where(
        and(
          eq(workItem.delegationId, delegationId),
          notInArray(workItem.state, ["failed", "cancelled"]),
        ),
      ),
  );
  return row !== undefined;
}

export async function delegationHasLiveItem(store: Db, delegationId: string): Promise<boolean> {
  return store.run((q) => delegationHasLiveItemSteps(q, delegationId));
}

export function* listFailedDelegationItemIdsSteps(q: Q, delegationId: string) {
  const { workItem } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ id: workItem.id })
      .from(workItem)
      .where(and(eq(workItem.delegationId, delegationId), inArray(workItem.state, ["failed"]))),
  );
  return rows.map((row) => row.id);
}

export async function listFailedDelegationItemIds(
  store: Db,
  delegationId: string,
): Promise<string[]> {
  return store.run((q) => listFailedDelegationItemIdsSteps(q, delegationId));
}

export function* setItemOwnerSteps(q: Q, itemId: string, ownerUserId: string) {
  const { workItem } = q.t;
  yield* q.exec(q.orm.update(workItem).set({ ownerUserId }).where(eq(workItem.id, itemId)));
}

export async function setItemOwner(store: Db, itemId: string, ownerUserId: string): Promise<void> {
  await store.run((q) => setItemOwnerSteps(q, itemId, ownerUserId));
}
