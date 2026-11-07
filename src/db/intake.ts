import type { Database } from "bun:sqlite";
import {
  and,
  asc,
  desc,
  eq,
  exists,
  inArray,
  isNotNull,
  isNull,
  like,
  ne,
  notExists,
  notInArray,
  sql,
  type SQL,
} from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import {
  delegationHasOpenWork,
  delegationIssueIdSql,
  parentTaskKeySql,
  type WorkItemState,
} from "../core";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonText } from "./json-text";

const FINISHED = ["completed", "merged", "cancelled"];

export type IntakeItemRow = {
  id: string;
  delegationId: string;
  linearIssueId: string;
  linearIdentifier: string;
  title: string;
  state: WorkItemState;
  branchName: string;
  position: number;
  version: number;
};

function jsonPath(q: Q, json: SQL, path: readonly string[]): SQL {
  return q.dialect === "sqlite"
    ? sql`json_extract(${json}, ${`$.${path.join(".")}`})`
    : sql`(${json} #>> ${`{${path.join(",")}}`})`;
}

export function* readDelegatedIntakeSteps(
  q: Q,
  linearIssueId: string,
  taskKey: string,
): Steps<{ delegationId: string; linearIdentifier: string; title: string } | null> {
  const { workItem } = q.t;
  const brief = sql`${workItem.brief}`;
  return (
    (yield* q.one(
      q.orm
        .select({
          delegationId: workItem.delegationId,
          linearIdentifier: sql<string>`COALESCE(${jsonPath(q, brief, ["epic", "identifier"])}, ${workItem.linearIdentifier})`,
          title: sql<string>`COALESCE(${jsonPath(q, brief, ["epic", "title"])}, ${workItem.title})`,
        })
        .from(workItem)
        .where(
          and(
            sql`${sql.raw(delegationIssueIdSql("work_item", q.dialect))} = ${linearIssueId}`,
            sql`${sql.raw(parentTaskKeySql("work_item", q.dialect))} = ${taskKey}`,
          ),
        )
        .orderBy(asc(workItem.createdAt), asc(workItem.id))
        .limit(1),
    )) ?? null
  );
}

export function readDelegatedIntake(
  db: Database,
  linearIssueId: string,
  taskKey: string,
): { delegationId: string; linearIdentifier: string; title: string } | null {
  return settled(sqliteDb(db).run((q) => readDelegatedIntakeSteps(q, linearIssueId, taskKey)));
}

export function* listDelegationItemsSteps(q: Q, delegationId: string): Steps<IntakeItemRow[]> {
  const { workItem } = q.t;
  return yield* q.all(
    q.orm
      .select({
        id: workItem.id,
        delegationId: workItem.delegationId,
        linearIssueId: workItem.linearIssueId,
        linearIdentifier: workItem.linearIdentifier,
        title: workItem.title,
        state: sql<WorkItemState>`${workItem.state}`,
        branchName: workItem.branchName,
        position: workItem.position,
        version: workItem.version,
      })
      .from(workItem)
      .where(eq(workItem.delegationId, delegationId))
      .orderBy(asc(workItem.position), asc(workItem.linearIdentifier)),
  );
}

export function listDelegationItems(db: Database, delegationId: string): IntakeItemRow[] {
  return settled(sqliteDb(db).run((q) => listDelegationItemsSteps(q, delegationId)));
}

type IntakeItem = Omit<IntakeItemRow, "state" | "version"> & {
  createdAt: number;
  brief: string | undefined;
  taskKey: string;
  sessionKey: string | null;
};

export function* insertIntakeItemSteps(q: Q, item: IntakeItem): Steps<void> {
  const brief =
    item.brief === undefined || q.dialect === "sqlite" ? item.brief : JSON.parse(item.brief);
  yield* q.exec(
    q.orm.insert(q.t.workItem).values({ ...item, brief, state: "queued", version: 0 }),
  );
}

