import type { Database } from "bun:sqlite";
import { delegationIssueIdSql } from "../core";

export type LinearTaskDelegation = {
  appUserId: string;
  humanActorId: string | null;
  teamId: string;
};

export function getLinearTaskDelegation(
  db: Database,
  itemId: string,
  issueId: string,
): LinearTaskDelegation | null {
  const row = db
    .query<
      { app_user_id: string; human_actor_id: string | null; team_id: string },
      [string, string]
    >(
      "SELECT app_user_id, human_actor_id, team_id FROM linear_task_delegation WHERE item_id = ? AND issue_id = ?",
    )
    .get(itemId, issueId);
  return row
    ? { appUserId: row.app_user_id, humanActorId: row.human_actor_id, teamId: row.team_id }
    : null;
}

export function requireLinearTaskDelegation(
  db: Database,
  input: {
    itemId: string;
    issueId: string;
    teamId: string;
    appUserId: string;
    humanActorId?: string | null;
  },
): void {
  if ([input.itemId, input.issueId, input.teamId, input.appUserId].some((id) => id.trim() === ""))
    throw new Error("Linear delegation ownership is incomplete.");
  if (
    input.humanActorId !== undefined &&
    input.humanActorId !== null &&
    input.humanActorId.trim() === ""
  )
    throw new Error("Linear delegation human ownership is incomplete.");
  const existing = getLinearTaskDelegation(db, input.itemId, input.issueId);
  if (
    existing &&
    (existing.appUserId !== input.appUserId ||
      (existing.humanActorId !== null &&
        input.humanActorId != null &&
        existing.humanActorId !== input.humanActorId))
  )
    throw new Error("Linear delegation ownership changed.");
  db.run(
    `INSERT INTO linear_task_delegation (item_id, issue_id, team_id, app_user_id, human_actor_id)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT(item_id, issue_id) DO UPDATE SET
    team_id = excluded.team_id,
    human_actor_id = COALESCE(linear_task_delegation.human_actor_id, excluded.human_actor_id)`,
    [input.itemId, input.issueId, input.teamId, input.appUserId, input.humanActorId ?? null],
  );
}

export function linearSessionsForDelegatedTeams(
  db: Database,
  input: {
    organizationId: string;
    oauthClientId: string;
    appUserId: string;
    teamIds: readonly string[];
  },
): string[] {
  return db
    .query<{ session_id: string }, [string, string, string, string]>(
      `SELECT DISTINCT s.session_id FROM linear_task_delegation d
    JOIN work_item w ON w.id = d.item_id
    JOIN linear_session s ON s.session_id = w.session_key
    JOIN linear_team_access a ON a.organization_id = s.organization_id
      AND a.oauth_client_id = s.oauth_client_id AND a.app_user_id = s.app_user_id
      AND a.team_id = d.team_id AND a.allowed = 0
    WHERE s.organization_id = ? AND s.oauth_client_id = ? AND s.app_user_id = ?
      AND d.team_id IN (SELECT value FROM json_each(?))
    ORDER BY s.session_id`,
    )
    .all(input.organizationId, input.oauthClientId, input.appUserId, JSON.stringify(input.teamIds))
    .map((row) => row.session_id);
}

export function linearSessionsForUndelegatedIssue(
  db: Database,
  input: { organizationId: string; appUserId: string; issueId: string; createdAtMs: number },
): string[] {
  return db
    .query<{ session_id: string }, [string, string, string, number]>(
      `SELECT s.session_id FROM linear_session s
    WHERE s.organization_id = ?1 AND s.app_user_id = ?2 AND s.stopped_at IS NULL AND s.created_at <= ?4
      AND (EXISTS (SELECT 1 FROM work_item i WHERE i.session_key = s.session_id
          AND i.state NOT IN ('completed', 'merged', 'cancelled') AND i.created_at <= ?4
          AND (s.issue_id = ?3 OR i.linear_issue_id = ?3 OR ${delegationIssueIdSql("i")} = ?3))
        OR (s.issue_id = ?3 AND NOT EXISTS (SELECT 1 FROM work_item i WHERE i.session_key = s.session_id)))
    ORDER BY s.session_id`,
    )
    .all(input.organizationId, input.appUserId, input.issueId, input.createdAtMs)
    .map((row) => row.session_id);
}
