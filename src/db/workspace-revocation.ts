import type { Database } from "bun:sqlite";
import { TERMINAL_WORK_ITEM_STATES } from "../core";
import { applyLinearCommand } from "./commands";
import { delegatedLinearUserIdSql } from "./linear-sessions";
import { immediate } from "./tx";
import {
  auditWorkspaceAccess,
  workspaceMember,
  workspaceMemberUsable,
  WORKSPACE_REVOKED_RESPONSE,
  type WorkspaceRole,
} from "./workspace";

/** Persist the access cut-off and stop its work in the same write transaction. */
export function changeWorkspaceRevocation(
  db: Database,
  input: { workspaceId: string; actorId: string; userId: string; revoked: boolean; now: number },
): string[] {
  return immediate(db, () => {
    const actor = workspaceMember(db, input.workspaceId, input.actorId);
    if (!workspaceMemberUsable(actor) || actor.role !== "admin")
      throw new Error("Workspace administration is required.");
    const member = workspaceMember(db, input.workspaceId, input.userId);
    if (!member) throw new Error("Choose a workspace member.");
    if (input.revoked && input.actorId === input.userId)
      throw new Error("You cannot revoke your own access.");
    // The usable admin actor remains; refusing self-revocation also protects the last admin.
    if ((member.revokedAt !== null) === input.revoked) return [];
    db.run(
      "UPDATE workspace_member SET revoked_at=?,revoked_by=? WHERE workspace_id=? AND user_id=?",
      [
        input.revoked ? input.now : null,
        input.revoked ? input.actorId : null,
        input.workspaceId,
        input.userId,
      ],
    );
    const stopped: string[] = [];
    if (input.revoked) {
      db.run(
        `UPDATE member_vm SET runner_id=NULL,updated_at=? WHERE runner_id IN (
          SELECT id FROM runner WHERE workspace_id=? AND owner_user_id=?)`,
        [input.now, input.workspaceId, input.userId],
      );
      const items = memberOpenItems(db, input.workspaceId, input.userId, member.linearUserId);
      for (const item of items) {
        const result = applyLinearCommand(
          db,
          {
            type: "stop",
            source: "dashboard",
            itemId: item.id,
            requestedAt: input.now,
          },
          input.now,
          WORKSPACE_REVOKED_RESPONSE,
          { responseOnly: true, keepPullRequest: true },
        );
        // A merge call in flight queues the Stop durably; it applies once GitHub answers.
        if (result.deferred) continue;
        if (!result.applied)
          throw new Error("Work changed before access could be revoked. Try again.");
        stopped.push(item.id);
      }
    }
    auditWorkspaceAccess(db, {
      ...input,
      userId: input.actorId,
      subject: input.userId,
      action: input.revoked ? "workspace.member_revoked" : "workspace.member_restored",
    });
    return stopped;
  });
}

function memberOpenItems(
  db: Database,
  workspaceId: string,
  userId: string,
  linearUserId: string,
): { id: string }[] {
  const excludedStates = [...TERMINAL_WORK_ITEM_STATES, "manual"];
  return db
    .query<{ id: string }, string[]>(
      `SELECT i.id FROM work_item i
       LEFT JOIN linear_session s ON s.session_id=i.session_key
       JOIN workspace w ON w.id=?
       WHERE (s.organization_id IS NULL OR s.organization_id=w.linear_organization_id)
         AND (i.owner_user_id=? OR
           (i.owner_user_id IS NULL AND ${delegatedLinearUserIdSql("i", "s")}=?))
         AND i.state NOT IN (${excludedStates.map(() => "?").join(",")})`,
    )
    .all(workspaceId, userId, linearUserId, ...excludedStates);
}

export type WorkspaceMemberSummary = {
  id: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  active: number;
  revokedAt: number | null;
  revokedBy: string | null;
  revokedByName: string | null;
  lastSignInAt: number | null;
  runners: number;
  openItems: number;
};

export function listWorkspaceMemberSummaries(
  db: Database,
  workspaceId: string,
): WorkspaceMemberSummary[] {
  const members = db
    .query<
      Omit<WorkspaceMemberSummary, "openItems"> & { linearUserId: string },
      [string, string]
    >(
      `SELECT u.id,u.name,u.email,u.linear_user_id AS linearUserId,m.role,m.active,
         m.revoked_at AS revokedAt,m.revoked_by AS revokedBy,r.name AS revokedByName,
         (SELECT max(a.created_at) FROM workspace_access_audit a
           WHERE a.workspace_id=? AND a.action='session.created' AND a.subject=u.id) AS lastSignInAt,
         (SELECT count(*) FROM runner x WHERE x.workspace_id=m.workspace_id
           AND x.owner_user_id=u.id AND x.revoked_at IS NULL) AS runners
       FROM workspace_member m JOIN workspace_user u ON u.id=m.user_id
       LEFT JOIN workspace_user r ON r.id=m.revoked_by
       WHERE m.workspace_id=? ORDER BY u.name,u.id`,
    )
    .all(workspaceId, workspaceId);
  return members.map(({ linearUserId, ...member }) => ({
    ...member,
    openItems: memberOpenItems(db, workspaceId, member.id, linearUserId).length,
  }));
}