export function insertIntakeItem(db: Database, item: IntakeItem): void {
  settled(sqliteDb(db).run((q) => insertIntakeItemSteps(q, item)));
}

export function* insertItemContinuationSteps(
  q: Q,
  itemId: string,
  previousItemId: string,
  branch: string,
): Steps<void> {
  yield* q.exec(q.orm.insert(q.t.itemContinuation).values({ itemId, previousItemId, branch }));
}

export function insertItemContinuation(
  db: Database,
  itemId: string,
  previousItemId: string,
  branch: string,
): void {
  settled(
    sqliteDb(db).run((q) => insertItemContinuationSteps(q, itemId, previousItemId, branch)),
  );
}

export function* stopSessionParentDelegationSteps(
  q: Q,
  sessionId: string,
  now: number,
): Steps<void> {
  const { parentDelegation, parentDelegationIssue } = q.t;
  yield* q.exec(
    q.orm
      .update(parentDelegationIssue)
      .set({ releasedAt: now })
      .where(
        and(
          isNull(parentDelegationIssue.releasedAt),
          inArray(
            parentDelegationIssue.parentDelegationId,
            q.orm
              .select({ delegationId: parentDelegation.delegationId })
              .from(parentDelegation)
              .where(
                and(eq(parentDelegation.sessionId, sessionId), isNull(parentDelegation.stoppedAt)),
              ),
          ),
        ),
      ),
  );
  yield* q.exec(
    q.orm
      .update(parentDelegation)
      .set({ stoppedAt: now })
      .where(and(eq(parentDelegation.sessionId, sessionId), isNull(parentDelegation.stoppedAt))),
  );
}

export function stopSessionParentDelegation(db: Database, sessionId: string, now: number): void {
  settled(sqliteDb(db).run((q) => stopSessionParentDelegationSteps(q, sessionId, now)));
}

type ActiveParentDelegation = {
  delegationId: string;
  parentIssueId: string;
  parentIdentifier: string;
  title: string;
};

export function* readActiveParentDelegationSteps(
  q: Q,
  parentIssueId: string,
): Steps<ActiveParentDelegation | null> {
  const { parentDelegation } = q.t;
  return (
    (yield* q.one(
      q.orm
        .select({
          delegationId: parentDelegation.delegationId,
          parentIssueId: parentDelegation.parentIssueId,
          parentIdentifier: parentDelegation.parentIdentifier,
          title: parentDelegation.title,
        })
        .from(parentDelegation)
        .where(
          and(
            eq(parentDelegation.parentIssueId, parentIssueId),
            isNull(parentDelegation.stoppedAt),
          ),
        )
        .orderBy(asc(parentDelegation.createdAt), asc(parentDelegation.delegationId))
        .limit(1),
    )) ?? null
  );
}

export function readActiveParentDelegation(
  db: Database,
  parentIssueId: string,
): ActiveParentDelegation | null {
  return settled(sqliteDb(db).run((q) => readActiveParentDelegationSteps(q, parentIssueId)));
}

type UnlandedAttempt = { id: string; linearIdentifier: string; branchName: string };

export function* readUnlandedAttemptSteps(
  q: Q,
  linearIssueId: string,
): Steps<UnlandedAttempt | null> {
  const { run, workItem } = q.t;
  return (
    (yield* q.one(
      q.orm
        .select({
          id: workItem.id,
          linearIdentifier: workItem.linearIdentifier,
          branchName: workItem.branchName,
        })
        .from(workItem)
        .where(
          and(
            eq(workItem.linearIssueId, linearIssueId),
            notInArray(workItem.state, ["merged", "completed"]),
            like(workItem.branchName, "paws/%"),
            exists(
              q.orm
                .select({ one: sql`1` })
                .from(run)
                .where(eq(run.itemId, workItem.id)),
            ),
          ),
        )
        .orderBy(desc(workItem.createdAt), desc(workItem.id))
        .limit(1),
    )) ?? null
  );
}

