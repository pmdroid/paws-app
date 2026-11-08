import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { workspaceMemberUsableWhere } from "./workspace";

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
function groupColumns(q: Q) {
  const { findingGroup } = q.t;
  return {
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
}

/** `member_ids` is JSON text on SQLite and jsonb on Postgres. */
function memberIds(q: Q, members: unknown): number[] {
  return (q.dialect === "sqlite" ? JSON.parse(members as string) : members) as number[];
}

/** A negative `limit` means no limit. */
export function* listFindingGroupsSteps(
  q: Q,
  workspaceId: string,
  limit = -1,
): Steps<FindingGroup[]> {
  const { findingGroup } = q.t;
  const ordered = q.orm
    .select(groupColumns(q))
    .from(findingGroup)
    .where(eq(findingGroup.workspaceId, workspaceId))
    .orderBy(
      sql`(${findingGroup.status}='open') DESC`,
      desc(findingGroup.createdAt),
      findingGroup.id,
    );
  const rows = yield* q.all(limit < 0 ? ordered : ordered.limit(limit));
  return rows.map(({ members, ...row }) => ({ ...row, memberIds: memberIds(q, members) }));
}

export function listFindingGroups(db: Database, workspaceId: string, limit = -1): FindingGroup[] {
  return settled(sqliteDb(db).run((q) => listFindingGroupsSteps(q, workspaceId, limit)));
}

export function* getFindingGroupSteps(
  q: Q,
  workspaceId: string,
  id: string,
): Steps<FindingGroup | null> {
  const { findingGroup } = q.t;
  const row = yield* q.one(
    q.orm
      .select(groupColumns(q))
      .from(findingGroup)
      .where(and(eq(findingGroup.workspaceId, workspaceId), eq(findingGroup.id, id))),
  );
  if (!row) return null;
  const { members, ...group } = row;
  return { ...group, memberIds: memberIds(q, members) };
}

export function getFindingGroup(
  db: Database,
  workspaceId: string,
  id: string,
): FindingGroup | null {
  return settled(sqliteDb(db).run((q) => getFindingGroupSteps(q, workspaceId, id)));
}

/** Untouched groups follow individual finding decisions immediately. Claimed writes reconcile first. */
export function* removeFindingFromOpenGroupsSteps(
  q: Q,
  workspaceId: string,
  id: number,
): Steps<void> {
  const { findingGroup } = q.t;
  const untouched = and(
    eq(findingGroup.workspaceId, workspaceId),
    eq(findingGroup.status, "open"),
    isNull(findingGroup.action),
  );
  const members = findingGroup.memberIds;
  yield* q.exec(
    q.orm
      .update(findingGroup)
      .set({
        memberIds:
          q.dialect === "sqlite"
            ? sql`(SELECT json_group_array(value) FROM json_each(${members}) WHERE value<>${id})`
            : sql`COALESCE((SELECT jsonb_agg(e.value ORDER BY e.position) FROM jsonb_array_elements(${members}) WITH ORDINALITY AS e(value, position) WHERE e.value<>to_jsonb(${id}::bigint)), '[]'::jsonb)`,
      })
      .where(
        and(
          untouched,
          q.dialect === "sqlite"
            ? sql`EXISTS(SELECT 1 FROM json_each(${members}) WHERE value=${id})`
            : sql`${members} @> to_jsonb(${id}::bigint)`,
        ),
      ),
  );
  yield* q.exec(
    q.orm
      .delete(findingGroup)
      .where(
        and(
          untouched,
          q.dialect === "sqlite"
            ? sql`json_array_length(${members})=0`
            : sql`jsonb_array_length(${members})=0`,
        ),
      ),
  );
}

export function removeFindingFromOpenGroups(db: Database, workspaceId: string, id: number): void {
  settled(sqliteDb(db).run((q) => removeFindingFromOpenGroupsSteps(q, workspaceId, id)));
}

export function* lastFindingGroupRunSteps(
  q: Q,
  workspaceId: string,
): Steps<FindingGroupRun | null> {
  const { findingGroupRun } = q.t;
  return (
    (yield* q.one(
      q.orm
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
        .orderBy(desc(findingGroupRun.startedAt), desc(findingGroupRun.day))
        .limit(1),
    )) ?? null
  );
}

export function lastFindingGroupRun(db: Database, workspaceId: string): FindingGroupRun | null {
  return settled(sqliteDb(db).run((q) => lastFindingGroupRunSteps(q, workspaceId)));
}

type FindingGroupSource = { id: number; teamId: string; sessionId: string };

/** The workspace and team of each finding's reporting sessions. Never infer a team from model text. */
export function* findingGroupSourcesSteps(q: Q, workspaceId: string): Steps<FindingGroupSource[]> {
  const { linearSession, reviewFindingItem, workItem, workspace } = q.t;
  return yield* q.all(
    q.orm
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
      .orderBy(linearSession.sessionId),
  );
}

export function findingGroupSources(db: Database, workspaceId: string): FindingGroupSource[] {
  return settled(sqliteDb(db).run((q) => findingGroupSourcesSteps(q, workspaceId)));
}

export function* findingGroupingAdminsSteps(
  q: Q,
  workspaceId: string,
): Steps<{ userId: string }[]> {
  const { workspaceMember } = q.t;
  return yield* q.all(
    q.orm
      .select({ userId: workspaceMember.userId })
      .from(workspaceMember)
      .where(
        and(
          eq(workspaceMember.workspaceId, workspaceId),
          workspaceMemberUsableWhere(workspaceMember),
          inArray(workspaceMember.role, ["owner", "admin"]),
        ),
      )
      .orderBy(workspaceMember.userId),
  );
}

export function findingGroupingAdmins(db: Database, workspaceId: string): { userId: string }[] {
  return settled(sqliteDb(db).run((q) => findingGroupingAdminsSteps(q, workspaceId)));
}

/** An expired command cannot return evidence after a coordinator restart. */
export function* recoverFindingGroupRunsSteps(q: Q, now: number): Steps<void> {
  const { findingGroupRun } = q.t;
  yield* q.exec(
    q.orm
      .update(findingGroupRun)
      .set({ status: "failed", finishedAt: now, error: "Grouping interrupted before completion" })
      .where(
        and(
          eq(findingGroupRun.status, "running"),
          lte(findingGroupRun.startedAt, now - 11 * 60_000),
        ),
      ),
  );
}

export function recoverFindingGroupRuns(db: Database, now: number): void {
  settled(sqliteDb(db).run((q) => recoverFindingGroupRunsSteps(q, now)));
}

export function* findingGroupingEnabledSteps(q: Q, workspaceId: string): Steps<boolean> {
  const { findingGroupingOff } = q.t;
  return !(yield* q.one(
    q.orm
      .select({ workspaceId: findingGroupingOff.workspaceId })
      .from(findingGroupingOff)
      .where(eq(findingGroupingOff.workspaceId, workspaceId)),
  ));
}

export function findingGroupingEnabled(db: Database, workspaceId: string): boolean {
  return settled(sqliteDb(db).run((q) => findingGroupingEnabledSteps(q, workspaceId)));
}

export function* setFindingGroupingSteps(q: Q, workspaceId: string, on: boolean): Steps<void> {
  const { findingGroupingOff } = q.t;
  if (on)
    yield* q.exec(
      q.orm.delete(findingGroupingOff).where(eq(findingGroupingOff.workspaceId, workspaceId)),
    );
  else
    yield* q.exec(q.orm.insert(findingGroupingOff).values({ workspaceId }).onConflictDoNothing());
}

export function setFindingGrouping(db: Database, workspaceId: string, on: boolean): void {
  settled(sqliteDb(db).run((q) => setFindingGroupingSteps(q, workspaceId, on)));
}
