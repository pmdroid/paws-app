import type { Database } from "bun:sqlite";
import { immediate } from "./tx";

export type WorkspaceRole = "owner" | "admin" | "member" | "observer";
export type WorkspaceRecord = {
  id: string;
  organizationId: string;
  name: string;
};
export type WorkspaceMember = {
  workspaceId: string;
  userId: string;
  linearUserId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  source: "linear" | "manual";
  active: boolean;
  checkedAt: number;
  teamIds: string[];
};
export type WorkspaceSession = {
  tokenHash: string;
  userId: string;
  workspaceId: string;
  csrfToken: string;
  authenticatedAt: number;
  lastSeenAt: number;
  expiresAt: number;
};

export function getWorkspace(db: Database, id: string): WorkspaceRecord | null {
  return db
    .query<WorkspaceRecord, [string]>(
      "SELECT id, linear_organization_id AS organizationId, name FROM workspace WHERE id = ?",
    )
    .get(id);
}

export function workspaceForOrganization(
  db: Database,
  organizationId: string,
): WorkspaceRecord | null {
  return db
    .query<WorkspaceRecord, [string]>(
      "SELECT id, linear_organization_id AS organizationId, name FROM workspace WHERE linear_organization_id = ?",
    )
    .get(organizationId);
}

export function putWorkspaceUser(
  db: Database,
  input: { id: string; linearUserId: string; name: string; email: string },
): string {
  db.run(
    `INSERT INTO workspace_user(id,linear_user_id,name,email) VALUES(?,?,?,?)
    ON CONFLICT(linear_user_id) DO UPDATE SET name=excluded.name,email=excluded.email`,
    [input.id, input.linearUserId, input.name, input.email],
  );
  return db
    .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id = ?")
    .get(input.linearUserId)!.id;
}

export function workspaceMember(
  db: Database,
  workspaceId: string,
  userId: string,
): WorkspaceMember | null {
  const row = db
    .query<Omit<WorkspaceMember, "teamIds" | "active"> & { active: number }, [string, string]>(
      `SELECT m.workspace_id AS workspaceId,m.user_id AS userId,u.linear_user_id AS linearUserId,
      u.name,u.email,m.role,m.source,m.active,m.checked_at AS checkedAt
      FROM workspace_member m JOIN workspace_user u ON u.id=m.user_id
      WHERE m.workspace_id=? AND m.user_id=?`,
    )
    .get(workspaceId, userId);
  if (row === null) return null;
  const teams = db
    .query<{ team_id: string }, [string, string]>(
      "SELECT team_id FROM workspace_user_team WHERE workspace_id=? AND user_id=? ORDER BY team_id",
    )
    .all(workspaceId, userId);
  return { ...row, active: row.active === 1, teamIds: teams.map((team) => team.team_id) };
}

export function workspaceLinearMember(db: Database, workspaceId: string, linearUserId: string) {
  const user = db
    .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id=?")
    .get(linearUserId);
  return user === null ? null : workspaceMember(db, workspaceId, user.id);
}

export function syncWorkspaceMember(
  db: Database,
  input: {
    workspaceId: string;
    userId: string;
    role: WorkspaceRole;
    active: boolean;
    teamIds: readonly string[];
    now: number;
  },
): boolean {
  return immediate(db, () => {
    const previous = workspaceMember(db, input.workspaceId, input.userId);
    if (
      previous !== null &&
      (previous.checkedAt > input.now ||
        (previous.checkedAt === input.now &&
          input.active &&
          (!previous.active || (previous.role === "observer" && input.role !== "observer"))))
    )
      return false;
    db.run(
      `INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at)
      VALUES(?,?,?,'linear',?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET
      role=CASE WHEN excluded.role='observer' THEN excluded.role WHEN workspace_member.source='manual' THEN COALESCE(workspace_member.manual_role,workspace_member.role) ELSE excluded.role END,
      manual_role=CASE WHEN workspace_member.source='manual' THEN COALESCE(workspace_member.manual_role,workspace_member.role) ELSE workspace_member.manual_role END,
      active=excluded.active,checked_at=excluded.checked_at`,
      [input.workspaceId, input.userId, input.role, input.active ? 1 : 0, input.now],
    );
    db.run("DELETE FROM workspace_user_team WHERE workspace_id=? AND user_id=?", [
      input.workspaceId,
      input.userId,
    ]);
    if (input.active)
      for (const teamId of new Set(input.teamIds))
        db.run("INSERT INTO workspace_user_team(workspace_id,user_id,team_id) VALUES(?,?,?)", [
          input.workspaceId,
          input.userId,
          teamId,
        ]);
    if (!input.active)
      db.run("DELETE FROM workspace_session WHERE workspace_id=? AND user_id=?", [
        input.workspaceId,
        input.userId,
      ]);
    const current = workspaceMember(db, input.workspaceId, input.userId)!;
    if (
      previous === null ||
      previous.active !== input.active ||
      previous.role !== current.role ||
      previous.teamIds.join() !== current.teamIds.join()
    )
      auditWorkspaceAccess(db, {
        workspaceId: input.workspaceId,
        userId: input.userId,
        action: input.active ? "membership.synced" : "membership.revoked",
        subject: input.userId,
        now: input.now,
      });
    return true;
  });
}

