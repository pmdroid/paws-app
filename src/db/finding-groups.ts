import type { Database } from "bun:sqlite";
import { and, desc, eq, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q, type Steps } from "./db";
import { workspaceMemberUsableWhere } from "./workspace";
import { jsonValue, parsedJson } from "./json-text";

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

type GroupAction = NonNullable<FindingGroup["action"]>;

export function* claimFindingGroupActionSteps(
  q: Q,
  id: string,
  action: GroupAction,
  members: readonly number[],
) {
  const { findingGroup: g } = q.t;
  const claimed = yield* q.all(
    q.orm
      .update(g)
      .set({ action, memberIds: jsonValue(q, members) })
      .where(and(eq(g.id, id), eq(g.status, "open"), or(isNull(g.action), eq(g.action, action))))
      .returning({ id: g.id }),
  );
  return claimed.length;
}

export function claimFindingGroupAction(
  db: Database,
  id: string,
  action: GroupAction,
  members: readonly number[],
): number {
  return settled(sqliteDb(db).run((q) => claimFindingGroupActionSteps(q, id, action, members)));
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
