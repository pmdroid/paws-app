import type { Database } from "bun:sqlite";
import {
  chargeRunnerAgent,
  delegationProjectLeadIds,
  finishRunnerExecutionUsage,
  insertRunnerExecutionUsage,
  itemOwnerUserId,
  lastSuccessfulImplementation,
  linearSessionInstallation,
  quotaRecheckAt,
  runnerAgentQuota,
  runnerExecutionHistory,
  runnerExecutionReceipt,
  runnerIdentity,
  runnerPlacementPolicy,
  sessionRepositoriesAllowed,
  setRunnerAgentCooldown,
  settleRunnerAgent,
  workspaceForOrganization,
  workspaceUserIdForLinearUser,
  workspaceMemberUsable,
  getLinearSession,
  getLinearSessionAccess,
  getWorkItem,
  getWorkItemRepository,
  immediate,
  runnerHasCapacity,
  pinnedSlotsReserved,
  runnerHelperAvailability,
  runnerOccupancy,
  runnerSlotsHeldBetweenCommands,
  delegatedLinearUserId,
  workspaceMember,
  workspaceSessionIds,
  findingGroupingAdmins,
  commandAccount,
  legacyAgentBindingId,
  recordAccountObservation,
  type AccountObservation,
} from "../db";
import type { RunnerCodingAgent } from "../runner-protocol";
import type { PlacementAccount, PlacementReason, PlacementRequest, RunnerPlacement } from "./index";
import {
  eligibleRunners,
  itemRepositoryRefusals,
  runnerSetupNeed,
  RUNNER_ONLINE_MS,
} from "./eligible";
import { classifyAgentFailure } from "./account-health";
import { repositoryRejection, signInFit } from "./fit";

/** Receipt outcomes whose first `finished()` call returned `retryable: true`. */
const RETRYABLE_OUTCOMES = new Set([
  "heartbeat_lost",
  "auth_required",
  "quota_exhausted",
  "model_conflict",
]);

/**
 * The runner placement chose is no longer the one it admitted: the runner restarted, re-reported
 * its agents, another placement on it started first, or the admission expired. The work was not
 * assigned, so placing it again is safe.
 */
export class PlacementRaceError extends Error {
  override readonly name = "PlacementRaceError";
}

/** How long a continuing task waits for the busy runner that holds its agent session. */
export const SESSION_GRACE_MS = 2 * 60_000;
/** How far back finished executions count toward a runner's recent load. */
export const LOAD_HISTORY_MS = 6 * 60 * 60_000;
/** Finished work loses half its weight in recent load every hour. */
export const LOAD_HALF_LIFE_MS = 60 * 60_000;

