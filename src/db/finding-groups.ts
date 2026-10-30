import type { Database } from "bun:sqlite";

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
export function listFindingGroups(db: Database, workspaceId: string, limit = -1): FindingGroup[] {
  return db
    .query<Omit<FindingGroup, "memberIds"> & { members: string }, [string, number]>(`
    SELECT id,workspace_id AS workspaceId,repository,team_id AS teamId,title,summary,scope,
      suggested_issue AS suggestedIssue,member_ids AS members,created_at AS createdAt,
      run_id AS runId,status,status_reason AS statusReason,filed_issue AS filedIssue,action
    FROM finding_group WHERE workspace_id=? ORDER BY (status='open') DESC,created_at DESC,id LIMIT ?
  `)
    .all(workspaceId, limit)
    .map(({ members, ...row }) => ({ ...row, memberIds: JSON.parse(members) as number[] }));
}
export function getFindingGroup(
  db: Database,
  workspaceId: string,
  id: string,
): FindingGroup | null {
  const row = db
    .query<
      Omit<FindingGroup, "memberIds"> & { members: string },
      [string, string]
    >(`SELECT id,workspace_id AS workspaceId,repository,team_id AS teamId,title,summary,scope,
    suggested_issue AS suggestedIssue,member_ids AS members,created_at AS createdAt,run_id AS runId,status,status_reason AS statusReason,filed_issue AS filedIssue,action
    FROM finding_group WHERE workspace_id=? AND id=?`)
    .get(workspaceId, id);
  if (!row) return null;
  const { members, ...group } = row;
  return { ...group, memberIds: JSON.parse(members) as number[] };
}

/** Untouched groups follow individual finding decisions immediately. Claimed writes reconcile first. */
export function removeFindingFromOpenGroups(db: Database, workspaceId: string, id: number): void {
  db.run(
    `UPDATE finding_group SET member_ids=(SELECT json_group_array(value) FROM json_each(member_ids) WHERE value<>?)
    WHERE workspace_id=? AND status='open' AND action IS NULL AND EXISTS(SELECT 1 FROM json_each(member_ids) WHERE value=?)`,
    [id, workspaceId, id],
  );
  db.run(
    "DELETE FROM finding_group WHERE workspace_id=? AND status='open' AND action IS NULL AND json_array_length(member_ids)=0",
    [workspaceId],
  );
}

export function lastFindingGroupRun(db: Database, workspaceId: string): FindingGroupRun | null {
  return db
    .query<FindingGroupRun, [string]>(`
    SELECT id,started_at AS startedAt,finished_at AS finishedAt,status,tokens,
      group_count AS groupCount,error,skip_reason AS skipReason FROM finding_group_run WHERE workspace_id=?
    ORDER BY started_at DESC,rowid DESC LIMIT 1
  `)
    .get(workspaceId);
}
/** The workspace and team of each finding's reporting sessions. Never infer a team from model text. */
export function findingGroupSources(
  db: Database,
  workspaceId: string,
): { id: number; teamId: string; sessionId: string }[] {
  return db
    .query<{ id: number; teamId: string; sessionId: string }, [string]>(`
    SELECT DISTINCT f.finding_id AS id,s.team_id AS teamId,s.session_id AS sessionId
    FROM review_finding_item f JOIN work_item i ON i.id=f.item_id
    JOIN linear_session s ON s.session_id=i.session_key
    JOIN workspace w ON w.linear_organization_id=s.organization_id
    WHERE w.id=? AND s.team_id IS NOT NULL ORDER BY s.session_id
  `)
    .all(workspaceId);
}

export function findingGroupingAdmins(db: Database, workspaceId: string): { userId: string }[] {
  return db
    .query<{ userId: string }, [string]>(
      "SELECT user_id AS userId FROM workspace_member WHERE workspace_id=? AND active=1 AND role IN ('owner','admin') ORDER BY user_id",
    )
    .all(workspaceId);
}

/** An expired command cannot return evidence after a coordinator restart. */
export function recoverFindingGroupRuns(db: Database, now: number): void {
  db.run(
    "UPDATE finding_group_run SET status='failed',finished_at=?,error='Grouping interrupted before completion' WHERE status='running' AND started_at<=?",
    [now, now - 11 * 60_000],
  );
}

export function findingGroupingEnabled(db: Database, workspaceId: string): boolean {
  return !db.query("SELECT 1 FROM finding_grouping_off WHERE workspace_id=?").get(workspaceId);
}

export function setFindingGrouping(db: Database, workspaceId: string, on: boolean): void {
  if (on) db.run("DELETE FROM finding_grouping_off WHERE workspace_id=?", [workspaceId]);
  else db.run("INSERT OR IGNORE INTO finding_grouping_off VALUES(?)", [workspaceId]);
}
