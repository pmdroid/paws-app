import { runnerAllowsRepository, teamRepositoryAllowedSql } from "../db";
import type { Database } from "bun:sqlite";
import {
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
  legacyAgentAccountId,
  legacyAgentBindingId,
  legacyBindingAccountHealth,
  recordAccountObservation,
  admitAgentAccounts,
  accountSlotsInUse,
  agentAccountConcurrency,
  bindingAccountHealth,
  liveAccountBinding,
  runnerAccountUnsupported,
  type AccountObservation,
} from "../db";
import type { RunnerCodingAgent } from "../runner-protocol";
import type {
  EligibleRunner,
  PlacementAccount,
  PlacementAccounts,
  PlacementPurpose,
  PlacementReason,
  PlacementRequest,
  RunnerPlacement,
} from "./index";
import { eligibleRunners, runnerSetupNeed, RUNNER_ONLINE_MS } from "./eligible";
import { accountHealthBlock, BINDING_REASON_TEXT, classifyAgentFailure } from "./account-health";

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

const SIGN_IN_REASONS = new Set(["auth-expired", "agent-not-signed-in"]);

type AccountOption = { id: string; legacy: boolean; label: string; index: number };
type AccountRefusal = { reason: string; until?: number };
type AccountFit = { account: PlacementAccount; low: boolean };

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
      fallback: string | null;
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
    return JSON.stringify({
      runner: db
        .query(
          "SELECT id,workspace_id,owner_user_id,status,fence,revoked_at FROM runner WHERE id=?",
        )
        .get(id),
      host: db.query("SELECT runner_id,sharing FROM runner_policy WHERE runner_id=?").get(id),
      capacity: db
        .query("SELECT capacity,ceiling,desired FROM runner_capacity WHERE runner_id=?")
        .get(id),
      agent: agent
        ? db.query("SELECT * FROM runner_agent_policy WHERE runner_id=? AND agent=?").get(id, agent)
        : null,
      membership: db
        .query(
          "SELECT m.* FROM workspace_member m JOIN runner r ON r.workspace_id=m.workspace_id AND r.owner_user_id=m.user_id WHERE r.id=?",
        )
        .get(id),
      teams: db
        .query(
          "SELECT t.* FROM workspace_user_team t JOIN runner r ON r.workspace_id=t.workspace_id AND r.owner_user_id=t.user_id WHERE r.id=? ORDER BY team_id",
        )
        .all(id),
    });
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
    const workspace = db
      .query<{ id: string }, [string]>("SELECT id FROM workspace WHERE linear_organization_id=?")
      .get(session.organizationId);
    if (!workspace) throw new Error("Runner workspace is unavailable");
    const repository = item ? getWorkItemRepository(db, item.id) : null;
    const issueId =
      item?.linearIssueId ?? session.issueId ?? (input.findingGroups ? session.sessionId : null);
    if (!issueId) throw new Error("Runner issue authority is unavailable");
    const placement = item
      ? {
          ownerUserId:
            db
              .query<{ ownerUserId: string | null }, [string]>(
                "SELECT owner_user_id AS ownerUserId FROM work_item WHERE id=?",
              )
              .get(item.id)?.ownerUserId ?? null,
          // The leads of the Linear projects across the item's delegation lend their shared runners.
          leadUserIds: db
            .query<{ id: string }, [string]>(
              `SELECT DISTINCT u.id FROM work_item i
               JOIN work_item_scheduling c ON c.item_id=i.id
               JOIN workspace_user u ON u.linear_user_id=c.project_lead_id
               WHERE i.delegation_id=? ORDER BY u.id`,
            )
            .all(item.delegationId)
            .map((row) => row.id),
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
      installation: db
        .query("SELECT oauth_client_id,team_id FROM linear_session WHERE session_id=?")
        .get(current.session.sessionId),
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
    const history = db.query<{ startedAt: number; endedAt: number }, [string, number, number]>(
      `SELECT started_at AS startedAt,ended_at AS endedAt FROM runner_execution_usage
       WHERE runner_id=? AND ended_at>? AND ended_at<=?`,
    );
    return new Map(
      runnerIds.map((id) => {
        const { capacity, occupied } = runnerOccupancy(db, id, at);
        const slots = Math.max(capacity, 1);
        const held = runnerSlotsHeldBetweenCommands(db, id, at);
        let busy = 0;
        for (const row of history.all(id, from, at))
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
    const teamId = db
      .query<{ teamId: string | null }, [string]>(
        "SELECT team_id AS teamId FROM linear_session WHERE session_id=?",
      )
      .get(current.session.sessionId)?.teamId;
    if (!teamId) throw new Error("Runner issue team is unavailable");
    if (
      current.repository &&
      !db
        .query(`SELECT 1 WHERE ${teamRepositoryAllowedSql("?1", "?2", "lower(?3)")}`)
        .get(
          current.workspace.id,
          teamId,
          `${current.repository.owner}/${current.repository.repo}`.toLowerCase(),
        )
    )
      throw new Error("Runner repository is outside workspace access");
    const requester = current.ownership
      ? db
          .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id=?")
          .get(current.ownership)?.id
      : undefined;
    if (!requester || !workspaceMember(db, current.workspace.id, requester)?.active)
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
    return (
      db
        .query<{ at: number | null }, [string, string]>(
          "SELECT next_check_at AS at FROM agent_account_health WHERE kind='quota' AND source_id=? AND workspace_id=?",
        )
        .get(commandId, owner.workspaceId)?.at ?? null
    );
  }
  function accountOrder(
    workspaceId: string,
    agent: RunnerCodingAgent,
    accounts: PlacementAccounts | undefined,
  ): AccountOption[] {
    const legacy = legacyAgentAccountId(workspaceId, agent);
    const ids = accounts ? [...new Set(accounts.accountIds)] : [legacy];
    return admitAgentAccounts(db, workspaceId, agent, { agent, accounts: ids }).eligible.map(
      (id, index) => ({
        id,
        index,
        legacy: id === legacy,
        label:
          id === legacy
            ? "default sign-in"
            : (db
                .query<{ label: string }, [string]>("SELECT label FROM agent_account WHERE id=?")
                .get(id)?.label ?? id),
      }),
    );
  }
  function accountFit(
    runner: Pick<EligibleRunner, "id" | "cooldownUntil" | "quotaState"> & { signedIn: boolean },
    option: AccountOption,
    input: {
      agent: RunnerCodingAgent;
      model: string | null | undefined;
      purpose: PlacementPurpose;
      at: number;
      exceptCommandId?: string;
    },
  ): AccountFit | AccountRefusal {
    const { agent, at, purpose } = input;
    const block = (health: ReturnType<typeof accountHealthBlock>): AccountRefusal | null =>
      health
        ? {
            reason: BINDING_REASON_TEXT[health.reason],
            ...(health.until !== null ? { until: health.until } : {}),
          }
        : null;
    let fit: AccountFit;
    if (option.legacy) {
      if (!runner.signedIn) return { reason: "agent not signed in" };
      if (runner.cooldownUntil > at)
        return { reason: "agent quota cooldown", until: runner.cooldownUntil };
      const bindingId = legacyAgentBindingId(runner.id, agent);
      const refused = block(
        accountHealthBlock(
          db,
          bindingId,
          legacyBindingAccountHealth(db, runner.id, agent, input.model).filter(
            (row) => row.kind !== "quota" && row.kind !== "auth",
          ),
          at,
          purpose,
        ),
      );
      if (refused) return refused;
      fit = {
        account: { accountId: option.id, bindingId, named: false },
        low: runner.quotaState === "low",
      };
    } else {
      const binding = liveAccountBinding(db, runner.id, option.id);
      if (!binding || binding.agent !== agent)
        return { reason: "account has no binding on this runner" };
      const unsupported = runnerAccountUnsupported(db, runner.id, binding.id, agent);
      if (unsupported) return { reason: unsupported };
      const rows = bindingAccountHealth(db, binding.id, input.model);
      const refused = block(accountHealthBlock(db, binding.id, rows, at, purpose));
      if (refused) return refused;
      fit = {
        account: { accountId: option.id, bindingId: binding.id, named: true },
        low: rows.some((row) => row.state === "low"),
      };
    }
    const limit = agentAccountConcurrency(db, option.id);
    if (limit !== null && accountSlotsInUse(db, option.id, at, input.exceptCommandId) >= limit)
      return { reason: "account at its concurrency limit" };
    return fit;
  }
  function admit(
    input: Parameters<RunnerPlacement["started"]>[0],
    account: PlacementAccount,
    workspaceId: string,
  ) {
    const agent = input.profile!.agent as RunnerCodingAgent;
    const recorded = commandAccount(db, input.commandId);
    if (
      (recorded || account.named) &&
      (recorded?.bindingId !== account.bindingId || recorded.accountId !== account.accountId)
    )
      throw new PlacementRaceError("The command does not carry the account placement chose");
    if (input.accounts && !input.accounts.accountIds.includes(account.accountId))
      throw new PlacementRaceError("The agent account left the account order before assignment");
    const option = accountOrder(workspaceId, agent, {
      revision: input.accounts?.revision ?? "",
      accountIds: [account.accountId],
    })[0];
    if (!option) throw new PlacementRaceError("The agent account was disabled or removed");
    const runner = db
      .query<{ cooldownUntil: number; quotaState: string }, [string, string]>(
        "SELECT cooldown_until AS cooldownUntil,quota_state AS quotaState FROM runner_agent_policy WHERE runner_id=? AND agent=?",
      )
      .get(input.runnerId, agent);
    const fit = accountFit(
      {
        id: input.runnerId,
        cooldownUntil: runner?.cooldownUntil ?? 0,
        quotaState: runner?.quotaState ?? "ok",
        signedIn: true,
      },
      option,
      {
        agent,
        model: input.profile?.model,
        purpose: input.purpose,
        at: now(),
        exceptCommandId: input.commandId,
      },
    );
    if ("reason" in fit)
      throw new PlacementRaceError(`${option.label}: ${fit.reason} before assignment`);
    if (fit.account.bindingId !== account.bindingId)
      throw new PlacementRaceError("The agent account binding changed before assignment");
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
      const pinnedOnline =
        pinnedRunnerId && pinnedRunnerId !== input.handedOverFrom
          ? db
              .query(
                "SELECT 1 FROM runner WHERE id=? AND status='active' AND revoked_at IS NULL AND last_seen_at>?",
              )
              .get(pinnedRunnerId, at - RUNNER_ONLINE_MS) !== null
          : false;
      const groupingSession =
        input.findingGroups && input.purpose === "helper"
          ? db
              .query<{ teamId: string | null; clientId: string | null }, [string]>(
                "SELECT team_id AS teamId, oauth_client_id AS clientId FROM linear_session WHERE session_id=?",
              )
              .get(current.session.sessionId)
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
      const order = accountOrder(current.workspace.id, agent, input.accounts);
      const named = order.some((option) => !option.legacy);
      const refusals = new Map<number, Set<string>>();
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
          const reason =
            !runner.eligible && !(named && SIGN_IN_REASONS.has(runner.reason))
              ? runner.reason
              : pinnedOnline && runner.id !== pinnedRunnerId
                ? "run pinned to another online runner"
                : null;
          if (reason) input.onRejected?.(runner.id, reason);
          return reason === null;
        });
      const lastImplementation = input.itemId
        ? db
            .query<{ runnerId: string; model: string | null }, [string]>(
              `SELECT runner_id AS runnerId,resolved_model AS model FROM runner_execution_usage
         WHERE item_id=? AND role='implementer' AND purpose='work' AND outcome='success'
         ORDER BY ended_at DESC,rowid DESC LIMIT 1`,
            )
            .get(input.itemId)
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
        if (
          current.repository &&
          !runnerAllowsRepository(
            db,
            runner.id,
            `${current.repository.owner}/${current.repository.repo}`,
          )
        )
          return reject("repository not allowed on this runner");
        // Retry exclusions avoid failed hosts for unpinned work. A live run retries a fresh
        // session on its pinned host instead of moving its checkout and held slot.
        if (input.excludeRunnerIds?.includes(runner.id) && !pinnedOnline)
          return reject("excluded after failed attempt");
        const fits = order.flatMap((option) => {
          const refuse = (refusal: AccountRefusal) => {
            const seen = refusals.get(option.index) ?? new Set<string>();
            seen.add(refusal.reason);
            refusals.set(option.index, seen);
            input.onRejected?.(
              runner.id,
              input.accounts ? `${option.label}: ${refusal.reason}` : refusal.reason,
              ...(refusal.until !== undefined ? [refusal.until] : []),
            );
            return [];
          };
          const fit = accountFit(runner, option, {
            agent,
            model: input.profile?.model,
            purpose: input.purpose,
            at,
          });
          if ("reason" in fit) return refuse(fit);
          if (input.excludeRunnerIds?.includes(fit.account.bindingId))
            return refuse({ reason: "excluded after failed attempt" });
          return [{ ...fit, index: option.index }];
        });
        if (fits.length === 0) return [];
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
        return fits.map((fit) => ({ runner, ...fit, rank }));
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
          a.index - b.index ||
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
      const fallback = (index: number) =>
        input.accounts && index > 0
          ? order
              .filter((option) => option.index < index)
              .map(
                (option) =>
                  `${option.label}: ${[...(refusals.get(option.index) ?? ["not placed on a free runner"])].join(", ")}`,
              )
              .join("; ")
              .slice(0, 500)
          : null;
      for (const { runner, account, index } of ranked)
        admissions.set(admissionKey(runner.id, input, account.bindingId), {
          request: input,
          account,
          scope: binding,
          policy: policy(runner.id, input.profile?.agent),
          reason: restorers.has(`${runner.id}:${account.bindingId}`) ? "session_restore" : null,
          fallback: fallback(index),
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
          admission.policy !== policy(input.runnerId, input.profile?.agent) ||
          admission.request.accounts?.revision !== input.accounts?.revision
        )
          throw new PlacementRaceError("Runner selection authority changed before assignment");
        const runner = db
          .query<{ ownerId: string; workspaceId: string }, [string]>(
            "SELECT owner_user_id AS ownerId,workspace_id AS workspaceId FROM runner WHERE id=? AND status='active' AND revoked_at IS NULL",
          )
          .get(input.runnerId);
        if (!runner) throw new PlacementRaceError("Runner identity changed before assignment");
        if (input.profile) admit(input, admission.account, runner.workspaceId);
        if (input.profile) {
          db.run(
            "INSERT INTO runner_agent_policy(runner_id,agent) VALUES(?,?) ON CONFLICT DO NOTHING",
            [input.runnerId, input.profile.agent],
          );
          db.run(
            "UPDATE runner_agent_policy SET virtual_finish=virtual_finish+CASE WHEN quota_state='low' THEN 5 ELSE 1 END,last_used_at=? WHERE runner_id=? AND agent=?",
            [input.startedAt, input.runnerId, input.profile.agent],
          );
        }
        db.run(
          `INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,item_id,run_id,agent,model,role,purpose,started_at,placement_reason,account_policy_revision,account_fallback)
          VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            input.commandId,
            input.runnerId,
            runner.ownerId,
            input.itemId ?? null,
            input.runId ?? null,
            input.profile?.agent ?? null,
            input.profile?.model ?? null,
            input.role,
            input.purpose,
            input.startedAt,
            admission.reason,
            input.accounts?.revision ?? null,
            admission.fallback,
          ],
        );
        admissions.delete(key);
      });
      if (input.itemId && input.role === "implementer" && input.purpose === "work")
        sessionWaits.delete(input.itemId);
    },
    finished(input) {
      return immediate(db, () => {
        const usage = db
          .query<
            {
              ownerId: string;
              purpose: string;
              agent: string | null;
              itemId: string | null;
              role: string;
              startedAt: number;
              endedAt: number | null;
              outcome: string | null;
              resetsAt: number | null;
            },
            [string, string]
          >(
            "SELECT owner_user_id AS ownerId,purpose,agent,item_id AS itemId,role,started_at AS startedAt,ended_at AS endedAt,outcome,resets_at AS resetsAt FROM runner_execution_usage WHERE command_id=? AND runner_id=?",
          )
          .get(input.commandId, input.runnerId);
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
          ? db
              .query<{ model: string | null }, [string]>(
                "SELECT resolved_model AS model FROM runner_execution_usage WHERE item_id=? AND role='implementer' AND purpose='work' AND outcome='success' ORDER BY ended_at DESC,rowid DESC LIMIT 1",
              )
              .get(usage.itemId)
          : null;
        const modelConflict =
          success &&
          usage.purpose === "work" &&
          usage.role === "reviewer" &&
          model !== null &&
          model === latestImplementation?.model;
        db.run(
          "UPDATE runner_execution_usage SET ended_at=?,outcome=?,resolved_model=?,output_bytes=?,resets_at=? WHERE command_id=?",
          [
            input.finishedAt,
            modelConflict
              ? "model_conflict"
              : success
                ? "success"
                : result?.authRequired
                  ? "auth_required"
                  : quota?.state === "exhausted"
                    ? "quota_exhausted"
                    : (input.failure ?? "error"),
            model,
            result && "text" in result
              ? Buffer.byteLength(result.text)
              : result?.reviewText
                ? Buffer.byteLength(result.reviewText)
                : 0,
            quota?.state === "exhausted" ? quota.resetsAt : null,
            input.commandId,
          ],
        );
        const runsAsDefault = commandAccount(db, input.commandId)?.named !== true;
        if (usage.agent && runsAsDefault) {
          db.run(
            `UPDATE runner_agent_policy SET
            ready=CASE WHEN ? THEN 0 WHEN ? THEN 1 ELSE ready END,
            auth_expired=CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE auth_expired END,
            quota_state=CASE WHEN ? IS NOT NULL THEN ? WHEN ? THEN 'ok' ELSE quota_state END,
            resets_at=CASE WHEN ? IS NOT NULL THEN ? WHEN ? THEN NULL ELSE resets_at END,
            cooldown_until=CASE WHEN ? IS NOT NULL THEN ? WHEN ? THEN 0 ELSE cooldown_until END,
            resolved_model=COALESCE(?,resolved_model) WHERE runner_id=? AND agent=?`,
            [
              result?.authRequired ? 1 : 0,
              success ? 1 : 0,
              result?.authRequired ? 1 : 0,
              success ? 1 : 0,
              quota?.state ?? null,
              quota?.state ?? null,
              success && usage.purpose !== "prepare" ? 1 : 0,
              quota?.state ?? null,
              quota?.resetsAt ?? null,
              success && usage.purpose !== "prepare" ? 1 : 0,
              quota?.state ?? null,
              quota?.cooldownUntil ?? 0,
              success && usage.purpose !== "prepare" ? 1 : 0,
              model,
              input.runnerId,
              usage.agent,
            ],
          );
        }
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
          db.run("UPDATE runner_agent_policy SET cooldown_until=? WHERE runner_id=? AND agent=?", [
            recheckAt,
            input.runnerId,
            usage.agent,
          ]);
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
