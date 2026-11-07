import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, exists, inArray, isNull, like, notInArray, sql } from "drizzle-orm";
import {
  delegationHasOpenWork,
  delegationIssueIdSql,
  parentTaskKeySql,
  type WorkItemState,
} from "../core";
import { orm } from "./orm";
import { itemContinuation, parentDelegation, parentDelegationIssue, run, workItem } from "./schema";

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

export function readDelegatedIntake(
  db: Database,
  linearIssueId: string,
  taskKey: string,
): { delegationId: string; linearIdentifier: string; title: string } | null {
  return (
    orm(db).all<{ delegationId: string; linearIdentifier: string; title: string }>(
      sql`SELECT delegation_id AS delegationId,
              COALESCE(json_extract(brief, '$.epic.identifier'), linear_identifier) AS linearIdentifier,
              COALESCE(json_extract(brief, '$.epic.title'), title) AS title
       FROM work_item
       WHERE ${sql.raw(delegationIssueIdSql("work_item"))} = ${linearIssueId}
         AND ${sql.raw(parentTaskKeySql("work_item"))} = ${taskKey}
       ORDER BY created_at, id
       LIMIT 1`,
    )[0] ?? null
  );
}

export function listDelegationItems(db: Database, delegationId: string): IntakeItemRow[] {
  return orm(db)
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
    .orderBy(asc(workItem.position), asc(workItem.linearIdentifier))
    .all();
}

export function insertIntakeItem(
  db: Database,
  item: Omit<IntakeItemRow, "state" | "version"> & {
    createdAt: number;
    brief: string | undefined;
    taskKey: string;
    sessionKey: string | null;
  },
): void {
  orm(db)
    .insert(workItem)
    .values({ ...item, state: "queued", version: 0 })
    .run();
}

export function insertItemContinuation(
  db: Database,
  itemId: string,
  previousItemId: string,
  branch: string,
): void {
  orm(db).insert(itemContinuation).values({ itemId, previousItemId, branch }).run();
}

export function stopSessionParentDelegation(db: Database, sessionId: string, now: number): void {
  const handle = orm(db);
  handle
    .update(parentDelegationIssue)
    .set({ releasedAt: now })
    .where(
      and(
        isNull(parentDelegationIssue.releasedAt),
        inArray(
          parentDelegationIssue.parentDelegationId,
          handle
            .select({ delegationId: parentDelegation.delegationId })
            .from(parentDelegation)
            .where(
              and(eq(parentDelegation.sessionId, sessionId), isNull(parentDelegation.stoppedAt)),
            ),
        ),
      ),
    )
    .run();
  handle
    .update(parentDelegation)
    .set({ stoppedAt: now })
    .where(and(eq(parentDelegation.sessionId, sessionId), isNull(parentDelegation.stoppedAt)))
    .run();
}

export function readActiveParentDelegation(
  db: Database,
  parentIssueId: string,
): { delegationId: string; parentIssueId: string; parentIdentifier: string; title: string } | null {
  return (
    orm(db)
      .select({
        delegationId: parentDelegation.delegationId,
        parentIssueId: parentDelegation.parentIssueId,
        parentIdentifier: parentDelegation.parentIdentifier,
        title: parentDelegation.title,
      })
      .from(parentDelegation)
      .where(
        and(eq(parentDelegation.parentIssueId, parentIssueId), isNull(parentDelegation.stoppedAt)),
      )
      .orderBy(asc(parentDelegation.createdAt), asc(parentDelegation.delegationId))
      .limit(1)
      .get() ?? null
  );
}

export function readUnlandedAttempt(
  db: Database,
  linearIssueId: string,
): { id: string; linearIdentifier: string; branchName: string } | null {
  const handle = orm(db);
  return (
    handle
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
            handle
              .select({ one: sql`1` })
              .from(run)
              .where(eq(run.itemId, workItem.id)),
          ),
        ),
      )
      .orderBy(desc(workItem.createdAt), desc(workItem.id))
      .limit(1)
      .get() ?? null
  );
}

