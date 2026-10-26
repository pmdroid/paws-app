import { isWorkspaceAdmin } from "../workspace";
import type { Database } from "bun:sqlite";
import { delegatedLinearUserId, workspaceMember } from "../db";
import type {
  EligibleRunner,
  EligibleRunnerReason,
  EligibleRunnersInput,
  RunnerSetupNeed,
} from "./index";

/** A runner that has not sent a heartbeat for this long is offline. */
export const RUNNER_ONLINE_MS = 60_000;

type Row = Omit<EligibleRunner, "eligible" | "reason"> & {
  status: string;
  revokedAt: number | null;
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
    .query<Row, [string, string, number]>(
      `SELECT r.id,r.workspace_id AS workspaceId,r.owner_user_id AS ownerId,r.status,
       r.last_seen_at AS lastSeenAt,r.revoked_at AS revokedAt,
       COALESCE(p.sharing,0) AS sharing,
       COALESCE(a.ready,0) AS ready,COALESCE(a.auth_expired,0) AS authExpired,
       COALESCE(a.quota_state,'ok') AS quotaState,COALESCE(a.cooldown_until,0) AS cooldownUntil,
       COALESCE(a.virtual_finish,0) AS virtualFinish,COALESCE(a.last_used_at,0) AS lastUsedAt,
       a.resolved_model AS resolvedModel,
       EXISTS(SELECT 1 FROM runner_command c WHERE c.runner_id=r.id AND c.kind='cancel' AND c.acknowledged_at IS NULL AND NOT EXISTS(SELECT 1 FROM runner_command a WHERE a.runner_id=c.runner_id AND a.run_id=c.run_id AND a.generation=c.generation AND a.kind='cancel' AND a.ordinal>c.ordinal AND a.acknowledged_at IS NOT NULL)) AS cancelPending
       FROM runner r
       LEFT JOIN runner_policy p ON p.runner_id=r.id
       LEFT JOIN runner_agent_policy a ON a.runner_id=r.id AND a.agent=?
       WHERE r.workspace_id=? AND (?=1 OR (r.revoked_at IS NULL AND r.status<>'revoked'))
       ORDER BY r.id`,
    )
    .all(input.agent, input.workspaceId, input.includeRevoked ? 1 : 0);
  return rows.map(({ status, revokedAt, lastSeenAt, cancelPending, ...runner }) => {
    const reason = ((): EligibleRunnerReason => {
      if (revokedAt !== null || status === "revoked") return "revoked";
      const own = input.ownerUserId !== null && runner.ownerId === input.ownerUserId;
      if (!own) {
        if (input.leadUserIds.includes(runner.ownerId)) {
          if (runner.sharing !== 1) return "not-shared";
        } else if (runner.sharing === 1 && input.leadUserIds.length === 0) return "no-project-lead";
        else return "not-yours";
      }
      const member = workspaceMember(db, input.workspaceId, runner.ownerId);
      if (!member?.active || member.role === "observer") return "owner-inactive";
      if (!isWorkspaceAdmin(member.role) && !member.teamIds.includes(input.teamId))
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

/**
 * Why `ownerUserId` has no runner Paws may use for `agent`, from `eligibleRunners` with purpose
 * `work`. Null when a runner is eligible, busy or not, or one the owner may use is only offline
 * or paused and comes back on its own.
 */
export function runnerSetupNeed(
  db: Database,
  runners: readonly EligibleRunner[],
  owner: { ownerUserId: string | null; leadUserIds: readonly string[] },
  agent: string,
): RunnerSetupNeed | null {
  if (runners.some((runner) => runner.eligible)) return null;
  const signIn = runners.find(
    (runner) =>
      runner.ownerId === owner.ownerUserId &&
      (runner.reason === "agent-not-signed-in" || runner.reason === "auth-expired"),
  );
  if (signIn)
    return {
      reason: "agent-not-signed-in",
      runnerId: signIn.id,
      runnerName:
        db.query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?").get(signIn.id)
          ?.name ?? signIn.id,
      agent,
    };
  const usable = (runner: EligibleRunner) =>
    runner.ownerId === owner.ownerUserId ||
    (runner.sharing === 1 && owner.leadUserIds.includes(runner.ownerId));
  if (runners.some((runner) => usable(runner) && ["offline", "paused"].includes(runner.reason)))
    return null;
  return { reason: "no-runner" };
}

/** The workspace, team, owner and project leads of a work item, or null when one is unknown. */
function itemOwnerScope(db: Database, itemId: string) {
  const scope = db
    .query<
      {
        workspaceId: string | null;
        teamId: string | null;
        ownerUserId: string | null;
        delegationId: string;
      },
      [string]
    >(
      `SELECT w.id AS workspaceId,s.team_id AS teamId,i.owner_user_id AS ownerUserId,i.delegation_id AS delegationId
       FROM work_item i
       LEFT JOIN linear_session s ON s.session_id=i.session_key
       LEFT JOIN workspace w ON w.linear_organization_id=s.organization_id
       WHERE i.id=?`,
    )
    .get(itemId);
  if (!scope?.workspaceId || !scope.teamId) return null;
  const delegator = delegatedLinearUserId(db, itemId);
  const ownerUserId =
    scope.ownerUserId ??
    (delegator
      ? (db
          .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id=?")
          .get(delegator)?.id ?? null)
      : null);
  if (!ownerUserId) return null;
  // The leads of the Linear projects across the item's delegation lend their shared runners.
  const leadUserIds = db
    .query<{ id: string }, [string]>(
      `SELECT DISTINCT u.id FROM work_item i
       JOIN work_item_scheduling c ON c.item_id=i.id
       JOIN workspace_user u ON u.linear_user_id=c.project_lead_id
       WHERE i.delegation_id=? ORDER BY u.id`,
    )
    .all(scope.delegationId)
    .map((row) => row.id);
  return { workspaceId: scope.workspaceId, teamId: scope.teamId, ownerUserId, leadUserIds };
}

/**
 * Whether the person who owns a work item has a runner they may use for its work right now, by
 * the same check placement uses. Reads SQLite only. Null when the item has no Linear session,
 * workspace, team or owner yet, so the caller keeps its usual behavior.
 */
export function itemOwnerHasEligibleRunner(
  db: Database,
  input: { itemId: string; agent: string; now?: number },
): boolean | null {
  const scope = itemOwnerScope(db, input.itemId);
  if (!scope) return null;
  return eligibleRunners(db, {
    ...scope,
    agent: input.agent,
    purpose: "work",
    ...(input.now === undefined ? {} : { now: input.now }),
  }).some((runner) => runner.eligible);
}

/**
 * Why the owner of a work item has no runner Paws may use, as `runnerSetupNeed` decides it. Null
 * when a runner is usable or only offline, or when the item's scope is not known yet.
 */
export function itemOwnerRunnerSetupNeed(
  db: Database,
  input: { itemId: string; agent: string; now?: number },
): RunnerSetupNeed | null {
  const scope = itemOwnerScope(db, input.itemId);
  if (!scope) return null;
  const runners = eligibleRunners(db, {
    ...scope,
    agent: input.agent,
    purpose: "work",
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return runnerSetupNeed(db, runners, scope, input.agent);
}

/**
 * A runner the owner of a work item may use for its work right now, for the line that says where
 * a held item starts. The owner's own runner comes first, then by name. Placement still makes
 * its own choice among every eligible runner. Null when none is eligible or the scope is unknown.
 */
export function itemOwnerEligibleRunner(
  db: Database,
  input: { itemId: string; agent: string; now?: number },
): { id: string; name: string } | null {
  const scope = itemOwnerScope(db, input.itemId);
  if (!scope) return null;
  const eligible = eligibleRunners(db, {
    ...scope,
    agent: input.agent,
    purpose: "work",
    ...(input.now === undefined ? {} : { now: input.now }),
  }).filter((runner) => runner.eligible);
  const named = eligible
    .map((runner) => ({
      id: runner.id,
      own: runner.ownerId === scope.ownerUserId,
      name:
        db.query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?").get(runner.id)
          ?.name ?? runner.id,
    }))
    .sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name));
  return named[0] ? { id: named[0].id, name: named[0].name } : null;
}
