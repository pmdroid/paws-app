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
};
export function listFindingGroups(db: Database, workspaceId: string): FindingGroup[] {
  return db
    .query<Omit<FindingGroup, "memberIds"> & { members: string }, [string]>(`
    SELECT id,workspace_id AS workspaceId,repository,team_id AS teamId,title,summary,scope,
      suggested_issue AS suggestedIssue,member_ids AS members,created_at AS createdAt,
      run_id AS runId,status,status_reason AS statusReason,filed_issue AS filedIssue,action
    FROM finding_group WHERE workspace_id=? ORDER BY created_at DESC,id
  `)
    .all(workspaceId)
    .map(({ members, ...row }) => ({ ...row, memberIds: JSON.parse(members) as number[] }));
}
export function lastFindingGroupRun(db: Database, workspaceId: string): FindingGroupRun | null {
  return db
    .query<FindingGroupRun, [string]>(`
    SELECT id,started_at AS startedAt,finished_at AS finishedAt,status,tokens,
      group_count AS groupCount,error FROM finding_group_run WHERE workspace_id=?
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