export function createWorkspaceBootstrap(
  db: Database,
  input: { tokenHash: string; organizationId: string; expiresAt: number },
): void {
  db.run("INSERT INTO workspace_bootstrap(token_hash,organization_id,expires_at) VALUES(?,?,?)", [
    input.tokenHash,
    input.organizationId,
    input.expiresAt,
  ]);
}

export function consumeWorkspaceBootstrap(
  db: Database,
  input: WorkspaceRecord & { tokenHash: string; userId: string; now: number },
): WorkspaceRecord {
  return immediate(db, () => {
    const claimed = db.run(
      `UPDATE workspace_bootstrap SET consumed_at=? WHERE token_hash=? AND organization_id=?
      AND expires_at>? AND consumed_at IS NULL`,
      [input.now, input.tokenHash, input.organizationId, input.now],
    ).changes;
    if (claimed !== 1) throw new Error("Workspace bootstrap is invalid or expired.");
    if (workspaceForOrganization(db, input.organizationId) !== null)
      throw new Error("This workspace already has an owner.");
    db.run("INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES(?,?,?,?)", [
      input.id,
      input.organizationId,
      input.name,
      input.now,
    ]);
    db.run(
      "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES(?,?,'owner','manual',1,?)",
      [input.id, input.userId, input.now],
    );
    auditWorkspaceAccess(db, {
      workspaceId: input.id,
      userId: input.userId,
      action: "workspace.bootstrapped",
      subject: input.id,
      now: input.now,
    });
    return { id: input.id, organizationId: input.organizationId, name: input.name };
  });
}

export function saveWorkspaceSession(db: Database, session: WorkspaceSession): void {
  db.run(
    `INSERT INTO workspace_session(token_hash,user_id,workspace_id,csrf_token,authenticated_at,last_seen_at,expires_at)
    VALUES(?,?,?,?,?,?,?)`,
    [
      session.tokenHash,
      session.userId,
      session.workspaceId,
      session.csrfToken,
      session.authenticatedAt,
      session.lastSeenAt,
      session.expiresAt,
    ],
  );
}

export function readWorkspaceSession(
  db: Database,
  tokenHash: string,
  now: number,
): WorkspaceSession | null {
  return immediate(db, () => {
    const session = db
      .query<WorkspaceSession, [string, number, number]>(
        `SELECT token_hash AS tokenHash,user_id AS userId,workspace_id AS workspaceId,
        csrf_token AS csrfToken,authenticated_at AS authenticatedAt,last_seen_at AS lastSeenAt,
        expires_at AS expiresAt FROM workspace_session
        WHERE token_hash=? AND expires_at>? AND last_seen_at>?`,
      )
      .get(tokenHash, now, now - 12 * 60 * 60_000);
    if (session === null) {
      deleteWorkspaceSession(db, tokenHash);
      return null;
    }
    if (now < session.authenticatedAt) return null;
    db.run("UPDATE workspace_session SET last_seen_at=? WHERE token_hash=?", [now, tokenHash]);
    return { ...session, lastSeenAt: now };
  });
}

export function deleteWorkspaceSession(db: Database, tokenHash: string): void {
  db.run("DELETE FROM workspace_session WHERE token_hash=?", [tokenHash]);
}

export function auditWorkspaceAccess(
  db: Database,
  input: {
    workspaceId: string | null;
    userId: string | null;
    action: string;
    subject: string;
    now: number;
  },
): void {
  db.run(
    "INSERT INTO workspace_access_audit(workspace_id,user_id,action,subject,created_at) VALUES(?,?,?,?,?)",
    [input.workspaceId, input.userId, input.action, input.subject, input.now],
  );
}

export function listWorkspaceAudit(db: Database, workspaceId: string, before: number) {
  const rows = db
    .query<
      {
        id: number;
        actorId: string | null;
        actorName: string | null;
        action: string;
        subject: string;
        createdAt: number;
      },
      [string, number]
    >(
      `SELECT a.id,a.user_id AS actorId,u.name AS actorName,a.action,a.subject,
      a.created_at AS createdAt FROM workspace_access_audit a
      LEFT JOIN workspace_user u ON u.id=a.user_id
      WHERE a.workspace_id=? AND a.id<? ORDER BY a.id DESC LIMIT 51`,
    )
    .all(workspaceId, before);
  const entries = rows.slice(0, 50);
  return { entries, nextBefore: rows.length > 50 ? entries.at(-1)!.id : null };
}
