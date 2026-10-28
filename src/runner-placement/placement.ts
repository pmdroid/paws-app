import { teamRepositoryAllowedSql } from "../db";
import type { Database } from "bun:sqlite";
import {
  getLinearSession,
  getLinearSessionAccess,
  getWorkItem,
  getWorkItemRepository,
  immediate,
  runnerHasCapacity,
  runnerOccupancy,
  runnerSlotsHeldBetweenCommands,
  delegatedLinearUserId,
  workspaceMember,
  findingGroupingAdmins,
} from "../db";
import type { PlacementReason, PlacementRequest, RunnerPlacement } from "./index";
import { eligibleRunners, runnerSetupNeed, RUNNER_ONLINE_MS } from "./eligible";
import { quotaSignal } from "./quota";

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
  ) {
    return JSON.stringify([
      runnerId,
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
      const groupingTeam =
        input.findingGroups && input.purpose === "helper"
          ? db
              .query<{ teamId: string | null }, [string]>(
                "SELECT team_id AS teamId FROM linear_session WHERE session_id=?",
              )
              .get(current.session.sessionId)?.teamId
          : null;
      if (input.findingGroups && !groupingTeam) throw new Error("Runner issue team is unavailable");
      const scopes =
        input.findingGroups && input.purpose === "helper"
          ? findingGroupingAdmins(db, current.workspace.id).map((admin) => ({
              workspaceId: current.workspace.id,
              teamId: groupingTeam!,
              ownerUserId: admin.userId,
              leadUserIds: [],
            }))
          : [eligibility(current)];
      const rows = scopes
        .flatMap((owner) =>
          eligibleRunners(db, {
            ...owner,
            agent: input.profile!.agent,
            purpose: input.findingGroups ? "work" : input.purpose,
            now: at,
            includeRevoked: true,
          }),
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
        if (input.purpose === "helper" && !runnerHasCapacity(db, runner.id, at))
          return reject("no free capacity");
        if (
          input.purpose === "helper" &&
          db
            .query(
              "SELECT 1 FROM runner_helper WHERE runner_id=? AND ended_at IS NULL AND expires_at>?",
            )
            .get(runner.id, at)
        )
          return reject("helper already running");
        if (runner.id === input.handedOverFrom) return reject("handed the session over");
        // Retry exclusions avoid failed hosts for unpinned work. A live run retries a fresh
        // session on its pinned host instead of moving its checkout and held slot.
        if (input.excludeRunnerIds?.includes(runner.id) && !pinnedOnline)
          return reject("excluded after failed attempt");
        const own = runner.reason === "own";
        if (runner.cooldownUntil > at) return reject("agent quota cooldown");
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
        return [{ runner, rank: reviewRank * 10 + (own ? 0 : 1) }];
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
          const target = restore(id);
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
          if (free) restorers.add(id);
        }
      }
      const session =
        !pinnedRunnerId &&
        input.role === "implementer" &&
        input.purpose === "work" &&
        input.session;
      const holder = session
        ? ranked.find(({ runner }) => runner.id === session.runnerId)
        : undefined;
      let heldForSession = false;
      if (holder && input.itemId) {
        if (runnerHasCapacity(db, holder.runner.id, at)) {
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
          a.rank - b.rank ||
          load.get(a.runner.id)!.current - load.get(b.runner.id)!.current ||
          Number(a.runner.quotaState === "low") - Number(b.runner.quotaState === "low") ||
          load.get(a.runner.id)!.recent - load.get(b.runner.id)!.recent ||
          a.runner.virtualFinish - b.runner.virtualFinish ||
          a.runner.lastUsedAt - b.runner.lastUsedAt ||
          a.runner.id.localeCompare(b.runner.id),
      );
      for (const [key, admission] of admissions)
        if (admission.expiresAt <= at) admissions.delete(key);
      for (const { runner } of ranked)
        admissions.set(admissionKey(runner.id, input), {
          request: input,
          scope: binding,
          policy: policy(runner.id, input.profile?.agent),
          reason: restorers.has(runner.id) ? "session_restore" : null,
          expiresAt: at + 15_000,
        });
      return ranked.map(({ runner }) => ({ id: runner.id, workspaceId: runner.workspaceId }));
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
        const admission = admissions.get(admissionKey(input.runnerId, input));
        if (
          !admission ||
          admission.expiresAt <= now() ||
          admission.request.itemId !== input.itemId ||
          admission.request.role !== input.role ||
          JSON.stringify(admission.request.profile) !== JSON.stringify(input.profile) ||
          admission.scope !== authority(scope(admission.request)) ||
          admission.policy !== policy(input.runnerId, input.profile?.agent)
        )
          throw new PlacementRaceError("Runner selection authority changed before assignment");
        const runner = db
          .query<{ ownerId: string }, [string]>(
            "SELECT owner_user_id AS ownerId FROM runner WHERE id=? AND status='active' AND revoked_at IS NULL",
          )
          .get(input.runnerId);
        if (!runner) throw new PlacementRaceError("Runner identity changed before assignment");
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
          `INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,item_id,run_id,agent,model,role,purpose,started_at,placement_reason)
          VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
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
          ],
        );
        admissions.delete(admissionKey(input.runnerId, input));
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
              endedAt: number | null;
              outcome: string | null;
              resetsAt: number | null;
            },
            [string, string]
          >(
            "SELECT owner_user_id AS ownerId,purpose,agent,item_id AS itemId,role,ended_at AS endedAt,outcome,resets_at AS resetsAt FROM runner_execution_usage WHERE command_id=? AND runner_id=?",
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
        const quota = result?.errorMessage
          ? quotaSignal(result.errorMessage, input.finishedAt)
          : null;
        const retryable =
          input.failure === "heartbeat_lost" ||
          result?.authRequired === true ||
          quota?.state === "exhausted";
        const success =
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
        if (usage.agent) {
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
        return {
          retryable: retryable || modelConflict,
          ...(quota?.state === "exhausted" ? { usageLimit: { resetsAt: quota.resetsAt } } : {}),
        };
      });
    },
  };
}