export function readUnlandedAttempt(db: Database, linearIssueId: string): UnlandedAttempt | null {
  return settled(sqliteDb(db).run((q) => readUnlandedAttemptSteps(q, linearIssueId)));
}

export function* emptyFailedAttemptsSteps(
  q: Q,
  issueId: string,
  sessionId: string,
): Steps<string[]> {
  const { job, linearConversation, linearSession, linearSessionCleanupBlock } = q.t;
  const { parentDelegationIssue, run, workItem } = q.t;
  const item = alias(workItem, "item");
  const sibling = alias(workItem, "sibling");
  const previous = alias(linearSession, "previous");
  const incoming = alias(linearSession, "incoming");
  const epicType =
    q.dialect === "sqlite"
      ? sql`json_type(${item.brief}, '$.epic')`
      : sql`jsonb_typeof(${item.brief} -> 'epic')`;
  const rows = yield* q.all(
    q.orm
      .select({ id: item.id })
      .from(item)
      .innerJoin(previous, eq(previous.sessionId, item.sessionKey))
      .innerJoin(
        incoming,
        and(
          eq(incoming.sessionId, sessionId),
          eq(incoming.organizationId, previous.organizationId),
          eq(incoming.oauthClientId, previous.oauthClientId),
          eq(incoming.appUserId, previous.appUserId),
          eq(incoming.teamId, previous.teamId),
        ),
      )
      .where(
        and(
          eq(item.linearIssueId, issueId),
          ne(item.sessionKey, incoming.sessionId),
          eq(item.state, "failed"),
          eq(item.cancelRequested, 1),
          isNull(item.currentRunId),
          isNull(item.checkpoint),
          notExists(
            q.orm
              .select({ one: sql`1` })
              .from(parentDelegationIssue)
              .where(eq(parentDelegationIssue.delegationId, item.delegationId)),
          ),
          sql`${epicType} = 'null'`,
          notExists(
            q.orm
              .select({ one: sql`1` })
              .from(sibling)
              .where(and(eq(sibling.delegationId, item.delegationId), ne(sibling.id, item.id))),
          ),
          notExists(
            q.orm
              .select({ one: sql`1` })
              .from(run)
              .where(eq(run.itemId, item.id)),
          ),
          notExists(
            q.orm
              .select({ one: sql`1` })
              .from(job)
              .where(
                and(
                  sql`${jsonPath(q, sql`${job.payload}`, ["itemId"])} = ${item.id}`,
                  inArray(job.status, ["pending", "running"]),
                ),
              ),
          ),
          notExists(
            q.orm
              .select({ one: sql`1` })
              .from(linearConversation)
              .where(and(eq(linearConversation.itemId, item.id), eq(linearConversation.blocked, 1))),
          ),
          notExists(
            q.orm
              .select({ one: sql`1` })
              .from(linearSessionCleanupBlock)
              .where(eq(linearSessionCleanupBlock.sessionId, item.sessionKey)),
          ),
        ),
      )
      .orderBy(asc(item.id)),
  );
  return rows.map((row) => row.id);
}

export function emptyFailedAttempts(db: Database, issueId: string, sessionId: string): string[] {
  return settled(sqliteDb(db).run((q) => emptyFailedAttemptsSteps(q, issueId, sessionId)));
}

export function* issueHasUnfinishedItemSteps(q: Q, linearIssueId: string): Steps<boolean> {
  const { workItem } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: workItem.id })
      .from(workItem)
      .where(and(eq(workItem.linearIssueId, linearIssueId), notInArray(workItem.state, FINISHED)))
      .limit(1),
  );
  return row !== undefined;
}

export function issueHasUnfinishedItem(db: Database, linearIssueId: string): boolean {
  return settled(sqliteDb(db).run((q) => issueHasUnfinishedItemSteps(q, linearIssueId)));
}

type ItemDelegation = { delegationId: string; issueId: string; cancelRequested: number };

