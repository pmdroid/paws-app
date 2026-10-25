import type { Database } from "bun:sqlite";
import { workspaceMember } from "../db";
import type { EligibleRunner, EligibleRunnerReason, EligibleRunnersInput } from "./index";

/** A runner that has not sent a heartbeat for this long is offline. */
export const RUNNER_ONLINE_MS = 60_000;

type Row = Omit<EligibleRunner, "eligible" | "reason"> & {
  status: string;
  lastSeenAt: number | null;
  cancelPending: number;
};

/**
 * Every unrevoked runner in the workspace, with whether the person who owns the work may run it
 * there and the one reason why. Reads SQLite only.
 *
 * A runner is eligible when the work's owner owns it (`own`), or when it is shared and owned by
 * a lead of a Linear project in the delegation (`lead-shared`), and its owner is an active,
 * non-observer member who is an owner, admin or in the issue's team, and it is online and active,
 * and for anything but `prepare` its agent sign-in has not expired and for `work` the agent is
 * signed in and ready.
 *
 * An ineligible runner reports the first failing check, in this order: who may use it
 * (`not-yours`, `not-shared`, `no-project-lead`), then its owner (`owner-inactive`,
 * `owner-not-in-team`), then the runner (`offline`, `paused`), then the agent (`auth-expired`,
 * `agent-not-signed-in`).
 */
export function eligibleRunners(db: Database, input: EligibleRunnersInput): EligibleRunner[] {
  const at = input.now ?? Date.now();
  const rows = db
    .query<Row, [string, string]>(
      `SELECT r.id,r.workspace_id AS workspaceId,r.owner_user_id AS ownerId,r.status,
       r.last_seen_at AS lastSeenAt,
       COALESCE(p.sharing,0) AS sharing,
       COALESCE(a.ready,0) AS ready,COALESCE(a.auth_expired,0) AS authExpired,
       COALESCE(a.quota_state,'ok') AS quotaState,COALESCE(a.cooldown_until,0) AS cooldownUntil,
       COALESCE(a.virtual_finish,0) AS virtualFinish,COALESCE(a.last_used_at,0) AS lastUsedAt,
       a.resolved_model AS resolvedModel,
       EXISTS(SELECT 1 FROM runner_command c WHERE c.runner_id=r.id AND c.kind='cancel' AND c.acknowledged_at IS NULL AND NOT EXISTS(SELECT 1 FROM runner_command a WHERE a.runner_id=c.runner_id AND a.run_id=c.run_id AND a.generation=c.generation AND a.kind='cancel' AND a.ordinal>c.ordinal AND a.acknowledged_at IS NOT NULL)) AS cancelPending
       FROM runner r
       LEFT JOIN runner_policy p ON p.runner_id=r.id
       LEFT JOIN runner_agent_policy a ON a.runner_id=r.id AND a.agent=?
       WHERE r.workspace_id=? AND r.revoked_at IS NULL AND r.status<>'revoked'
       ORDER BY r.id`,
    )
    .all(input.agent, input.workspaceId);
  return rows.map(({ status, lastSeenAt, cancelPending, ...runner }) => {
    const reason = ((): EligibleRunnerReason => {
      const own = input.ownerUserId !== null && runner.ownerId === input.ownerUserId;
      if (!own) {
        if (input.leadUserIds.includes(runner.ownerId)) {
          if (runner.sharing !== 1) return "not-shared";
        } else if (runner.sharing === 1 && input.leadUserIds.length === 0) return "no-project-lead";
        else return "not-yours";
      }
      const member = workspaceMember(db, input.workspaceId, runner.ownerId);
      if (!member?.active || member.role === "observer") return "owner-inactive";
      if (!["owner", "admin"].includes(member.role) && !member.teamIds.includes(input.teamId))
        return "owner-not-in-team";
      // A runner that has not acknowledged a cancel is not taking commands, so it counts as offline.
      if ((lastSeenAt ?? 0) <= at - RUNNER_ONLINE_MS || cancelPending) return "offline";
      if (status !== "active") return "paused";
      if (input.purpose !== "prepare" && runner.authExpired === 1) return "auth-expired";
      if (input.purpose === "work" && runner.ready !== 1) return "agent-not-signed-in";
      return own ? "own" : "lead-shared";
    })();
    return { ...runner, eligible: reason === "own" || reason === "lead-shared", reason };
  });
}
