import { isWorkspaceAdmin } from "../workspace";
import type { Database } from "bun:sqlite";
import {
  delegatedLinearUserIdSteps,
  delegationLeadUserIdsSteps,
  eligibleRunnerRowsSteps,
  getWorkItemRepositorySteps,
  itemOwnerScopeRowSteps,
  lastItemRunnerSteps,
  runnerHostVersionSteps,
  runnerNameSteps,
  runnerRepositoryRefusalSteps,
  settled,
  sqliteDb,
  workspaceMemberSteps,
  workspaceMemberUsable,
  workspaceUserIdForLinearUserSteps,
  type Q,
  type Steps,
} from "../db";
import { REPOSITORY_COMMAND_RUNNER_VERSION, runnerReleaseAtLeast } from "../runner-protocol";
import type {
  EligibleRunner,
  EligibleRunnerReason,
  EligibleRunnersInput,
  RepositoryRefusal,
  RunnerSetupNeed,
} from "./index";

/** A runner that has not sent a heartbeat for this long is offline. */
export const RUNNER_ONLINE_MS = 60_000;

/**
 * Every unrevoked runner in the workspace, with whether the person who owns the work may run it
 * there and the one reason why.
 * A runner is eligible when the work's owner owns it (`own`), or when it is shared and owned by
 * a lead of a Linear project in the delegation (`lead-shared`), and its owner is an active
 * member who is an admin or in the issue's team, and it is online and active,
 * and for anything but `prepare` its agent sign-in has not expired and for `work` the agent is
 * signed in and ready.
 *
 * An ineligible runner reports the first failing check, in this order: who may use it
 * (`not-yours`, `not-shared`, `no-project-lead`), then its owner (`owner-inactive`,
 * `owner-not-in-team`), then the runner (`offline`, `paused`), then the agent (`auth-expired`,
 * `agent-not-signed-in`).
 */
export function* eligibleRunnersSteps(q: Q, input: EligibleRunnersInput): Steps<EligibleRunner[]> {
  const at = input.now ?? Date.now();
  const rows = yield* eligibleRunnerRowsSteps(
    q,
    input.workspaceId,
    input.agent,
    input.includeRevoked === true,
  );
  const runners: EligibleRunner[] = [];
  for (const { status, revokedAt, lastSeenAt, ...runner } of rows) {
    const reason = yield* reasonSteps();
    runners.push({ ...runner, eligible: reason === "own" || reason === "lead-shared", reason });
    function* reasonSteps(): Steps<EligibleRunnerReason> {
      if (revokedAt !== null || status === "revoked") return "revoked";
      const own = input.ownerUserId !== null && runner.ownerId === input.ownerUserId;
      if (!own) {
        if (input.leadUserIds.includes(runner.ownerId)) {
          if (runner.sharing !== 1) return "not-shared";
        } else if (runner.sharing === 1 && input.leadUserIds.length === 0) return "no-project-lead";
        else return "not-yours";
      }
      const member = yield* workspaceMemberSteps(q, input.workspaceId, runner.ownerId);
      if (!workspaceMemberUsable(member)) return "owner-inactive";
      if (!isWorkspaceAdmin(member.role) && !member.teamIds.includes(input.teamId))
        return "owner-not-in-team";
      if ((lastSeenAt ?? 0) <= at - RUNNER_ONLINE_MS) return "offline";
      if (status !== "active") return "paused";
      if (input.purpose !== "prepare" && runner.authExpired === 1) return "auth-expired";
      if (input.purpose === "work" && runner.ready !== 1) return "agent-not-signed-in";
      return own ? "own" : "lead-shared";
    }
  }
  return runners;
}

export function eligibleRunners(db: Database, input: EligibleRunnersInput): EligibleRunner[] {
  return settled(sqliteDb(db).run((q) => eligibleRunnersSteps(q, input)));
}

function* runnerNameOrIdSteps(q: Q, runnerId: string) {
  return (yield* runnerNameSteps(q, runnerId)) ?? runnerId;
}

/**
 * Why `ownerUserId` has no runner Paws may use for `agent`, from `eligibleRunners` with purpose
 * `work`. Null when a runner is eligible, busy or not, or one the owner may use is only offline
 * or paused and comes back on its own.
 */