export function* readItemDelegationSteps(q: Q, itemId: string): Steps<ItemDelegation | null> {
  const { workItem } = q.t;
  return (
    (yield* q.one(
      q.orm
        .select({
          delegationId: workItem.delegationId,
          issueId: workItem.linearIssueId,
          cancelRequested: workItem.cancelRequested,
        })
        .from(workItem)
        .where(eq(workItem.id, itemId)),
    )) ?? null
  );
}

export function readItemDelegation(db: Database, itemId: string): ItemDelegation | null {
  return settled(sqliteDb(db).run((q) => readItemDelegationSteps(q, itemId)));
}

export function* delegationWorkspaceIdSteps(
  q: Q,
  delegationId: string,
): Steps<string | undefined> {
  const { linearSession, workItem, workspace } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: workspace.id })
      .from(workspace)
      .innerJoin(linearSession, eq(linearSession.organizationId, workspace.linearOrganizationId))
      .innerJoin(workItem, eq(workItem.sessionKey, linearSession.sessionId))
      .where(eq(workItem.delegationId, delegationId))
      .limit(1),
  );
  return row?.id;
}

export function delegationWorkspaceId(db: Database, delegationId: string): string | undefined {
  return settled(sqliteDb(db).run((q) => delegationWorkspaceIdSteps(q, delegationId)));
}

export type PublicationIdentity = {
  delegationId: string;
  workspaceId: string;
  checkpoint: string | null;
  runId: string;
  agent: string;
  runKind: string;
  runStatus: string;
  specificationHash: string;
  specificationRevision: number;
  sessionId: string;
  sessionGeneration: number;
  organizationId: string;
  teamId: string;
  clientId: string;
  appUserId: string;
  creatorId: string | null;
  actorId: string | null;
};

export function* readPublicationIdentitySteps(
  q: Q,
  itemId: string,
): Steps<PublicationIdentity | null> {
  const { linearSession, run, workItem, workItemSpecification, workspace, workspaceUser } = q.t;
  const i = alias(workItem, "i");
  const p = alias(workItemSpecification, "p");
  const r = alias(run, "r");
  const s = alias(linearSession, "s");
  const w = alias(workspace, "w");
  const owner = q.orm
    .select({ id: workspaceUser.linearUserId })
    .from(workspaceUser)
    .where(eq(workspaceUser.id, i.ownerUserId));
  const row = yield* q.one(
    q.orm
      .select({
        delegationId: i.delegationId,
        workspaceId: w.id,
        checkpoint: jsonText(q, i.checkpoint),
        runId: r.id,
        agent: r.agent,
        runKind: r.kind,
        runStatus: r.status,
        specificationHash: p.hash,
        specificationRevision: p.revision,
        sessionId: s.sessionId,
        sessionGeneration: s.generation,
        organizationId: s.organizationId,
        teamId: s.teamId,
        clientId: s.oauthClientId,
        appUserId: s.appUserId,
        creatorId: s.creatorId,
        actorId: sql<string | null>`COALESCE((${owner}), ${i.delegatedBy}, ${s.creatorId})`,
      })
      .from(i)
      .innerJoin(p, and(eq(p.itemId, i.id), eq(p.present, 1)))
      .innerJoin(r, and(eq(r.id, i.currentRunId), eq(r.itemId, i.id)))
      .innerJoin(s, eq(s.sessionId, i.sessionKey))
      .innerJoin(w, eq(w.linearOrganizationId, s.organizationId))
      .where(
        and(
          eq(i.id, itemId),
          inArray(i.state, ["verifying", "merge_queue"]),
          eq(i.cancelRequested, 0),
          sql.raw(delegationHasOpenWork("i.delegation_id")),
          isNull(s.stoppedAt),
          isNotNull(s.teamId),
          isNotNull(s.appUserId),
          isNotNull(s.oauthClientId),
        ),
      ),
  );
  return (row as PublicationIdentity | undefined) ?? null;
}

export function readPublicationIdentity(db: Database, itemId: string): PublicationIdentity | null {
  return settled(sqliteDb(db).run((q) => readPublicationIdentitySteps(q, itemId)));
}
