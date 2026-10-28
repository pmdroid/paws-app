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
      const excludedStates = [...TERMINAL_WORK_ITEM_STATES, "manual"];
      const items = db
        .query<{ id: string }, string[]>(
          `SELECT i.id FROM work_item i
           LEFT JOIN linear_session s ON s.session_id=i.session_key
           JOIN workspace w ON w.id=?
           WHERE (s.organization_id IS NULL OR s.organization_id=w.linear_organization_id)
             AND (i.owner_user_id=? OR
               (i.owner_user_id IS NULL AND ${delegatedLinearUserIdSql("i", "s")}=?))
             AND i.state NOT IN (${excludedStates.map(() => "?").join(",")})`,
        )
        .all(input.workspaceId, input.userId, member.linearUserId, ...excludedStates);
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
            { responseOnly: true, keepPullRequest: true },
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
