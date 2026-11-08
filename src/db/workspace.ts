import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, isNull } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { orm } from "./orm";
import { workspaceAccessAudit, workspaceUser } from "./schema";
import { immediate } from "./tx";
import { endRevokedRunnerAuthority } from "./runner-lease";

export type WorkspaceRole = "admin" | "member";
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
  revokedAt: number | null;
  revokedBy: string | null;
  checkedAt: number;
  teamIds: string[];
};
export const MEMBERSHIP_BACKSTOP_MS = 6 * 60 * 60_000;

export function membershipFresh(member: WorkspaceMember, now: number): boolean {
  return member.checkedAt <= now && now - member.checkedAt < MEMBERSHIP_BACKSTOP_MS;
}

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

export function* workspaceUserIdForLinearUserSteps(q: Q, linearUserId: string) {
  const { workspaceUser: u } = q.t;
  const row = yield* q.one(
    q.orm.select({ id: u.id }).from(u).where(eq(u.linearUserId, linearUserId)),
  );
  return row?.id ?? null;
}

export function workspaceUserIdForLinearUser(db: Database, linearUserId: string): string | null {
  return settled(sqliteDb(db).run((q) => workspaceUserIdForLinearUserSteps(q, linearUserId)));
}

export function* workspaceUserContactSteps(q: Q, userId: string) {
  const { workspaceUser: u } = q.t;
  const row = yield* q.one(
    q.orm.select({ name: u.name, email: u.email }).from(u).where(eq(u.id, userId)),
  );
  return row ?? null;
}

export function workspaceUserContact(
  db: Database,
  userId: string,
): { name: string; email: string } | null {
  return settled(sqliteDb(db).run((q) => workspaceUserContactSteps(q, userId)));
}

export function* workspaceMemberSteps(q: Q, workspaceId: string, userId: string) {
  const { workspaceMember: m, workspaceUser: u, workspaceUserTeam: team } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        workspaceId: m.workspaceId,
        userId: m.userId,
        linearUserId: u.linearUserId,
        name: u.name,
        email: u.email,
        role: m.role,
        source: m.source,
        active: m.active,
        revokedAt: m.revokedAt,
        revokedBy: m.revokedBy,
        checkedAt: m.checkedAt,
      })
      .from(m)
      .innerJoin(u, eq(u.id, m.userId))
      .where(and(eq(m.workspaceId, workspaceId), eq(m.userId, userId))),
  );
  if (row === undefined) return null;
  const teams = yield* q.all(
    q.orm
      .select({ teamId: team.teamId })
      .from(team)
      .where(and(eq(team.workspaceId, workspaceId), eq(team.userId, userId)))
      .orderBy(asc(team.teamId)),
  );
  return {
    ...row,
    role: row.role as WorkspaceRole,
    source: row.source as WorkspaceMember["source"],
    active: row.active === 1,
    teamIds: teams.map((t) => t.teamId),
  } satisfies WorkspaceMember;
}

export function workspaceMember(
  db: Database,
  workspaceId: string,
  userId: string,
): WorkspaceMember | null {
  return settled(sqliteDb(db).run((q) => workspaceMemberSteps(q, workspaceId, userId)));
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
        (previous.checkedAt === input.now && input.active && !previous.active))
    )
      return false;
    db.run(
      `INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at)
      VALUES(?,?,?,'linear',?,?) ON CONFLICT(workspace_id,user_id) DO UPDATE SET
      role=CASE WHEN workspace_member.source='manual' THEN COALESCE(workspace_member.manual_role,workspace_member.role) ELSE excluded.role END,
      manual_role=CASE WHEN workspace_member.source='manual' THEN COALESCE(workspace_member.manual_role,workspace_member.role) ELSE workspace_member.manual_role END,
      active=excluded.active,checked_at=excluded.checked_at`,
      [input.workspaceId, input.userId, input.role, input.active ? 1 : 0, input.now],
    );
    if (!input.active) endRevokedRunnerAuthority(db, input.now);
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

