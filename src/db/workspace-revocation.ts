import type { Database } from "bun:sqlite";
import { applyLinearCommand } from "./commands";
import { immediate } from "./tx";
import {
  auditWorkspaceAccess,
  workspaceMember,
  workspaceMemberUsable,
  workspaceMemberUsableSql,
  WORKSPACE_REVOKED_RESPONSE,
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
    if (input.revoked && workspaceMemberUsable(member) && member.role === "admin") {
      const admins = db
        .query<{ count: number }, [string]>(
          `SELECT count(*) AS count FROM workspace_member WHERE workspace_id=? AND role='admin'
         AND ${workspaceMemberUsableSql("workspace_member")}`,
        )
        .get(input.workspaceId)!.count;
      if (admins <= 1) throw new Error("The workspace must keep an active admin.");
    }
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
      const items = db
        .query<{ id: string }, [string, string]>(
          `SELECT i.id FROM work_item i JOIN linear_session s ON s.session_id=i.session_key
         JOIN workspace w ON w.linear_organization_id=s.organization_id
         WHERE w.id=? AND s.creator_id=? AND i.state NOT IN ('completed','merged','cancelled','manual')`,
        )
        .all(input.workspaceId, member.linearUserId);
      for (const item of items) {
        if (
          !applyLinearCommand(
            db,
            {
              type: "stop",
              source: "dashboard",
              itemId: item.id,
              requestedAt: input.now,
            },
            input.now,
            WORKSPACE_REVOKED_RESPONSE,
            { responseOnly: true },
          ).applied
        )
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