export function* runnerSetupNeedSteps(
  q: Q,
  runners: readonly EligibleRunner[],
  owner: { ownerUserId: string | null; leadUserIds: readonly string[] },
  agent: string,
): Steps<RunnerSetupNeed | null> {
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
      runnerName: yield* runnerNameOrIdSteps(q, signIn.id),
      agent,
    };
  const usable = (runner: EligibleRunner) =>
    runner.ownerId === owner.ownerUserId ||
    (runner.sharing === 1 && owner.leadUserIds.includes(runner.ownerId));
  if (runners.some((runner) => usable(runner) && ["offline", "paused"].includes(runner.reason)))
    return null;
  return { reason: "no-runner" };
}

export function runnerSetupNeed(
  db: Database,
  runners: readonly EligibleRunner[],
  owner: { ownerUserId: string | null; leadUserIds: readonly string[] },
  agent: string,
): RunnerSetupNeed | null {
  return settled(sqliteDb(db).run((q) => runnerSetupNeedSteps(q, runners, owner, agent)));
}

/** The workspace, team, owner and project leads of a work item, or null when one is unknown. */
export function* itemOwnerScopeSteps(q: Q, itemId: string) {
  const scope = yield* itemOwnerScopeRowSteps(q, itemId);
  if (!scope?.workspaceId || !scope.teamId) return null;
  const delegator = yield* delegatedLinearUserIdSteps(q, itemId);
  const ownerUserId =
    scope.ownerUserId ??
    (delegator ? yield* workspaceUserIdForLinearUserSteps(q, delegator) : null);
  if (!ownerUserId) return null;
  // The leads of the Linear projects across the item's delegation lend their shared runners.
  const leadUserIds = yield* delegationLeadUserIdsSteps(q, scope.delegationId);
  return { workspaceId: scope.workspaceId, teamId: scope.teamId, ownerUserId, leadUserIds };
}

export function itemOwnerScope(db: Database, itemId: string) {
  return settled(sqliteDb(db).run((q) => itemOwnerScopeSteps(q, itemId)));
}

type ItemRunnerInput = { itemId: string; agent: string; now?: number };

