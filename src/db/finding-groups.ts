import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { orm } from "./orm";
import { settled, sqliteDb, type Q } from "./db";
import { jsonValue } from "./json-text";
import {
  findingGroup,
  findingGroupingOff,
  findingGroupRun,
  linearSession,
  reviewFindingItem,
  workItem,
  workspace,
  workspaceMember,
} from "./schema";
import { workspaceMemberUsableSql } from "./workspace";

export type FindingGroup = {
  id: string;
  workspaceId: string;
  repository: string;
  teamId: string;
  title: string;
  summary: string;
  scope: string;
  suggestedIssue: string | null;
  memberIds: number[];
  createdAt: number;
  runId: string;
  status: "open" | "filed" | "added" | "dismissed";
  statusReason: string | null;
  filedIssue: string | null;
  action: "file" | "add" | "dismiss" | null;
};
export type FindingGroupRun = {
  id: string;
  startedAt: number;
  finishedAt: number | null;
  status: "running" | "completed" | "failed";
  tokens: number | null;
  groupCount: number;
  error: string | null;
  skipReason?: string | null;
};
const groupColumns = {
  id: findingGroup.id,
  workspaceId: findingGroup.workspaceId,
  repository: findingGroup.repository,
  teamId: findingGroup.teamId,
  title: findingGroup.title,
  summary: findingGroup.summary,
  scope: findingGroup.scope,
  suggestedIssue: findingGroup.suggestedIssue,
  members: findingGroup.memberIds,
  createdAt: findingGroup.createdAt,
  runId: findingGroup.runId,
  status: sql<FindingGroup["status"]>`${findingGroup.status}`,
  statusReason: findingGroup.statusReason,
  filedIssue: findingGroup.filedIssue,
  action: sql<FindingGroup["action"]>`${findingGroup.action}`,
};

export function listFindingGroups(db: Database, workspaceId: string, limit = -1): FindingGroup[] {
  return orm(db)
    .select(groupColumns)
    .from(findingGroup)
    .where(eq(findingGroup.workspaceId, workspaceId))
    .orderBy(
      sql`(${findingGroup.status}='open') DESC`,
      desc(findingGroup.createdAt),
      findingGroup.id,
    )
    .limit(limit)
    .all()
    .map(({ members, ...row }) => ({ ...row, memberIds: JSON.parse(members) as number[] }));
}
export function getFindingGroup(
  db: Database,
  workspaceId: string,
  id: string,
): FindingGroup | null {
  const row = orm(db)
    .select(groupColumns)
    .from(findingGroup)
    .where(and(eq(findingGroup.workspaceId, workspaceId), eq(findingGroup.id, id)))
    .get();
  if (!row) return null;
  const { members, ...group } = row;
  return { ...group, memberIds: JSON.parse(members) as number[] };
}

/** Untouched groups follow individual finding decisions immediately. Claimed writes reconcile first. */
export function removeFindingFromOpenGroups(db: Database, workspaceId: string, id: number): void {
  const untouched = and(
    eq(findingGroup.workspaceId, workspaceId),
    eq(findingGroup.status, "open"),
    isNull(findingGroup.action),
  );
  orm(db)
    .update(findingGroup)
    .set({
      memberIds: sql`(SELECT json_group_array(value) FROM json_each(${findingGroup.memberIds}) WHERE value<>${id})`,
    })
    .where(
      and(
        untouched,
        sql`EXISTS(SELECT 1 FROM json_each(${findingGroup.memberIds}) WHERE value=${id})`,
      ),
    )
    .run();
  orm(db)
    .delete(findingGroup)
    .where(and(untouched, sql`json_array_length(${findingGroup.memberIds})=0`))
    .run();
}

export function lastFindingGroupRun(db: Database, workspaceId: string): FindingGroupRun | null {
  return (
    orm(db)
      .select({
        id: findingGroupRun.id,
        startedAt: findingGroupRun.startedAt,
        finishedAt: findingGroupRun.finishedAt,
        status: sql<FindingGroupRun["status"]>`${findingGroupRun.status}`,
        tokens: findingGroupRun.tokens,
        groupCount: findingGroupRun.groupCount,
        error: findingGroupRun.error,
        skipReason: findingGroupRun.skipReason,
      })
      .from(findingGroupRun)
      .where(eq(findingGroupRun.workspaceId, workspaceId))
      .orderBy(desc(findingGroupRun.startedAt), sql`rowid DESC`)
      .limit(1)
      .get() ?? null
  );
}
/** The workspace and team of each finding's reporting sessions. Never infer a team from model text. */
export function findingGroupSources(
  db: Database,
  workspaceId: string,
): { id: number; teamId: string; sessionId: string }[] {
  return orm(db)
    .selectDistinct({
      id: reviewFindingItem.findingId,
      teamId: sql<string>`${linearSession.teamId}`,
      sessionId: linearSession.sessionId,
    })
    .from(reviewFindingItem)
    .innerJoin(workItem, eq(workItem.id, reviewFindingItem.itemId))
    .innerJoin(linearSession, eq(linearSession.sessionId, workItem.sessionKey))
    .innerJoin(workspace, eq(workspace.linearOrganizationId, linearSession.organizationId))
    .where(and(eq(workspace.id, workspaceId), isNotNull(linearSession.teamId)))
    .orderBy(linearSession.sessionId)
    .all();
}

