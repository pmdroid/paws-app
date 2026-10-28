import {
  workspaceMemberUsableSql,
  workspaceMemberUsable,
  auditWorkspaceAccess,
  workspaceMember,
} from "./workspace";
import type { Database } from "bun:sqlite";
import { immediate } from "./tx";

export type WorkspaceIdentityLink = {
  userId: string;
  provider: "slack" | "github";
  externalId: string | null;
  installationId: string | null;
  method: "email" | "manual";
  status: "linked" | "unmatched" | "error";
  checkedAt: number;
};

export function workspaceIdentityLinks(db: Database, workspaceId: string) {
  return db
    .query<WorkspaceIdentityLink & { name: string; email: string }, [string]>(
      `SELECT l.user_id AS userId,u.name,u.email,l.provider,l.external_id AS externalId,
      l.installation_id AS installationId,l.method,l.status,l.checked_at AS checkedAt
      FROM workspace_identity_link l JOIN workspace_user u ON u.id=l.user_id
      WHERE l.workspace_id=? ORDER BY u.name,l.provider`,
    )
    .all(workspaceId);
}

export function workspaceIdentityCandidates(db: Database, workspaceId: string) {
  return db
    .query<{ userId: string; email: string }, [string]>(
      `SELECT u.id AS userId,u.email FROM workspace_user u
      JOIN workspace_member m ON m.user_id=u.id WHERE m.workspace_id=? AND ${workspaceMemberUsableSql("m")}
      AND NOT EXISTS(SELECT 1 FROM workspace_identity_link l WHERE l.workspace_id=m.workspace_id
      AND l.user_id=u.id AND l.provider='slack' AND l.method='manual') ORDER BY u.id`,
    )
    .all(workspaceId);
}

export function saveWorkspaceIdentityLink(
  db: Database,
  input: WorkspaceIdentityLink & { workspaceId: string; actorId?: string },
): void {
  immediate(db, () => {
    const member = workspaceMember(db, input.workspaceId, input.userId);
    if (!workspaceMemberUsable(member)) throw new Error("Choose an active workspace member.");
    if (input.method === "manual" || input.actorId !== undefined) {
      const actor = workspaceMember(db, input.workspaceId, input.actorId ?? "");
      if (!workspaceMemberUsable(actor) || actor.role !== "admin")
        throw new Error("Workspace administration is required.");
    }
    const changed = db.run(
      `INSERT INTO workspace_identity_link(workspace_id,user_id,provider,external_id,installation_id,method,status,checked_at)
      VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,user_id,provider) DO UPDATE SET
      external_id=excluded.external_id,installation_id=excluded.installation_id,method=excluded.method,
      status=excluded.status,checked_at=excluded.checked_at
      WHERE (? OR workspace_identity_link.method!='manual')
      AND workspace_identity_link.checked_at<=excluded.checked_at`,
      [
        input.workspaceId,
        input.userId,
        input.provider,
        input.externalId,
        input.installationId,
        input.method,
        input.status,
        input.checkedAt,
        input.method === "manual" || input.actorId !== undefined,
      ],
    ).changes;
    if (changed > 0)
      auditWorkspaceAccess(db, {
        workspaceId: input.workspaceId,
        userId: input.actorId ?? input.userId,
        action: "identity.link.changed",
        subject: `${input.userId}:${input.provider}:${input.method}:${input.status}:${input.externalId ?? ""}`,
        now: input.checkedAt,
      });
  });
}