export function emptyFailedAttempts(db: Database, issueId: string, sessionId: string): string[] {
  return orm(db)
    .all<{ id: string }>(
      sql`SELECT item.id FROM work_item item
       JOIN linear_session previous ON previous.session_id = item.session_key
       JOIN linear_session incoming ON incoming.session_id = ${sessionId}
         AND incoming.organization_id = previous.organization_id
         AND incoming.oauth_client_id = previous.oauth_client_id
         AND incoming.app_user_id = previous.app_user_id
         AND incoming.team_id = previous.team_id
       WHERE item.linear_issue_id = ${issueId} AND item.session_key != incoming.session_id
         AND item.state = 'failed' AND item.cancel_requested = 1
         AND item.current_run_id IS NULL AND item.checkpoint IS NULL
         AND NOT EXISTS (SELECT 1 FROM parent_delegation_issue sub
           WHERE sub.delegation_id = item.delegation_id)
         AND json_type(item.brief, '$.epic') = 'null'
         AND NOT EXISTS (SELECT 1 FROM work_item sibling
           WHERE sibling.delegation_id = item.delegation_id AND sibling.id != item.id)
         AND NOT EXISTS (SELECT 1 FROM run WHERE item_id = item.id)
         AND NOT EXISTS (SELECT 1 FROM job
           WHERE json_extract(payload, '$.itemId') = item.id AND status IN ('pending', 'running'))
         AND NOT EXISTS (SELECT 1 FROM linear_conversation WHERE item_id = item.id AND blocked = 1)
         AND NOT EXISTS (SELECT 1 FROM linear_session_cleanup_block
           WHERE session_id = item.session_key)`,
    )
    .map((row) => row.id);
}

export function issueHasUnfinishedItem(db: Database, linearIssueId: string): boolean {
  return (
    orm(db)
      .select({ id: workItem.id })
      .from(workItem)
      .where(and(eq(workItem.linearIssueId, linearIssueId), notInArray(workItem.state, FINISHED)))
      .limit(1)
      .get() !== undefined
  );
}

export function readItemDelegation(
  db: Database,
  itemId: string,
): { delegationId: string; issueId: string; cancelRequested: number } | null {
  return (
    orm(db)
      .select({
        delegationId: workItem.delegationId,
        issueId: workItem.linearIssueId,
        cancelRequested: workItem.cancelRequested,
      })
      .from(workItem)
      .where(eq(workItem.id, itemId))
      .get() ?? null
  );
}

export function delegationWorkspaceId(db: Database, delegationId: string): string | undefined {
  return orm(db).all<{ id: string }>(
    sql`SELECT w.id FROM workspace w JOIN linear_session s ON s.organization_id=w.linear_organization_id JOIN work_item i ON i.session_key=s.session_id WHERE i.delegation_id=${delegationId} LIMIT 1`,
  )[0]?.id;
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

export function readPublicationIdentity(db: Database, itemId: string): PublicationIdentity | null {
  return (
    orm(db).all<PublicationIdentity>(
      sql`SELECT i.delegation_id AS delegationId,w.id AS workspaceId,i.checkpoint,
         r.id AS runId,r.agent,r.kind AS runKind,r.status AS runStatus,
         p.hash AS specificationHash,p.revision AS specificationRevision,
         s.session_id AS sessionId,s.generation AS sessionGeneration,
         s.organization_id AS organizationId,s.team_id AS teamId,s.oauth_client_id AS clientId,
         s.app_user_id AS appUserId,s.creator_id AS creatorId,
         COALESCE((SELECT u.linear_user_id FROM workspace_user u WHERE u.id=i.owner_user_id), i.delegated_by, s.creator_id) AS actorId
         FROM work_item i JOIN work_item_specification p ON p.item_id=i.id AND p.present=1
         JOIN run r ON r.id=i.current_run_id AND r.item_id=i.id
         JOIN linear_session s ON s.session_id=i.session_key
         JOIN workspace w ON w.linear_organization_id=s.organization_id
         WHERE i.id=${itemId} AND i.state IN ('verifying','merge_queue') AND i.cancel_requested=0
         AND ${sql.raw(delegationHasOpenWork("i.delegation_id"))}
         AND s.stopped_at IS NULL AND s.team_id IS NOT NULL
         AND s.app_user_id IS NOT NULL AND s.oauth_client_id IS NOT NULL`,
    )[0] ?? null
  );
}
