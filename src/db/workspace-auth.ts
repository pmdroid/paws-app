import type { Database } from "bun:sqlite";
import { immediate } from "./tx";
import {
  auditWorkspaceAccess,
  syncWorkspaceMember,
  workspaceMember,
  type WorkspaceRole,
} from "./workspace";

export type WorkspaceOAuthRequest = {
  stateHash: string;
  browserHash: string;
  bootstrapHash: string | null;
  assignmentHash?: string | null;
  expiresAt: number;
};

export function saveWorkspaceOAuthRequest(db: Database, input: WorkspaceOAuthRequest): void {
  db.run("DELETE FROM workspace_oauth_request WHERE expires_at<=?", [input.expiresAt - 600_000]);
  db.run(
    "INSERT INTO workspace_oauth_request(state_hash,browser_hash,verifier,bootstrap_hash,expires_at,assignment_hash) VALUES(?,?,'',?,?,?)",
    [
      input.stateHash,
      input.browserHash,
      input.bootstrapHash,
      input.expiresAt,
      input.assignmentHash ?? null,
    ],
  );
}

export function consumeWorkspaceOAuthRequest(
  db: Database,
  stateHash: string,
  browserHash: string,
  now: number,
): WorkspaceOAuthRequest | null {
  return db
    .query<WorkspaceOAuthRequest, [string, string, number]>(
      `DELETE FROM workspace_oauth_request WHERE state_hash=? AND browser_hash=? AND expires_at>?
      RETURNING state_hash AS stateHash,browser_hash AS browserHash,bootstrap_hash AS bootstrapHash,assignment_hash AS assignmentHash,expires_at AS expiresAt`,
    )
    .get(stateHash, browserHash, now);
}

export function listUserWorkspaces(db: Database, userId: string) {
  return db
    .query<{ id: string; name: string; role: WorkspaceRole }, [string]>(
      `SELECT w.id,w.name,m.role FROM workspace w JOIN workspace_member m ON m.workspace_id=w.id
      WHERE m.user_id=? AND m.active=1 ORDER BY w.name,w.id`,
    )
    .all(userId);
}

export function listWorkspaceMembers(db: Database, workspaceId: string) {
  return db
    .query<{ id: string; name: string; role: WorkspaceRole; active: number }, [string]>(
      `SELECT u.id,u.name,m.role,m.active FROM workspace_member m JOIN workspace_user u ON u.id=m.user_id
      WHERE m.workspace_id=? ORDER BY u.name,u.id`,
    )
    .all(workspaceId);
}

export function changeWorkspaceRole(
  db: Database,
  input: {
    workspaceId: string;
    actorId: string;
    userId: string;
    role: WorkspaceRole;
    now: number;
    verified?: { active: boolean; guest: boolean; teamIds: readonly string[] };
  },
): void {
  const error = immediate(db, () => {
    const actor = workspaceMember(db, input.workspaceId, input.actorId);
    if (actor?.role !== "admin" || !actor.active)
      throw new Error("Workspace administration is required.");
    if (input.verified !== undefined) {
      if (
        !syncWorkspaceMember(db, {
          ...input,
          active: input.verified.active && !input.verified.guest,
          role: "member",
          teamIds: input.verified.teamIds,
        })
      )
        throw new Error("Linear membership changed. Try again.");
      if (input.verified.guest) return "Linear guests can't use Paws.";
      if (!input.verified.active) return "Current Linear membership is required.";
    }
    const member = workspaceMember(db, input.workspaceId, input.userId);
    if (member === null || !member.active)
      throw new Error("An active workspace member is required.");
    if (member.role === "admin" && input.role !== "admin") {
      const admins = db
        .query<{ count: number }, [string]>(
          "SELECT count(*) AS count FROM workspace_member WHERE workspace_id=? AND role='admin' AND active=1",
        )
        .get(input.workspaceId)!.count;
      if (admins <= 1) throw new Error("The workspace must keep an active admin.");
    }
    db.run(
      "UPDATE workspace_member SET role=?,manual_role=?,source='manual' WHERE workspace_id=? AND user_id=?",
      [input.role, input.role, input.workspaceId, input.userId],
    );
    auditWorkspaceAccess(db, {
      ...input,
      userId: input.actorId,
      action: "member.role.changed",
      subject: `${input.userId}:${input.role}`,
    });
    return null;
  });
  if (error !== null) throw new Error(error);
}

export function replaceWorkspaceRepositories(
  db: Database,
  input: {
    workspaceId: string;
    actorId: string;
    repositories: readonly { repository: string; teamId: string }[];
    now: number;
  },
): void {
  immediate(db, () => {
    const actor = workspaceMember(db, input.workspaceId, input.actorId);
    if (actor?.role !== "admin" || !actor.active)
      throw new Error("Workspace administration is required.");
    db.run("DELETE FROM workspace_repository WHERE workspace_id=?", [input.workspaceId]);
    for (const entry of input.repositories)
      db.run("INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES(?,?,?)", [
        input.workspaceId,
        entry.repository,
        entry.teamId,
      ]);
    auditWorkspaceAccess(db, {
      ...input,
      userId: input.actorId,
      action: "repositories.changed",
      subject: input.workspaceId,
    });
  });
}

/**
 * Every repository a workspace can use, `owner/repo`: the ones mapped to its Linear teams and the
 * ones its stored GitHub App connection approved. Without `workspaceId`, every workspace's.
 */
export function listWorkspaceRepositoryNames(db: Database, workspaceId?: string): string[] {
  const scope = workspaceId === undefined ? "" : " WHERE workspace_id=?1";
  const args = workspaceId === undefined ? [] : [workspaceId];
  const mapped = db
    .query<{ repository: string }, string[]>(
      `SELECT repository FROM workspace_repository${scope} ORDER BY repository`,
    )
    .all(...args)
    .map((row) => row.repository);
  const connected = db
    .query<{ repositories: string }, string[]>(
      `SELECT repositories FROM workspace_github_connection${scope}`,
    )
    .all(...args)
    .flatMap((row) => {
      try {
        const names: unknown = JSON.parse(row.repositories);
        return Array.isArray(names)
          ? names.filter((name): name is string => typeof name === "string")
          : [];
      } catch {
        return [];
      }
    });
  const seen = new Set<string>();
  return [...mapped, ...connected].filter((name) => {
    const key = name.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function listWorkspaceRepositories(db: Database, workspaceId: string) {
  return db
    .query<{ repository: string; teamId: string }, [string]>(
      "SELECT repository,team_id AS teamId FROM workspace_repository WHERE workspace_id=? ORDER BY repository,team_id",
    )
    .all(workspaceId);
}
