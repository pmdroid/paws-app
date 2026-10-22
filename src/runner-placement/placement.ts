import { teamRepositoryAllowedSql } from "../db";
import type { Database } from "bun:sqlite";
import {
  getLinearSession,
  getLinearSessionAccess,
  getWorkItem,
  getWorkItemRepository,
  immediate,
  runnerHasCapacity,
  delegatedLinearUserId,
  workspaceMember,
} from "../db";
import type { LinearIssueLifecycle, LinearIssueOwnership, TrackerAdapter } from "../linear";
import type { PlacementRequest, RunnerPlacement } from "./index";
import { quotaSignal } from "./quota";

type Candidate = {
  id: string;
  memberId?: string;
  workspaceId: string;
  ownerId: string;
  linearUserId: string;
  sharing: number;
  ready: number;
  authExpired: number;
  quotaState: string;
  cooldownUntil: number;
  /** The reported reset behind the cooldown; null when the cooldown is only the fallback. */
  resetsAt: number | null;
  virtualFinish: number;
  lastUsedAt: number;
  resolvedModel: string | null;
};

export function createRunnerPlacement(options: {
  db: Database;
  lifecycle: LinearIssueLifecycle;
  tracker: Pick<TrackerAdapter, "listProjectMembers">;
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
      expiresAt: number;
      memberId?: string;
    }
  >();
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
      accounts: db
        .query(
          "SELECT a.*,m.active,m.role,(SELECT json_group_array(team_id) FROM (SELECT team_id FROM workspace_user_team WHERE workspace_id=r.workspace_id AND user_id=a.user_id ORDER BY team_id)) AS teams FROM runner_member_account a JOIN runner r ON r.id=a.runner_id JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=a.user_id WHERE a.runner_id=? ORDER BY a.user_id,a.agent",
        )
        .all(id),
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
      session.stoppedAt !== null ||
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
    const issueId = item?.linearIssueId ?? session.issueId;
    if (!issueId) throw new Error("Runner issue authority is unavailable");
    const placement = item
      ? (db
          .query<{ ownerUserId: string | null; projectApprovalId: string | null }, [string]>(
            "SELECT owner_user_id AS ownerUserId,project_approval_id AS projectApprovalId FROM work_item WHERE id=?",
          )
          .get(item.id) ?? { ownerUserId: null, projectApprovalId: null })
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
            projectApprovalId: current.placement?.projectApprovalId ?? null,
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
   * Ranks the runners the request may use. `cooled` lists the ones that are eligible in every way
   * except an agent usage-limit cooldown, so a paused task knows when its own accounts reset.
   */
  async function evaluate(input: PlacementRequest) {
    input.signal?.throwIfAborted();
    if (!input.profile) throw new Error("Runner agent profile is required");
    const before = scope(input);
    const binding = authority(before);
    const issue = await options.lifecycle.inspect(before.issueId, { signal: input.signal });
    const projectMembers =
      issue.projectId && options.tracker.listProjectMembers
        ? await options.tracker
            .listProjectMembers(issue.projectId, { signal: input.signal })
            .catch(() => {
              input.signal?.throwIfAborted();
              return [];
            })
        : [];
    const verified = await options.lifecycle.inspect(before.issueId, { signal: input.signal });
    input.signal?.throwIfAborted();
    if (JSON.stringify(owners(verified)) !== JSON.stringify(owners(issue)))
      throw new Error("Runner issue ownership changed during selection");
    const current = scope(input);
    if (
      authority(current) !== binding ||
      issue.id !== current.issueId ||
      ["canceled", "completed"].includes(verified.stateType)
    )
      throw new Error("Runner issue authority changed");
    const sessionTeam = db
      .query<{ teamId: string | null }, [string]>(
        "SELECT team_id AS teamId FROM linear_session WHERE session_id=?",
      )
      .get(current.session.sessionId)?.teamId;
    if (sessionTeam !== issue.teamId) throw new Error("Runner issue team changed");
    if (
      current.repository &&
      !db
        .query(`SELECT 1 WHERE ${teamRepositoryAllowedSql("?1", "?2", "lower(?3)")}`)
        .get(
          current.workspace.id,
          issue.teamId,
          `${current.repository.owner}/${current.repository.repo}`.toLowerCase(),
        )
    )
      throw new Error("Runner repository is outside workspace access");
    const requester = current.ownership
      ? db
          .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id=?")
          .get(current.ownership)?.id
      : undefined;
    if (
      !requester ||
      !workspaceMember(db, current.workspace.id, requester)?.active ||
      workspaceMember(db, current.workspace.id, requester)?.role === "observer"
    )
      throw new Error("Runner requester is not an active workspace member");
    const at = now();
    const rows = db
      .query<Candidate, [string, string, number]>(
        `SELECT r.id,r.workspace_id AS workspaceId,r.owner_user_id AS ownerId,u.linear_user_id AS linearUserId,
         COALESCE(p.sharing,0) AS sharing,
         COALESCE(a.ready,0) AS ready,COALESCE(a.auth_expired,0) AS authExpired,
         COALESCE(a.quota_state,'ok') AS quotaState,COALESCE(a.cooldown_until,0) AS cooldownUntil,a.resets_at AS resetsAt,
         COALESCE(a.virtual_finish,0) AS virtualFinish,COALESCE(a.last_used_at,0) AS lastUsedAt,a.resolved_model AS resolvedModel
         FROM runner r JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id
         JOIN workspace_user u ON u.id=m.user_id LEFT JOIN runner_policy p ON p.runner_id=r.id
         LEFT JOIN runner_agent_policy a ON a.runner_id=r.id AND a.agent=?
         WHERE r.workspace_id=? AND r.status='active' AND r.revoked_at IS NULL AND m.active=1
         AND m.role<>'observer' AND r.last_seen_at>?
         AND NOT EXISTS(SELECT 1 FROM runner_command c WHERE c.runner_id=r.id AND c.kind='cancel' AND c.acknowledged_at IS NULL AND NOT EXISTS(SELECT 1 FROM runner_command a WHERE a.runner_id=c.runner_id AND a.run_id=c.run_id AND a.generation=c.generation AND a.kind='cancel' AND a.ordinal>c.ordinal AND a.acknowledged_at IS NOT NULL))`,
      )
      .all(input.profile?.agent ?? "", current.workspace.id, at - 60_000);
    const lastImplementation = input.itemId
      ? db
          .query<{ runnerId: string; model: string | null }, [string]>(
            `SELECT runner_id AS runnerId,resolved_model AS model FROM runner_execution_usage
         WHERE item_id=? AND role='implementer' AND purpose='work' AND outcome='success'
         ORDER BY ended_at DESC,rowid DESC LIMIT 1`,
          )
          .get(input.itemId)
      : null;
    const itemOwnerLinear = current.placement?.ownerUserId
      ? db
          .query<{ linearUserId: string }, [string]>(
            "SELECT linear_user_id AS linearUserId FROM workspace_user WHERE id=?",
          )
          .get(current.placement.ownerUserId)?.linearUserId
      : undefined;
    const accountActor =
      input.purpose === "helper"
        ? current.ownership
        : current.placement?.ownerUserId
          ? itemOwnerLinear
          : issue.assigneeId;
    const accountUser = accountActor
      ? db
          .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id=?")
          .get(accountActor)?.id
      : undefined;
    const cooled: { until: number; known: boolean }[] = [];
    const ranked = rows.flatMap((candidate) => {
      let runner = candidate;
      const hostOwnerId = runner.ownerId;
      if (input.purpose === "helper" && !runnerHasCapacity(db, runner.id, at)) return [];
      if (
        input.purpose === "helper" &&
        db
          .query(
            "SELECT 1 FROM runner_helper WHERE runner_id=? AND ended_at IS NULL AND expires_at>?",
          )
          .get(runner.id, at)
      )
        return [];
      if (
        input.profile &&
        db.query("SELECT 1 FROM runner_member_account WHERE runner_id=?").get(runner.id)
      ) {
        const account = accountUser
          ? db
              .query<
                {
                  connected: number;
                  cooldownUntil: number;
                  resetsAt: number | null;
                  resolvedModel: string | null;
                },
                [string, string, string]
              >(
                `SELECT a.connected,a.cooldown_until AS cooldownUntil,x.resets_at AS resetsAt,a.resolved_model AS resolvedModel
                   FROM runner_member_account a LEFT JOIN runner_member_account_reset x
                   ON x.runner_id=a.runner_id AND x.user_id=a.user_id AND x.agent=a.agent
                   WHERE a.runner_id=? AND a.user_id=? AND a.agent=?`,
              )
              .get(runner.id, accountUser, input.profile.agent)
          : null;
        if (
          !account?.connected ||
          !accountUser ||
          (runner.ownerId !== accountUser && runner.sharing !== 1)
        )
          return [];
        runner = {
          ...runner,
          memberId: accountUser,
          ownerId: accountUser,
          linearUserId: accountActor!,
          ready: 1,
          authExpired: 0,
          cooldownUntil: account.cooldownUntil,
          resetsAt: account.resetsAt,
          resolvedModel: account.resolvedModel,
        };
      }
      if (input.excludeRunnerIds?.includes(runner.id)) return [];
      const member = workspaceMember(db, current.workspace.id, runner.ownerId);
      if (
        !member ||
        (!["owner", "admin"].includes(member.role) && !member.teamIds.includes(issue.teamId))
      )
        return [];
      const legacyOwn =
        issue.assigneeId === runner.linearUserId ||
        (input.purpose === "helper" && runner.ownerId === requester);
      const legacyShared = runner.sharing === 1 && projectMembers.includes(runner.linearUserId);
      const projectItem = current.placement?.projectApprovalId != null;
      const own =
        current.placement && (projectItem || current.placement.ownerUserId)
          ? hostOwnerId === current.placement.ownerUserId
          : legacyOwn;
      const shared = current.placement?.ownerUserId && !projectItem ? false : legacyShared;
      if (!own && !shared) return [];
      if (
        input.profile &&
        input.purpose !== "prepare" &&
        (runner.authExpired === 1 || (input.purpose === "work" && runner.ready !== 1))
      )
        return [];
      if (
        input.role === "reviewer" &&
        lastImplementation?.model &&
        (input.profile?.model ?? runner.resolvedModel) === lastImplementation.model
      )
        return [];
      if (input.profile && runner.cooldownUntil > at) {
        cooled.push({ until: runner.cooldownUntil, known: runner.resetsAt !== null });
        return [];
      }
      const reviewRank =
        input.role === "reviewer" && lastImplementation?.runnerId === runner.id ? 1 : 0;
      return [{ runner, rank: reviewRank * 10 + (own ? 0 : 1) }];
    });
    ranked.sort(
      (a, b) =>
        a.rank - b.rank ||
        a.runner.virtualFinish - b.runner.virtualFinish ||
        a.runner.lastUsedAt - b.runner.lastUsedAt ||
        a.runner.id.localeCompare(b.runner.id),
    );
    return { ranked, cooled, binding, at };
  }
  return {
    async usageLimit(input) {
      const { cooled } = await evaluate(input);
      return cooled.reduce<{ until: number; known: boolean } | null>(
        (earliest, entry) => (!earliest || entry.until < earliest.until ? entry : earliest),
        null,
      );
    },
    async candidates(input) {
      const { ranked, binding, at } = await evaluate(input);
      for (const [key, admission] of admissions)
        if (admission.expiresAt <= at) admissions.delete(key);
      for (const { runner } of ranked)
        admissions.set(admissionKey(runner.id, input), {
          request: input,
          scope: binding,
          policy: policy(runner.id, input.profile?.agent),
          expiresAt: at + 15_000,
          memberId: runner.memberId,
        });
      return ranked.map(({ runner }) => ({
        id: runner.id,
        workspaceId: runner.workspaceId,
        ...(runner.memberId ? { memberId: runner.memberId } : {}),
      }));
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
          throw new Error("Runner selection authority changed before assignment");
        const runner = db
          .query<{ ownerId: string }, [string]>(
            "SELECT owner_user_id AS ownerId FROM runner WHERE id=? AND status='active' AND revoked_at IS NULL",
          )
          .get(input.runnerId);
        if (!runner) throw new Error("Runner identity changed before assignment");
        if (input.profile && !admission.memberId) {
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
          `INSERT INTO runner_execution_usage(command_id,runner_id,owner_user_id,item_id,run_id,agent,model,role,purpose,started_at)
          VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [
            input.commandId,
            input.runnerId,
            admission.memberId ?? runner.ownerId,
            input.itemId ?? null,
            input.runId ?? null,
            input.profile?.agent ?? null,
            input.profile?.model ?? null,
            input.role,
            input.purpose,
            input.startedAt,
          ],
        );
        admissions.delete(admissionKey(input.runnerId, input));
      });
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
            },
            [string, string]
          >(
            "SELECT owner_user_id AS ownerId,purpose,agent,item_id AS itemId,role,ended_at AS endedAt FROM runner_execution_usage WHERE command_id=? AND runner_id=?",
          )
          .get(input.commandId, input.runnerId);
        if (!usage) throw new Error("Runner usage receipt is not bound to an assignment");
        if (usage.endedAt !== null) return { retryable: false };
        const result = input.result;
        if ((!result && !input.failure) || (result && result.commandId !== input.commandId))
          throw new Error("Runner result is not bound to its command");
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
          usage.role === "reviewer" &&
          model !== null &&
          model === latestImplementation?.model;
        db.run(
          "UPDATE runner_execution_usage SET ended_at=?,outcome=?,resolved_model=?,output_bytes=? WHERE command_id=?",
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
            input.commandId,
          ],
        );
        const memberAccount = usage.agent
          ? db
              .query(
                "SELECT 1 FROM runner_member_account WHERE runner_id=? AND user_id=? AND agent=?",
              )
              .get(input.runnerId, usage.ownerId, usage.agent)
          : null;
        if (memberAccount && quota) {
          db.run(
            "UPDATE runner_member_account SET cooldown_until=?,updated_at=? WHERE runner_id=? AND user_id=? AND agent=?",
            [quota.cooldownUntil, input.finishedAt, input.runnerId, usage.ownerId, usage.agent!],
          );
          // Whether the cooldown is a reported reset or only the fallback retry interval.
          db.run(
            "INSERT OR REPLACE INTO runner_member_account_reset(runner_id,user_id,agent,resets_at) VALUES(?,?,?,?)",
            [input.runnerId, usage.ownerId, usage.agent!, quota.resetsAt],
          );
        }
        if (memberAccount && success)
          db.run(
            "UPDATE runner_member_account SET cooldown_until=CASE WHEN ? THEN cooldown_until ELSE 0 END,resolved_model=COALESCE(?,resolved_model),updated_at=? WHERE runner_id=? AND user_id=? AND agent=?",
            [
              usage.purpose === "prepare" ? 1 : 0,
              model,
              input.finishedAt,
              input.runnerId,
              usage.ownerId,
              usage.agent!,
            ],
          );
        if (memberAccount && result?.authRequired)
          db.run(
            "UPDATE runner_member_account SET connected=0,updated_at=? WHERE runner_id=? AND user_id=? AND agent=?",
            [input.finishedAt, input.runnerId, usage.ownerId, usage.agent!],
          );
        if (usage.agent && !memberAccount) {
          db.run(
            `UPDATE runner_agent_policy SET
            ready=CASE WHEN ? THEN 0 WHEN ? THEN 1 ELSE ready END,
            auth_expired=CASE WHEN ? THEN 1 WHEN ? THEN 0 ELSE auth_expired END,
            quota_state=CASE WHEN ? IS NOT NULL THEN ? WHEN ? THEN 'ok' ELSE quota_state END,
            resets_at=CASE WHEN ? IS NOT NULL THEN ? WHEN ? THEN NULL ELSE resets_at END,
            cooldown_until=CASE WHEN ? IS NOT NULL THEN ? WHEN ? THEN 0 ELSE cooldown_until END,
            resolved_model=COALESCE(?,resolved_model) WHERE runner_id=? AND agent=?`,
            [
              result?.authRequired || input.failure ? 1 : 0,
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

function owners({ stateType: _, ...rest }: LinearIssueOwnership) {
  return rest;
}