export function createRunnerPlacement(options: {
  db: Database;
  sessionActor?: (sessionId: string) => string | undefined;
  now?: () => number;
}): RunnerPlacement {
  const { db } = options;
  const now = options.now ?? Date.now;
  const admissions = new Map<
    string,
    {
      request: PlacementRequest;
      account: PlacementAccount;
      scope: string;
      policy: string;
      reason: PlacementReason | null;
      expiresAt: number;
    }
  >();
  // Per item: since when placement has held a task for its busy session runner.
  const sessionWaits = new Map<string, { runnerId: string; since: number; seen: number }>();
  function admissionKey(
    runnerId: string,
    input: Pick<PlacementRequest, "itemId" | "sessionId" | "purpose" | "role" | "profile">,
    bindingId: string | null,
  ) {
    return JSON.stringify([
      runnerId,
      bindingId,
      input.itemId ?? null,
      input.sessionId ?? null,
      input.purpose,
      input.role,
      input.profile,
    ]);
  }
  function policy(id: string, agent?: string) {
    return JSON.stringify(runnerPlacementPolicy(db, id, agent));
  }
  function scope(input: PlacementRequest) {
    const item = input.itemId ? getWorkItem(db, input.itemId) : null;
    if (input.itemId && (!item || item.cancelRequested))
      throw new Error("Runner task is unavailable");
    const sessionId = input.sessionId ?? item?.sessionKey ?? null;
    const session = sessionId ? getLinearSession(db, sessionId) : null;
    if (
      !session ||
      (session.stoppedAt !== null && !(input.findingGroups && input.purpose === "helper")) ||
      !session.organizationId ||
      getLinearSessionAccess(db, session.sessionId) !== "allowed"
    )
      throw new Error("Runner session authority is unavailable");
    if (input.sessionId && item && item.sessionKey !== input.sessionId)
      throw new Error("Runner task session changed");
    const found = workspaceForOrganization(db, session.organizationId);
    if (!found) throw new Error("Runner workspace is unavailable");
    const workspace = { id: found.id };
    const repository = item ? getWorkItemRepository(db, item.id) : null;
    const issueId =
      item?.linearIssueId ?? session.issueId ?? (input.findingGroups ? session.sessionId : null);
    if (!issueId) throw new Error("Runner issue authority is unavailable");
    const placement = item
      ? {
          ownerUserId: itemOwnerUserId(db, item.id),
          // The leads of the Linear projects across the item's delegation lend their shared runners.
          leadUserIds: delegationProjectLeadIds(db, item.delegationId),
        }
      : null;
    const ownership = item
      ? delegatedLinearUserId(db, item.id)
      : (options.sessionActor?.(session.sessionId) ?? session.creatorId);
    return { item, session, workspace, repository, issueId, ownership, placement };
  }
  function authority(current: ReturnType<typeof scope>) {
    const item = current.item;
    return JSON.stringify({
      item: item
        ? {
            id: item.id,
            delegationId: item.delegationId,
            issueId: item.linearIssueId,
            sessionId: item.sessionKey,
            currentRunId: item.currentRunId,
            version: item.version,
            cancelRequested: item.cancelRequested,
            ownerUserId: current.placement?.ownerUserId ?? null,
            leadUserIds: current.placement?.leadUserIds ?? [],
          }
        : null,
      session: current.session,
      workspace: current.workspace,
      repository: current.repository,
      issueId: current.issueId,
      ownership: current.ownership,
      installation: linearSessionInstallation(db, current.session.sessionId),
    });
  }
  /**
   * Load per runner, both as a share of its slots. `current` counts leased work, helpers, slots
   * held between commands, and the caller's unassigned reservations. `recent` is the busy time of
   * executions that finished within LOAD_HISTORY_MS, decayed by age, so a runner that has just
   * worked long turns yields to one that has been idle even when both are free right now.
   */
  function runnerLoad(
    runnerIds: readonly string[],
    at: number,
    reserved?: ReadonlyMap<string, number>,
  ) {
    const from = at - LOAD_HISTORY_MS;
    return new Map(
      runnerIds.map((id) => {
        const { capacity, occupied } = runnerOccupancy(db, id, at);
        const slots = Math.max(capacity, 1);
        const held = runnerSlotsHeldBetweenCommands(db, id, at);
        let busy = 0;
        for (const row of runnerExecutionHistory(db, id, from, at))
          busy +=
            Math.max(0, row.endedAt - Math.max(row.startedAt, from)) *
            0.5 ** ((at - row.endedAt) / LOAD_HALF_LIFE_MS);
        return [
          id,
          {
            current: (occupied + held + (reserved?.get(id) ?? 0)) / slots,
            recent: busy / slots / LOAD_HISTORY_MS,
          },
        ];
      }),
    );
  }
  /** Who the work belongs to and where, for `eligibleRunners`. Throws when nobody may run it. */
  function eligibility(current: ReturnType<typeof scope>) {
    const teamId = linearSessionInstallation(db, current.session.sessionId)?.teamId;
    if (!teamId) throw new Error("Runner issue team is unavailable");
    const repository = current.repository
      ? `${current.repository.owner}/${current.repository.repo}`.toLowerCase()
      : null;
    if (
      repository !== null &&
      !sessionRepositoriesAllowed(db, [current.session.sessionId], [repository]).has(repository)
    )
      throw new Error("Runner repository is outside workspace access");
    const requester = current.ownership
      ? workspaceUserIdForLinearUser(db, current.ownership)
      : null;
    if (!requester || !workspaceMemberUsable(workspaceMember(db, current.workspace.id, requester)))
      throw new Error("Runner requester is not an active workspace member");
    return {
      workspaceId: current.workspace.id,
      teamId,
      ownerUserId: current.placement?.ownerUserId ?? requester,
      leadUserIds: current.placement?.leadUserIds ?? [],
    };
  }
  function observeAccount(
    commandId: string,
    input: {
      classified: ReturnType<typeof classifyAgentFailure>;
      model: string | null;
      observedAt: number;
      startedAt: number;
      prepare: boolean;
    },
  ): number | null {
    const owner = commandAccount(db, commandId);
    if (!owner) return null;
    const base = {
      bindingId: owner.bindingId,
      source: "result" as const,
      sourceId: commandId,
      observedAt: input.observedAt,
      now: now(),
    };
    const { kind, quota } = input.classified;
    const observations: AccountObservation[] = [];
    if (kind === "auth") observations.push({ ...base, state: "auth_required" });
    else if (kind === "quota")
      observations.push({ ...base, state: "exhausted", resetsAt: quota!.resetsAt });
    else if (kind === "provider") observations.push({ ...base, state: "restricted" });
    else if (kind === "model" && input.model)
      observations.push({ ...base, state: "unsupported_model", model: input.model });
    else if (kind === "ok")
      observations.push({
        ...base,
        observedAt: input.startedAt,
        model: input.model,
        state: "ok",
        clears:
          input.prepare || quota?.state === "low"
            ? ["auth", "provider", "model"]
            : ["auth", "provider", "model", "quota"],
      });
    if (quota?.state === "low" && kind !== "quota") observations.push({ ...base, state: "low" });
    for (const observation of observations) recordAccountObservation(db, observation);
    if (kind !== "quota") return null;
    return quotaRecheckAt(db, commandId, owner.workspaceId);
  }
  function admit(
    input: Parameters<RunnerPlacement["started"]>[0],
    account: PlacementAccount,
    workspaceId: string,
  ) {
    const agent = input.profile!.agent as RunnerCodingAgent;
    const recorded = commandAccount(db, input.commandId);
    if (
      recorded &&
      (recorded.bindingId !== account.bindingId || recorded.accountId !== account.accountId)
    )
      throw new PlacementRaceError("The command does not carry the sign-in placement chose");
    const runner = runnerAgentQuota(db, input.runnerId, agent);
    const fit = signInFit(
      db,
      {
        id: input.runnerId,
        cooldownUntil: runner?.cooldownUntil ?? 0,
        quotaState: runner?.quotaState ?? "ok",
        signedIn: true,
      },
      workspaceId,
      { agent, model: input.profile?.model, purpose: input.purpose, at: now() },
    );
    if ("reason" in fit)
      throw new PlacementRaceError(`default sign-in: ${fit.reason} before assignment`);
    if (fit.account.bindingId !== account.bindingId)
      throw new PlacementRaceError("The agent sign-in changed before assignment");
  }
  return {
    async candidates(input) {
      input.signal?.throwIfAborted();
      if (!input.profile) throw new Error("Runner agent profile is required");
      const current = scope(input);
      const binding = authority(current);
      const at = now();
      // A task runs on the runners of the person who delegated it, then on the shared runners
      // of its Linear project leads.
      // Preparation probes identities without moving a checkout or resuming an agent session.
      const pinnedRunnerId = input.purpose === "prepare" ? undefined : input.pinnedRunnerId;
      const pinned =
        pinnedRunnerId && pinnedRunnerId !== input.handedOverFrom
          ? runnerIdentity(db, pinnedRunnerId)
          : null;
      const pinnedOnline =
        pinned !== null &&
        pinned.status === "active" &&
        pinned.revokedAt === null &&
        pinned.lastSeenAt !== null &&
        pinned.lastSeenAt > at - RUNNER_ONLINE_MS;
      const groupingSession =
        input.findingGroups && input.purpose === "helper"
          ? linearSessionInstallation(db, current.session.sessionId)
          : null;
      if (input.findingGroups && !groupingSession?.teamId)
        throw new Error("Runner issue team is unavailable");
      const scopes =
        input.findingGroups && input.purpose === "helper"
          ? findingGroupingAdmins(db, current.workspace.id).flatMap((admin) =>
              groupingSession?.clientId &&
              workspaceSessionIds(
                db,
                current.workspace.id,
                admin.userId,
                groupingSession.clientId,
              ).includes(current.session.sessionId)
                ? [
                    {
                      workspaceId: current.workspace.id,
                      teamId: groupingSession.teamId!,
                      ownerUserId: admin.userId,
                      leadUserIds: [] as string[],
                    },
                  ]
                : [],
            )
          : [eligibility(current)];
      const agent = input.profile.agent as RunnerCodingAgent;
      const rows = scopes
        .flatMap((owner) =>
          eligibleRunners(db, {
            ...owner,
            agent,
            purpose: input.findingGroups ? "work" : input.purpose,
            now: at,
            includeRevoked: true,
          }).map((runner) => ({
            ...runner,
            own: runner.eligible ? runner.reason === "own" : runner.ownerId === owner.ownerUserId,
            signedIn: runner.eligible,
          })),
        )
        .filter((runner) => {
          const reason = !runner.eligible
            ? runner.reason
            : pinnedOnline && runner.id !== pinnedRunnerId
              ? "run pinned to another online runner"
              : null;
          if (reason) input.onRejected?.(runner.id, reason);
          return reason === null;
        });
      const lastImplementation = input.itemId
        ? lastSuccessfulImplementation(db, input.itemId)
        : null;
      const ranked = rows.flatMap((runner) => {
        const reject = (reason: string) => {
          input.onRejected?.(runner.id, reason);
          return [];
        };
        const helper =
          input.purpose === "helper"
            ? runnerHelperAvailability(db, runner.id, at, !input.findingGroups)
            : null;
        if (helper && !helper.available)
          return reject("helper already running or no free capacity");
        if (runner.id === input.handedOverFrom) return reject("handed the session over");
        const repositoryRefusal =
          current.repository &&
          repositoryRejection(
            db,
            runner.id,
            `${current.repository.owner}/${current.repository.repo}`,
          );
        if (repositoryRefusal) return reject(repositoryRefusal);
        // Retry exclusions avoid failed hosts for unpinned work. A live run retries a fresh
        // session on its pinned host instead of moving its checkout and held slot.
        if (input.excludeRunnerIds?.includes(runner.id) && !pinnedOnline)
          return reject("excluded after failed attempt");
        const fit = signInFit(db, runner, current.workspace.id, {
          agent,
          model: input.profile?.model,
          purpose: input.purpose,
          at,
        });
        if ("reason" in fit) {
          input.onRejected?.(
            runner.id,
            fit.reason,
            ...(fit.until !== undefined ? [fit.until] : []),
          );
          return [];
        }
        // Preparation must probe fresh identities; preflight compares them against each other.
        // A fresh session may correct a reported model mismatch. The work receipt still rejects
        // actual implementer-model reuse, and failover bounds the number of attempts.
        if (
          !(pinnedOnline && input.excludeRunnerIds?.includes(runner.id)) &&
          input.purpose !== "prepare" &&
          input.role === "reviewer" &&
          lastImplementation?.model &&
          (input.profile?.model ?? runner.resolvedModel) === lastImplementation.model
        )
          return reject("reviewer model matches implementation model");
        const reviewRank =
          input.role === "reviewer" && lastImplementation?.runnerId === runner.id ? 1 : 0;
        const rank = (helper?.preempts ? 1000 : 0) + reviewRank * 10 + (runner.own ? 0 : 1);
        return [{ runner, ...fit, rank, extra: runner.quotaState === "spent_extra" }];
      });
      // A run leaving its pinned runner goes first to a free runner that can restore its saved
      // agent session, the agent version that wrote it ahead of other versions. It never waits
      // for a busy one: the others follow, and the restore falls back there with its reason.
      const restore =
        pinnedRunnerId && !pinnedOnline && input.role === "implementer" && input.purpose === "work"
          ? input.restore
          : undefined;
      const restorers = new Set<string>();
      if (restore) {
        const runId = current.item?.currentRunId ?? "";
        for (const entry of ranked) {
          const id = entry.runner.id;
          const target = restore(id, entry.account);
          const free =
            target &&
            runnerHasCapacity(
              db,
              id,
              at,
              runId,
              (input.reserved?.get(id) ?? 0) + runnerSlotsHeldBetweenCommands(db, id, at, runId),
            );
          entry.rank += !free ? 200 : target.sameVersion ? 0 : 100;
          if (free) restorers.add(`${id}:${entry.account.bindingId}`);
        }
      }
      const session =
        !pinnedRunnerId &&
        input.role === "implementer" &&
        input.purpose === "work" &&
        input.session;
      const holder = session
        ? ranked.find(
            ({ runner, account }) =>
              runner.id === session.runnerId &&
              (session.bindingId === undefined || account.bindingId === session.bindingId),
          )
        : undefined;
      let heldForSession = false;
      if (holder && input.itemId) {
        const runId = current.item?.currentRunId ?? "";
        const held =
          runnerSlotsHeldBetweenCommands(db, holder.runner.id, at, runId) +
          (input.reserved?.get(holder.runner.id) ?? 0) +
          pinnedSlotsReserved(db, holder.runner.id, input.itemId, at);
        if (runnerHasCapacity(db, holder.runner.id, at, runId, held)) {
          holder.rank = -1;
          sessionWaits.delete(input.itemId);
        } else {
          const waiting = sessionWaits.get(input.itemId);
          const since =
            waiting?.runnerId === holder.runner.id && at - waiting.seen < 2 * SESSION_GRACE_MS
              ? waiting.since
              : at;
          sessionWaits.set(input.itemId, { runnerId: holder.runner.id, since, seen: at });
          heldForSession = at - since < SESSION_GRACE_MS;
        }
      } else if (session && input.itemId) sessionWaits.delete(input.itemId);
      if (heldForSession) ranked.splice(0, ranked.length, holder!);
      const load = runnerLoad(
        ranked.map(({ runner }) => runner.id),
        at,
        input.reserved,
      );
      ranked.sort(
        (a, b) =>
          Number(a.extra) - Number(b.extra) ||
          a.rank - b.rank ||
          load.get(a.runner.id)!.current - load.get(b.runner.id)!.current ||
          Number(a.low) - Number(b.low) ||
          load.get(a.runner.id)!.recent - load.get(b.runner.id)!.recent ||
          a.runner.virtualFinish - b.runner.virtualFinish ||
          a.runner.lastUsedAt - b.runner.lastUsedAt ||
          a.runner.id.localeCompare(b.runner.id),
      );
      for (const [key, admission] of admissions)
        if (admission.expiresAt <= at) admissions.delete(key);
      for (const { runner, account, extra } of ranked)
        admissions.set(admissionKey(runner.id, input, account.bindingId), {
          request: input,
          account,
          scope: binding,
          policy: policy(runner.id, input.profile?.agent),
          reason: restorers.has(`${runner.id}:${account.bindingId}`)
            ? "session_restore"
            : extra
              ? "extra_usage"
              : null,
          expiresAt: at + 15_000,
        });
      return ranked.map(({ runner, account }) => ({
        id: runner.id,
        workspaceId: runner.workspaceId,
        account,
      }));
    },
    setupNeed(input) {
      if (!input.profile) return null;
      const current = scope(input);
      const owner = eligibility(current);
      const runners = eligibleRunners(db, {
        ...owner,
        agent: input.profile.agent,
        purpose: "work",
        now: now(),
      });
      return runnerSetupNeed(db, runners, owner, input.profile.agent);
    },
    repositoryRefusals(input) {
      return input.itemId ? itemRepositoryRefusals(db, { itemId: input.itemId, now: now() }) : null;
    },
    started(input) {
      immediate(db, () => {
        const key = admissionKey(
          input.runnerId,
          input,
          input.account?.bindingId ??
            (input.profile
              ? legacyAgentBindingId(input.runnerId, input.profile.agent as RunnerCodingAgent)
              : null),
        );
        const admission = admissions.get(key);
        if (
          !admission ||
          (input.account && input.account.accountId !== admission.account.accountId) ||
          admission.expiresAt <= now() ||
          admission.request.itemId !== input.itemId ||
          admission.request.role !== input.role ||
          JSON.stringify(admission.request.profile) !== JSON.stringify(input.profile) ||
          admission.scope !== authority(scope(admission.request)) ||
          admission.policy !== policy(input.runnerId, input.profile?.agent)
        )
          throw new PlacementRaceError("Runner selection authority changed before assignment");
        const runner = runnerIdentity(db, input.runnerId);
        if (!runner || runner.status !== "active" || runner.revokedAt !== null)
          throw new PlacementRaceError("Runner identity changed before assignment");
        if (input.profile) admit(input, admission.account, runner.workspaceId);
        if (input.profile)
          chargeRunnerAgent(db, {
            runnerId: input.runnerId,
            agent: input.profile.agent,
            at: input.startedAt,
          });
        insertRunnerExecutionUsage(db, {
          commandId: input.commandId,
          runnerId: input.runnerId,
          ownerUserId: runner.ownerId,
          itemId: input.itemId ?? null,
          runId: input.runId ?? null,
          agent: input.profile?.agent ?? null,
          model: input.profile?.model ?? null,
          role: input.role,
          purpose: input.purpose,
          startedAt: input.startedAt,
          placementReason: admission.reason,
        });
        admissions.delete(key);
      });
      if (input.itemId && input.role === "implementer" && input.purpose === "work")
        sessionWaits.delete(input.itemId);
    },
    finished(input) {
      return immediate(db, () => {
        const usage = runnerExecutionReceipt(db, input.commandId, input.runnerId);
        if (!usage) throw new Error("Runner usage receipt is not bound to an assignment");
        const result = input.result;
        if ((!result && !input.failure) || (result && result.commandId !== input.commandId))
          throw new Error("Runner result is not bound to its command");
        // A replay after a restart repeats the recorded decision without counting usage again.
        if (usage.endedAt !== null)
          return {
            retryable: RETRYABLE_OUTCOMES.has(usage.outcome ?? ""),
            ...(usage.outcome === "quota_exhausted"
              ? { usageLimit: { resetsAt: usage.resetsAt } }
              : {}),
          };
        const classified = classifyAgentFailure({
          ...(result ? { result } : {}),
          ...(input.failure ? { failure: input.failure } : {}),
          now: input.finishedAt,
        });
        const quota = classified.quota;
        const retryable =
          input.failure === "heartbeat_lost" ||
          result?.authRequired === true ||
          quota?.state === "exhausted";
        const success =
          !input.failure &&
          !retryable &&
          (!result ||
            (result.stopReason === "end_turn" &&
              !result.cancelled &&
              !result.timedOut &&
              !result.errorMessage));
        const model = result?.identity?.model ?? null;
        const latestImplementation = usage.itemId
          ? lastSuccessfulImplementation(db, usage.itemId)
          : null;
        const modelConflict =
          success &&
          usage.purpose === "work" &&
          usage.role === "reviewer" &&
          model !== null &&
          model === latestImplementation?.model;
        finishRunnerExecutionUsage(db, {
          commandId: input.commandId,
          endedAt: input.finishedAt,
          outcome: modelConflict
            ? "model_conflict"
            : success
              ? "success"
              : result?.authRequired
                ? "auth_required"
                : quota?.state === "exhausted"
                  ? "quota_exhausted"
                  : (input.failure ?? "error"),
          resolvedModel: model,
          outputBytes:
            result && "text" in result
              ? Buffer.byteLength(result.text)
              : result?.reviewText
                ? Buffer.byteLength(result.reviewText)
                : 0,
          resetsAt: quota?.state === "exhausted" ? quota.resetsAt : null,
        });
        const runsAsDefault = commandAccount(db, input.commandId)?.named !== true;
        if (usage.agent && runsAsDefault)
          settleRunnerAgent(db, {
            runnerId: input.runnerId,
            agent: usage.agent,
            authRequired: result?.authRequired === true,
            success,
            quota,
            clearQuota: success && usage.purpose !== "prepare",
            model,
          });
        const recheckAt = observeAccount(input.commandId, {
          classified,
          model: input.profile?.model ?? model,
          observedAt: input.finishedAt,
          startedAt: usage.startedAt,
          prepare: usage.purpose === "prepare",
        });
        if (
          usage.agent &&
          runsAsDefault &&
          quota?.state === "exhausted" &&
          quota.resetsAt === null &&
          recheckAt
        )
          setRunnerAgentCooldown(db, input.runnerId, usage.agent, recheckAt);
        return {
          retryable: retryable || modelConflict,
          ...(quota?.state === "exhausted"
            ? {
                usageLimit: {
                  resetsAt: quota.resetsAt,
                  ...(quota.resetsAt === null && recheckAt ? { recheckAt } : {}),
                },
              }
            : {}),
        };
      });
    },
  };
}
