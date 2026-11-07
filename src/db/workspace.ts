import type { Database } from "bun:sqlite";
import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import { settled, sqliteDb, type Q } from "./db";
import { endRevokedRunnerAuthoritySteps } from "./runner-lease";

export type WorkspaceRole = "admin" | "member";
type WorkspaceRecord = {
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

function* findWorkspaceSteps(q: Q, column: "id" | "linearOrganizationId", value: string) {
  const { workspace } = q.t;
  const row = yield* q.one(
    q.orm
      .select({
        id: workspace.id,
        organizationId: workspace.linearOrganizationId,
        name: workspace.name,
      })
      .from(workspace)
      .where(eq(workspace[column], value)),
  );
  return row ?? null;
}

export function getWorkspaceSteps(q: Q, id: string) {
  return findWorkspaceSteps(q, "id", id);
}

export function getWorkspace(db: Database, id: string): WorkspaceRecord | null {
  return settled(sqliteDb(db).run((q) => getWorkspaceSteps(q, id)));
}

export function workspaceForOrganizationSteps(q: Q, organizationId: string) {
  return findWorkspaceSteps(q, "linearOrganizationId", organizationId);
}

export function workspaceForOrganization(
  db: Database,
  organizationId: string,
): WorkspaceRecord | null {
  return settled(sqliteDb(db).run((q) => workspaceForOrganizationSteps(q, organizationId)));
}

type WorkspaceUserInput = { id: string; linearUserId: string; name: string; email: string };

export function* putWorkspaceUserSteps(q: Q, input: WorkspaceUserInput) {
  const { workspaceUser } = q.t;
  const rows = yield* q.all(
    q.orm
      .insert(workspaceUser)
      .values(input)
      .onConflictDoUpdate({
        target: workspaceUser.linearUserId,
        set: { name: input.name, email: input.email },
      })
      .returning({ id: workspaceUser.id }),
  );
  return rows[0]!.id;
}

export function putWorkspaceUser(db: Database, input: WorkspaceUserInput): string {
  return settled(sqliteDb(db).run((q) => putWorkspaceUserSteps(q, input)));
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

export function* workspaceLinearMemberSteps(q: Q, workspaceId: string, linearUserId: string) {
  const userId = yield* workspaceUserIdForLinearUserSteps(q, linearUserId);
  return userId === null ? null : yield* workspaceMemberSteps(q, workspaceId, userId);
}

export function workspaceLinearMember(db: Database, workspaceId: string, linearUserId: string) {
  return settled(sqliteDb(db).run((q) => workspaceLinearMemberSteps(q, workspaceId, linearUserId)));
}

type WorkspaceMemberSync = {
  workspaceId: string;
  userId: string;
  role: WorkspaceRole;
  active: boolean;
  teamIds: readonly string[];
  now: number;
};

export function* syncWorkspaceMemberSteps(q: Q, input: WorkspaceMemberSync) {
  const { workspaceMember: member, workspaceSession, workspaceUserTeam } = q.t;
  const previous = yield* workspaceMemberSteps(q, input.workspaceId, input.userId);
  if (
    previous !== null &&
    (previous.checkedAt > input.now ||
      (previous.checkedAt === input.now && input.active && !previous.active))
  )
    return false;
  const kept = sql`COALESCE(${member.manualRole},${member.role})`;
  yield* q.exec(
    q.orm
      .insert(member)
      .values({
        workspaceId: input.workspaceId,
        userId: input.userId,
        role: input.role,
        source: "linear",
        active: input.active ? 1 : 0,
        checkedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [member.workspaceId, member.userId],
        set: {
          role: sql`CASE WHEN ${member.source}='manual' THEN ${kept} ELSE excluded.role END`,
          manualRole: sql`CASE WHEN ${member.source}='manual' THEN ${kept} ELSE ${member.manualRole} END`,
          active: sql`excluded.active`,
          checkedAt: sql`excluded.checked_at`,
        },
      }),
  );
  if (!input.active) yield* endRevokedRunnerAuthoritySteps(q, input.now);
  const memberTeams = and(
    eq(workspaceUserTeam.workspaceId, input.workspaceId),
    eq(workspaceUserTeam.userId, input.userId),
  );
  yield* q.exec(q.orm.delete(workspaceUserTeam).where(memberTeams));
  if (input.active)
    for (const teamId of new Set(input.teamIds))
      yield* q.exec(
        q.orm
          .insert(workspaceUserTeam)
          .values({ workspaceId: input.workspaceId, userId: input.userId, teamId }),
      );
  if (!input.active)
    yield* q.exec(
      q.orm
        .delete(workspaceSession)
        .where(
          and(
            eq(workspaceSession.workspaceId, input.workspaceId),
            eq(workspaceSession.userId, input.userId),
          ),
        ),
    );
  const current = (yield* workspaceMemberSteps(q, input.workspaceId, input.userId))!;
  if (
    previous === null ||
    previous.active !== input.active ||
    previous.role !== current.role ||
    previous.teamIds.join() !== current.teamIds.join()
  )
    yield* auditWorkspaceAccessSteps(q, {
      workspaceId: input.workspaceId,
      userId: input.userId,
      action: input.active ? "membership.synced" : "membership.revoked",
      subject: input.userId,
      now: input.now,
    });
  return true;
}

export function syncWorkspaceMember(db: Database, input: WorkspaceMemberSync): boolean {
  return settled(sqliteDb(db).transaction((q) => syncWorkspaceMemberSteps(q, input)));
}

type LinearUserChange = {
  organizationId: string;
  userId: string;
  active: boolean | null;
  guest: boolean | null;
  now: number;
};

export function* applyLinearUserChangeSteps(q: Q, input: LinearUserChange) {
  const workspace = yield* workspaceForOrganizationSteps(q, input.organizationId);
  const member = workspace && (yield* workspaceLinearMemberSteps(q, workspace.id, input.userId));
  if (!member) return false;
  // A Linear guest has no access to Paws, the same as a deactivated account.
  if (input.active === false || input.guest === true)
    return yield* syncWorkspaceMemberSteps(q, {
      workspaceId: member.workspaceId,
      userId: member.userId,
      active: false,
      role: "member",
      teamIds: member.teamIds,
      now: Math.max(input.now, member.checkedAt),
    });
  const { workspaceMember } = q.t;
  yield* q.exec(
    q.orm
      .update(workspaceMember)
      .set({ checkedAt: 0 })
      .where(
        and(
          eq(workspaceMember.workspaceId, member.workspaceId),
          eq(workspaceMember.userId, member.userId),
        ),
      ),
  );
  return true;
}

export function applyLinearUserChange(db: Database, input: LinearUserChange): boolean {
  return settled(sqliteDb(db).transaction((q) => applyLinearUserChangeSteps(q, input)));
}

type WorkspaceBootstrapInput = { tokenHash: string; organizationId: string; expiresAt: number };

export function* createWorkspaceBootstrapSteps(q: Q, input: WorkspaceBootstrapInput) {
  yield* q.exec(q.orm.insert(q.t.workspaceBootstrap).values(input));
}

export function createWorkspaceBootstrap(db: Database, input: WorkspaceBootstrapInput): void {
  settled(sqliteDb(db).run((q) => createWorkspaceBootstrapSteps(q, input)));
}

type WorkspaceBootstrapClaim = WorkspaceRecord & { tokenHash: string; userId: string; now: number };

export function* consumeWorkspaceBootstrapSteps(q: Q, input: WorkspaceBootstrapClaim) {
  const { workspace, workspaceBootstrap: bootstrap, workspaceMember } = q.t;
  const claimed = yield* q.all(
    q.orm
      .update(bootstrap)
      .set({ consumedAt: input.now })
      .where(
        and(
          eq(bootstrap.tokenHash, input.tokenHash),
          eq(bootstrap.organizationId, input.organizationId),
          gt(bootstrap.expiresAt, input.now),
          isNull(bootstrap.consumedAt),
        ),
      )
      .returning({ tokenHash: bootstrap.tokenHash }),
  );
  if (claimed.length !== 1) throw new Error("Workspace bootstrap is invalid or expired.");
  if ((yield* workspaceForOrganizationSteps(q, input.organizationId)) !== null)
    throw new Error("This workspace already has an admin.");
  yield* q.exec(
    q.orm.insert(workspace).values({
      id: input.id,
      linearOrganizationId: input.organizationId,
      name: input.name,
      createdAt: input.now,
    }),
  );
  yield* q.exec(
    q.orm.insert(workspaceMember).values({
      workspaceId: input.id,
      userId: input.userId,
      role: "admin",
      source: "manual",
      active: 1,
      checkedAt: input.now,
    }),
  );
  yield* auditWorkspaceAccessSteps(q, {
    workspaceId: input.id,
    userId: input.userId,
    action: "workspace.bootstrapped",
    subject: input.id,
    now: input.now,
  });
  return { id: input.id, organizationId: input.organizationId, name: input.name };
}

export function consumeWorkspaceBootstrap(
  db: Database,
  input: WorkspaceBootstrapClaim,
): WorkspaceRecord {
  return settled(sqliteDb(db).transaction((q) => consumeWorkspaceBootstrapSteps(q, input)));
}

export function* saveWorkspaceSessionSteps(q: Q, session: WorkspaceSession) {
  yield* q.exec(q.orm.insert(q.t.workspaceSession).values(session));
}

export function saveWorkspaceSession(db: Database, session: WorkspaceSession): void {
  settled(sqliteDb(db).run((q) => saveWorkspaceSessionSteps(q, session)));
}

export function* readWorkspaceSessionSteps(q: Q, tokenHash: string, now: number, lifetime: number) {
  const { workspaceSession } = q.t;
  const session = yield* q.one(
    q.orm
      .select({
        tokenHash: workspaceSession.tokenHash,
        userId: workspaceSession.userId,
        workspaceId: workspaceSession.workspaceId,
        csrfToken: workspaceSession.csrfToken,
        authenticatedAt: workspaceSession.authenticatedAt,
        lastSeenAt: workspaceSession.lastSeenAt,
        expiresAt: workspaceSession.expiresAt,
      })
      .from(workspaceSession)
      .where(and(eq(workspaceSession.tokenHash, tokenHash), gt(workspaceSession.expiresAt, now))),
  );
  if (session === undefined) {
    yield* deleteWorkspaceSessionSteps(q, tokenHash);
    return null;
  }
  if (now < session.authenticatedAt) return null;
  const expiresAt = now + lifetime;
  yield* q.exec(
    q.orm
      .update(workspaceSession)
      .set({ lastSeenAt: now, expiresAt })
      .where(eq(workspaceSession.tokenHash, tokenHash)),
  );
  return { ...session, lastSeenAt: now, expiresAt };
}

export function readWorkspaceSession(
  db: Database,
  tokenHash: string,
  now: number,
  lifetime: number,
): WorkspaceSession | null {
  return settled(
    sqliteDb(db).transaction((q) => readWorkspaceSessionSteps(q, tokenHash, now, lifetime)),
  );
}

export function* deleteWorkspaceSessionSteps(q: Q, tokenHash: string) {
  const { workspaceSession } = q.t;
  yield* q.exec(q.orm.delete(workspaceSession).where(eq(workspaceSession.tokenHash, tokenHash)));
}

export function deleteWorkspaceSession(db: Database, tokenHash: string): void {
  settled(sqliteDb(db).run((q) => deleteWorkspaceSessionSteps(q, tokenHash)));
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

export function* listWorkspaceAuditSteps(q: Q, workspaceId: string, before: number) {
  const { workspaceAccessAudit: audit, workspaceUser: user } = q.t;
  const rows = yield* q.all(
    q.orm
      .select({
        id: audit.id,
        actorId: audit.userId,
        actorName: user.name,
        action: audit.action,
        subject: audit.subject,
        createdAt: audit.createdAt,
      })
      .from(audit)
      .leftJoin(user, eq(user.id, audit.userId))
      .where(and(eq(audit.workspaceId, workspaceId), lt(audit.id, before)))
      .orderBy(desc(audit.id))
      .limit(51),
  );
  const entries = rows.slice(0, 50);
  return { entries, nextBefore: rows.length > 50 ? entries.at(-1)!.id : null };
}

export function listWorkspaceAudit(db: Database, workspaceId: string, before: number) {
  return settled(sqliteDb(db).run((q) => listWorkspaceAuditSteps(q, workspaceId, before)));
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

export function* lastPausedBySteps(q: Q, itemId: string) {
  const { workspaceAccessAudit, workspaceUser } = q.t;
  const row = yield* q.one(
    q.orm
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
      .limit(1),
  );
  return row?.name ?? null;
}

export function lastPausedBy(db: Database, itemId: string): string | null {
  return settled(sqliteDb(db).run((q) => lastPausedBySteps(q, itemId)));
}