export function applyLinearUserChange(
  db: Database,
  input: {
    organizationId: string;
    userId: string;
    active: boolean | null;
    guest: boolean | null;
    now: number;
  },
): boolean {
  const workspace = workspaceForOrganization(db, input.organizationId);
  const member = workspace && workspaceLinearMember(db, workspace.id, input.userId);
  if (!member) return false;
  // A Linear guest has no access to Paws, the same as a deactivated account.
  if (input.active === false || input.guest === true)
    return syncWorkspaceMember(db, {
      workspaceId: member.workspaceId,
      userId: member.userId,
      active: false,
      role: "member",
      teamIds: member.teamIds,
      now: Math.max(input.now, member.checkedAt),
    });
  db.run("UPDATE workspace_member SET checked_at=0 WHERE workspace_id=? AND user_id=?", [
    member.workspaceId,
    member.userId,
  ]);
  return true;
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
      throw new Error("This workspace already has an admin.");
    db.run("INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES(?,?,?,?)", [
      input.id,
      input.organizationId,
      input.name,
      input.now,
    ]);
    db.run(
      "INSERT INTO workspace_member(workspace_id,user_id,role,source,active,checked_at) VALUES(?,?,'admin','manual',1,?)",
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
  lifetime: number,
): WorkspaceSession | null {
  return immediate(db, () => {
    const session = db
      .query<WorkspaceSession, [string, number]>(
        `SELECT token_hash AS tokenHash,user_id AS userId,workspace_id AS workspaceId,
        csrf_token AS csrfToken,authenticated_at AS authenticatedAt,last_seen_at AS lastSeenAt,
        expires_at AS expiresAt FROM workspace_session
        WHERE token_hash=? AND expires_at>?`,
      )
      .get(tokenHash, now);
    if (session === null) {
      deleteWorkspaceSession(db, tokenHash);
      return null;
    }
    if (now < session.authenticatedAt) return null;
    const expiresAt = now + lifetime;
    db.run("UPDATE workspace_session SET last_seen_at=?,expires_at=? WHERE token_hash=?", [
      now,
      expiresAt,
      tokenHash,
    ]);
    return { ...session, lastSeenAt: now, expiresAt };
  });
}

export function deleteWorkspaceSession(db: Database, tokenHash: string): void {
  db.run("DELETE FROM workspace_session WHERE token_hash=?", [tokenHash]);
}

type WorkspaceAuditInput = {
  workspaceId: string | null;
  userId: string | null;
  action: string;
  subject: string;
  now: number;
};

export function* auditWorkspaceAccessSteps(q: Q, input: WorkspaceAuditInput) {
  yield* q.exec(
    q.orm.insert(q.t.workspaceAccessAudit).values({
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: input.action,
      subject: input.subject,
      createdAt: input.now,
    }),
  );
}

export function auditWorkspaceAccess(db: Database, input: WorkspaceAuditInput): void {
  settled(sqliteDb(db).run((q) => auditWorkspaceAccessSteps(q, input)));
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

/** Linear membership and the administrator's access decision are independent. */
export function workspaceMemberUsable<
  T extends { active: boolean | number; revokedAt: number | null },
>(member: T | null | undefined): member is T {
  return (
    member != null && (member.active === true || member.active === 1) && member.revokedAt === null
  );
}

export function workspaceMemberUsableWhere(member: Q["t"]["workspaceMember"]) {
  return and(eq(member.active, 1), isNull(member.revokedAt));
}

/** SQL counterpart for membership checks that do not load a member record. */
export function workspaceMemberUsableSql(alias: string): string {
  return `${alias}.active=1 AND ${alias}.revoked_at IS NULL`;
}

export const WORKSPACE_REVOKED_SIGN_IN =
  "Your access to this Paws workspace was revoked. Ask an admin.";
export const WORKSPACE_REVOKED_RESPONSE =
  "Access to Paws was revoked for the person who delegated this. An admin can delegate it again.";

export function lastPausedBy(db: Database, itemId: string): string | null {
  return (
    orm(db)
      .select({ name: workspaceUser.name })
      .from(workspaceAccessAudit)
      .innerJoin(workspaceUser, eq(workspaceUser.id, workspaceAccessAudit.userId))
      .where(
        and(
          eq(workspaceAccessAudit.action, "execution.pause"),
          eq(workspaceAccessAudit.subject, itemId),
        ),
      )
      .orderBy(desc(workspaceAccessAudit.id))
      .limit(1)
      .get()?.name ?? null
  );
}