function* itemWorkRunnersSteps(q: Q, input: ItemRunnerInput) {
  const scope = yield* itemOwnerScopeSteps(q, input.itemId);
  if (!scope) return null;
  const runners = yield* eligibleRunnersSteps(q, {
    ...scope,
    agent: input.agent,
    purpose: "work",
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return { scope, runners };
}

/**
 * Whether the person who owns a work item has a runner they may use for its work right now, by
 * the same check placement uses. Null when the item has no Linear session,
 * workspace, team or owner yet, so the caller keeps its usual behavior.
 */
export function* itemOwnerHasEligibleRunnerSteps(q: Q, input: ItemRunnerInput) {
  const found = yield* itemWorkRunnersSteps(q, input);
  return found === null ? null : found.runners.some((runner) => runner.eligible);
}

export function itemOwnerHasEligibleRunner(db: Database, input: ItemRunnerInput): boolean | null {
  return settled(sqliteDb(db).run((q) => itemOwnerHasEligibleRunnerSteps(q, input)));
}

/**
 * Why the owner of a work item has no runner Paws may use, as `runnerSetupNeed` decides it. Null
 * when a runner is usable or only offline, or when the item's scope is not known yet.
 */
export function* itemOwnerRunnerSetupNeedSteps(q: Q, input: ItemRunnerInput) {
  const found = yield* itemWorkRunnersSteps(q, input);
  return found === null
    ? null
    : yield* runnerSetupNeedSteps(q, found.runners, found.scope, input.agent);
}

export function itemOwnerRunnerSetupNeed(
  db: Database,
  input: ItemRunnerInput,
): RunnerSetupNeed | null {
  return settled(sqliteDb(db).run((q) => itemOwnerRunnerSetupNeedSteps(q, input)));
}

/**
 * A runner the owner of a work item may use for its work right now, for the line that says where
 * a held item starts. The owner's own runner comes first, then by name. Placement still makes
 * its own choice among every eligible runner. Null when none is eligible or the scope is unknown.
 */
export function* itemOwnerEligibleRunnerSteps(q: Q, input: ItemRunnerInput) {
  const found = yield* itemWorkRunnersSteps(q, input);
  if (!found) return null;
  const named: { id: string; own: boolean; name: string }[] = [];
  for (const runner of found.runners)
    if (runner.eligible)
      named.push({
        id: runner.id,
        own: runner.ownerId === found.scope.ownerUserId,
        name: yield* runnerNameOrIdSteps(q, runner.id),
      });
  named.sort((a, b) => Number(b.own) - Number(a.own) || a.name.localeCompare(b.name));
  return named[0] ? { id: named[0].id, name: named[0].name } : null;
}

export function itemOwnerEligibleRunner(
  db: Database,
  input: ItemRunnerInput,
): { id: string; name: string } | null {
  return settled(sqliteDb(db).run((q) => itemOwnerEligibleRunnerSteps(q, input)));
}

export function* itemRepositoryRunnerSteps(q: Q, input: { itemId: string; now?: number }) {
  const scope = yield* itemOwnerScopeSteps(q, input.itemId);
  if (!scope) return null;
  const last = yield* lastItemRunnerSteps(q, input.itemId);
  const eligible: EligibleRunner[] = [];
  for (const runner of yield* eligibleRunnersSteps(q, {
    ...scope,
    agent: last?.agent ?? "",
    purpose: "prepare",
    ...(input.now === undefined ? {} : { now: input.now }),
  }))
    if (
      runner.eligible &&
      runnerReleaseAtLeast(
        yield* runnerHostVersionSteps(q, runner.id),
        REPOSITORY_COMMAND_RUNNER_VERSION,
      )
    )
      eligible.push(runner);
  const runner =
    eligible.find((candidate) => candidate.id === last?.runnerId) ??
    eligible.find((candidate) => candidate.ownerId === scope.ownerUserId) ??
    eligible[0];
  return runner ? { id: runner.id, workspaceId: runner.workspaceId } : null;
}

export function itemRepositoryRunner(
  db: Database,
  input: { itemId: string; now?: number },
): { id: string; workspaceId: string } | null {
  return settled(sqliteDb(db).run((q) => itemRepositoryRunnerSteps(q, input)));
}

const OUT_OF_SCOPE = new Set<EligibleRunnerReason>([
  "not-yours",
  "not-shared",
  "no-project-lead",
  "revoked",
  "owner-inactive",
  "owner-not-in-team",
]);

export function isInRunnerScope(reason: EligibleRunnerReason): boolean {
  return !OUT_OF_SCOPE.has(reason);
}

function* itemRepositoryRunnersSteps(q: Q, input: { itemId: string; now?: number }) {
  const scope = yield* itemOwnerScopeSteps(q, input.itemId);
  const binding = yield* getWorkItemRepositorySteps(q, input.itemId);
  if (!scope || !binding) return null;
  const runners = (yield* eligibleRunnersSteps(q, {
    ...scope,
    agent: "",
    purpose: "prepare",
    ...(input.now === undefined ? {} : { now: input.now }),
  })).filter((runner) => !OUT_OF_SCOPE.has(runner.reason));
  return { repository: `${binding.owner}/${binding.repo}`, runners };
}

export function* itemRepositoryAllowedOnSteps(
  q: Q,
  input: { itemId: string; runnerId: string; now?: number },
) {
  const found = yield* itemRepositoryRunnersSteps(q, input);
  return (
    found !== null &&
    found.runners.some((runner) => runner.id === input.runnerId) &&
    (yield* runnerRepositoryRefusalSteps(q, input.runnerId, found.repository)) === null
  );
}

export function itemRepositoryAllowedOn(
  db: Database,
  input: { itemId: string; runnerId: string; now?: number },
): boolean {
  return settled(sqliteDb(db).run((q) => itemRepositoryAllowedOnSteps(q, input)));
}

export function* itemRepositoryRefusalsSteps(q: Q, input: { itemId: string; now?: number }) {
  const found = yield* itemRepositoryRunnersSteps(q, input);
  if (!found || found.runners.length === 0) return null;
  const { repository, runners } = found;
  const refusals: RepositoryRefusal[] = [];
  for (const runner of runners) {
    const refusal = yield* runnerRepositoryRefusalSteps(q, runner.id, repository);
    if (refusal === null) return null;
    refusals.push({
      runnerId: runner.id,
      runnerName: yield* runnerNameOrIdSteps(q, runner.id),
      code: refusal.list === "admin" ? "repository_admin" : "repository_host",
      allowed: refusal.allowed,
    });
  }
  return { repository, refusals };
}

export function itemRepositoryRefusals(
  db: Database,
  input: { itemId: string; now?: number },
): { repository: string; refusals: RepositoryRefusal[] } | null {
  return settled(sqliteDb(db).run((q) => itemRepositoryRefusalsSteps(q, input)));
}
