import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { jsonValue, parsedJson } from "./json-text";
import { orm } from "./orm";
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

function sync<T>(db: Database, body: (q: Q) => Steps<T>): T {
  return settled(sqliteDb(db).run(body));
}

export type FindingGroupRunCursor = {
  fingerprint: string;
  findingCursor: number;
  issueCursor: number;
  groupCount: number;
};

export function* lastCompletedFindingGroupRunSteps(
  q: Q,
  workspaceId: string,
): Steps<FindingGroupRunCursor | null> {
  const { findingGroupRun: run } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        fingerprint: run.fingerprint,
        findingCursor: run.findingCursor,
        issueCursor: run.issueCursor,
        groupCount: run.groupCount,
      })
      .from(run)
      .where(and(eq(run.workspaceId, workspaceId), eq(run.status, "completed")))
      .orderBy(desc(run.startedAt), q.dialect === "sqlite" ? sql`rowid DESC` : desc(run.id))
      .limit(1),
  );
  return row ?? null;
}

export function lastCompletedFindingGroupRun(
  db: Database,
  workspaceId: string,
): FindingGroupRunCursor | null {
  return sync(db, (q) => lastCompletedFindingGroupRunSteps(q, workspaceId));
}

export function* findingGroupRunExistsForDaySteps(
  q: Q,
  workspaceId: string,
  day: string,
): Steps<boolean> {
  const { findingGroupRun: run } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.workspaceId, workspaceId), eq(run.day, day))),
  );
  return row !== undefined;
}

export function findingGroupRunExistsForDay(
  db: Database,
  workspaceId: string,
  day: string,
): boolean {
  return sync(db, (q) => findingGroupRunExistsForDaySteps(q, workspaceId, day));
}

export type NewFindingGroupRun = Q["t"]["findingGroupRun"]["$inferInsert"];

export function* insertFindingGroupRunSteps(q: Q, row: NewFindingGroupRun): Steps<void> {
  yield* q.exec(q.orm.insert(q.t.findingGroupRun).values(row));
}

export function insertFindingGroupRun(db: Database, row: NewFindingGroupRun): void {
  sync(db, (q) => insertFindingGroupRunSteps(q, row));
}

export function* setFindingGroupRunFingerprintSteps(
  q: Q,
  runId: string,
  fingerprint: string,
): Steps<void> {
  const { findingGroupRun: run } = q.t;
  yield* q.exec(q.orm.update(run).set({ fingerprint }).where(eq(run.id, runId)));
}

export function setFindingGroupRunFingerprint(
  db: Database,
  runId: string,
  fingerprint: string,
): void {
  sync(db, (q) => setFindingGroupRunFingerprintSteps(q, runId, fingerprint));
}

export function* findingGroupRunIsRunningSteps(q: Q, runId: string): Steps<boolean> {
  const { findingGroupRun: run } = q.t;
  const row = yield* q.one(
    q.orm
      .select({ id: run.id })
      .from(run)
      .where(and(eq(run.id, runId), eq(run.status, "running"))),
  );
  return row !== undefined;
}

export function findingGroupRunIsRunning(db: Database, runId: string): boolean {
  return sync(db, (q) => findingGroupRunIsRunningSteps(q, runId));
}

function untouchedGroups(q: Q, workspaceId: string) {
  const { findingGroup: group } = q.t;
  return and(eq(group.workspaceId, workspaceId), eq(group.status, "open"), isNull(group.action));
}

/**
 * Takes a partial snapshot's processed findings out of untouched groups, keeping only members
 * still in `current`, and drops the groups left empty. The caller holds the transaction.
 */
