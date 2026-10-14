import type { Database } from "bun:sqlite";
import { workspaceMember } from "../db";
import type { RunnerCommand } from "../runner-protocol";

export function authorizeRunnerAccount(db: Database, command: RunnerCommand) {
  const agent =
    "profile" in command ? command.profile.agent : "agent" in command ? command.agent : null;
  if (!agent) return;
  const configured = db
    .query("SELECT 1 FROM runner_member_account WHERE runner_id=?")
    .get(command.runnerId);
  if (!command.memberId) {
    if (configured) throw new Error("Select a member account for this runner");
    return;
  }
  authorizeRunnerMember(db, { ...command, memberId: command.memberId });
  if (command.type === "login_check") return;
  if (
    !db
      .query(
        "SELECT 1 FROM runner_member_account WHERE runner_id=? AND user_id=? AND agent=? AND connected=1",
      )
      .get(command.runnerId, command.memberId, agent)
  )
    throw new Error("Member agent account requires sign-in");
}

export function authorizeRunnerMember(
  db: Database,
  scope: { workspaceId: string; runnerId: string; memberId: string },
) {
  const member = workspaceMember(db, scope.workspaceId, scope.memberId);
  if (!member?.active || member.role === "observer")
    throw new Error("Runner account membership is unavailable");
  const host = db
    .query<{ ownerId: string; sharing: number }, [string, string]>(
      "SELECT r.owner_user_id AS ownerId,COALESCE(p.sharing,0) AS sharing FROM runner r LEFT JOIN runner_policy p ON p.runner_id=r.id WHERE r.id=? AND r.workspace_id=? AND r.status='active' AND r.revoked_at IS NULL",
    )
    .get(scope.runnerId, scope.workspaceId);
  if (!host || (host.ownerId !== scope.memberId && host.sharing !== 1))
    throw new Error("Runner host sharing is unavailable");
}