export function findingGroupingAdmins(db: Database, workspaceId: string): { userId: string }[] {
  return orm(db)
    .select({ userId: workspaceMember.userId })
    .from(workspaceMember)
    .where(
      and(
        eq(workspaceMember.workspaceId, workspaceId),
        sql.raw(workspaceMemberUsableSql("workspace_member")),
        inArray(workspaceMember.role, ["owner", "admin"]),
      ),
    )
    .orderBy(workspaceMember.userId)
    .all();
}

/** An expired command cannot return evidence after a coordinator restart. */
export function recoverFindingGroupRuns(db: Database, now: number): void {
  orm(db)
    .update(findingGroupRun)
    .set({ status: "failed", finishedAt: now, error: "Grouping interrupted before completion" })
    .where(
      and(eq(findingGroupRun.status, "running"), lte(findingGroupRun.startedAt, now - 11 * 60_000)),
    )
    .run();
}

export function findingGroupingEnabled(db: Database, workspaceId: string): boolean {
  return !orm(db)
    .select({ workspaceId: findingGroupingOff.workspaceId })
    .from(findingGroupingOff)
    .where(eq(findingGroupingOff.workspaceId, workspaceId))
    .get();
}

export function setFindingGrouping(db: Database, workspaceId: string, on: boolean): void {
  if (on)
    orm(db).delete(findingGroupingOff).where(eq(findingGroupingOff.workspaceId, workspaceId)).run();
  else orm(db).insert(findingGroupingOff).values({ workspaceId }).onConflictDoNothing().run();
}

type GroupAction = NonNullable<FindingGroup["action"]>;

export function* claimFindingGroupActionSteps(
  q: Q,
  id: string,
  action: GroupAction,
  memberIds: readonly number[],
) {
  const { findingGroup: g } = q.t;
  const claimed = yield* q.all(
    q.orm
      .update(g)
      .set({ action, memberIds: jsonValue(q, memberIds) })
      .where(and(eq(g.id, id), eq(g.status, "open"), or(isNull(g.action), eq(g.action, action))))
      .returning({ id: g.id }),
  );
  return claimed.length;
}

export function claimFindingGroupAction(
  db: Database,
  id: string,
  action: GroupAction,
  memberIds: readonly number[],
): number {
  return settled(sqliteDb(db).run((q) => claimFindingGroupActionSteps(q, id, action, memberIds)));
}

export type FindingGroupClose = {
  id: string;
  status: Exclude<FindingGroup["status"], "open">;
  reason: string | null;
  by: string;
  now: number;
  filedIssue: string | null;
};

export function* closeFindingGroupSteps(q: Q, input: FindingGroupClose) {
  const { findingGroup: g } = q.t;
  yield* q.exec(
    q.orm
      .update(g)
      .set({
        status: input.status,
        statusReason: input.reason,
        statusBy: input.by,
        statusAt: input.now,
        filedIssue: input.filedIssue,
      })
      .where(eq(g.id, input.id)),
  );
}

export function closeFindingGroup(db: Database, input: FindingGroupClose): void {
  settled(sqliteDb(db).run((q) => closeFindingGroupSteps(q, input)));
}

export function* releaseFindingGroupActionSteps(q: Q, id: string, action: GroupAction) {
  const { findingGroup: g } = q.t;
  yield* q.exec(
    q.orm
      .update(g)
      .set({ action: null })
      .where(and(eq(g.id, id), eq(g.status, "open"), eq(g.action, action))),
  );
}

export function releaseFindingGroupAction(db: Database, id: string, action: GroupAction): void {
  settled(sqliteDb(db).run((q) => releaseFindingGroupActionSteps(q, id, action)));
}

export function* findingHasGroupActionSteps(q: Q, workspaceId: string, findingId: number) {
  const { findingGroup: g } = q.t;
  const member =
    q.dialect === "sqlite"
      ? sql`EXISTS(SELECT 1 FROM json_each(${g.memberIds}) WHERE value=${findingId})`
      : sql`${g.memberIds} @> jsonb_build_array(CAST(${findingId} AS bigint))`;
  const row = yield* q.one(
    q.orm
      .select({ one: sql`1` })
      .from(g)
      .where(and(eq(g.workspaceId, workspaceId), eq(g.status, "open"), isNotNull(g.action), member))
      .limit(1),
  );
  return row !== undefined;
}

export function findingHasGroupAction(
  db: Database,
  workspaceId: string,
  findingId: number,
): boolean {
  return settled(sqliteDb(db).run((q) => findingHasGroupActionSteps(q, workspaceId, findingId)));
}