export function* dropProcessedFindingGroupMembersSteps(
  q: Q,
  workspaceId: string,
  processed: readonly number[],
  current: readonly number[],
): Steps<void> {
  const { findingGroup: group } = q.t;
  const done = JSON.stringify(processed);
  const open = JSON.stringify(current);
  const members =
    q.dialect === "sqlite"
      ? sql`(SELECT json_group_array(value) FROM json_each(${group.memberIds}) WHERE value NOT IN (SELECT value FROM json_each(${done})) AND value IN (SELECT value FROM json_each(${open})))`
      : sql`(SELECT COALESCE(jsonb_agg(member.value ORDER BY member.position), '[]'::jsonb) FROM jsonb_array_elements(${group.memberIds}) WITH ORDINALITY AS member(value, position) WHERE member.value NOT IN (SELECT jsonb_array_elements(${done}::jsonb)) AND member.value IN (SELECT jsonb_array_elements(${open}::jsonb)))`;
  yield* q.exec(
    q.orm.update(group).set({ memberIds: members }).where(untouchedGroups(q, workspaceId)),
  );
  const length = q.dialect === "sqlite" ? sql`json_array_length` : sql`jsonb_array_length`;
  yield* q.exec(
    q.orm
      .delete(group)
      .where(and(untouchedGroups(q, workspaceId), sql`${length}(${group.memberIds})=0`)),
  );
}

export function dropProcessedFindingGroupMembers(
  db: Database,
  workspaceId: string,
  processed: readonly number[],
  current: readonly number[],
): void {
  sync(db, (q) => dropProcessedFindingGroupMembersSteps(q, workspaceId, processed, current));
}

export function* deleteUntouchedFindingGroupsSteps(q: Q, workspaceId: string): Steps<void> {
  yield* q.exec(q.orm.delete(q.t.findingGroup).where(untouchedGroups(q, workspaceId)));
}

export function deleteUntouchedFindingGroups(db: Database, workspaceId: string): void {
  sync(db, (q) => deleteUntouchedFindingGroupsSteps(q, workspaceId));
}

/** The finding IDs that open groups hold, flattened across the groups. */
export function* heldFindingGroupMembersSteps(q: Q, workspaceId: string): Steps<number[]> {
  const { findingGroup: group } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({ ids: group.memberIds })
      .from(group)
      .where(and(eq(group.workspaceId, workspaceId), eq(group.status, "open"))),
  );
  return rows.flatMap((row) => parsedJson<number[]>(q, row.ids));
}

export function heldFindingGroupMembers(db: Database, workspaceId: string): number[] {
  return sync(db, (q) => heldFindingGroupMembersSteps(q, workspaceId));
}

export type NewFindingGroup = {
  id: string;
  workspaceId: string;
  repository: string;
  teamId: string;
  title: string;
  summary: string;
  scope: string;
  suggestedIssue: string | null;
  memberIds: readonly number[];
  createdAt: number;
  runId: string;
};

export function* insertFindingGroupSteps(q: Q, row: NewFindingGroup): Steps<void> {
  yield* q.exec(
    q.orm.insert(q.t.findingGroup).values({ ...row, memberIds: jsonValue(q, row.memberIds) }),
  );
}

export function insertFindingGroup(db: Database, row: NewFindingGroup): void {
  sync(db, (q) => insertFindingGroupSteps(q, row));
}

type FindingGroupRunResult = {
  finishedAt: number;
  tokens: number | null;
  groupCount: number;
  findingCursor: number;
  issueCursor: number;
};

/** Completes a run still marked running. False when this process no longer owns it. */
export function* completeFindingGroupRunSteps(
  q: Q,
  runId: string,
  result: FindingGroupRunResult,
): Steps<boolean> {
  const { findingGroupRun: run } = q.t;
  const rows = yield* q.all(
    q.orm
      .update(run)
      .set({ status: "completed", ...result })
      .where(and(eq(run.id, runId), eq(run.status, "running")))
      .returning({ id: run.id }),
  );
  return rows.length === 1;
}

export function completeFindingGroupRun(
  db: Database,
  runId: string,
  result: FindingGroupRunResult,
): boolean {
  return sync(db, (q) => completeFindingGroupRunSteps(q, runId, result));
}

export function* failFindingGroupRunSteps(
  q: Q,
  runId: string,
  finishedAt: number,
  error: string,
): Steps<void> {
  const { findingGroupRun: run } = q.t;
  yield* q.exec(
    q.orm
      .update(run)
      .set({ status: "failed", finishedAt, error })
      .where(and(eq(run.id, runId), eq(run.status, "running"))),
  );
}

export function failFindingGroupRun(
  db: Database,
  runId: string,
  finishedAt: number,
  error: string,
): void {
  sync(db, (q) => failFindingGroupRunSteps(q, runId, finishedAt, error));
}
