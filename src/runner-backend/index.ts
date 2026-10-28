import { journal, journalCaught } from "../journal";
import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  existsSync,
  writeFileSync,
  openSync,
  closeSync,
  fstatSync,
  constants,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { checkoutExclusionsFor, loadConfigFile } from "../config";
import { join, relative, sep } from "node:path";
import type { Database } from "bun:sqlite";
import {
  endUsagePause,
  getTaskMode,
  getWorkItem,
  immediate,
  inMergeQueue,
  listHooks,
  pinnedSlotsReserved,
  releasePinnedSlot,
  restartedFromMergeQueue,
  runnerHasCapacity,
  runnerSlotsHeldBetweenCommands,
  saveCheckpoint,
  startUsagePause,
  usagePause,
  runnerLeaseCutoff,
  clearRunnerSessionMove,
  noteRunnerSessionMove,
} from "../db";
import {
  ArtifactRejectedError,
  assertDescendsFromAny,
  DEFAULT_RUN_TIMEOUT_MS,
  git,
  recoverAcpConversation,
  snapshotAgentInputs,
  snapshotImplementationSkills,
  runDir,
  type AcpEvent,
  type AcpEventOrigin,
  type RunAgentOptions,
  type RunAgentResult,
  encodePolicyFiles,
} from "../acp";
import { RunnerWorkFencedError, type RunnerWork } from "../runner-work";
import type { RunnerResults } from "../runner-results";
import type { RunnerHealth } from "../runner-health";
import type { RunnerArtifactStore } from "../runner-artifacts";
import {
  MAIN_COMMIT_RUNNER_VERSION,
  REBASE_RUNNER_VERSION,
  REVIEW_COMMAND_RUNNER_VERSION,
  RUNNER_LEASE_GRACE_MS,
  RUNTIMES_RUNNER_VERSION,
  SESSION_RESUME_RUNNER_VERSION,
  type RunnerCommand,
  type RunnerResult,
  type RunnerVersion,
} from "../runner-protocol";
import type { RunnerTranscripts } from "../runner-transcripts";
import type { RunnerInputStore } from "../runner-inputs";
import { fastForwardToBranchTip } from "./candidate";
import { createRemoteCancellation } from "./cancel";
import { createRemoteHandover } from "./handover";
import { createRemoteCheckpoint, recordRunnerCheckpoint } from "./checkpoint";
import {
  planSessionRestore,
  runnerGoneReason,
  sessionMoveNotice,
  type SessionRestorePlan,
} from "./session-restore";
import {
  RetryableRunnerError,
  runWithFailover,
  USAGE_LIMIT_RESUME_SLACK_MS,
  UsageLimitPause,
  type FailoverAttempt,
  type UsageLimit,
  type UsageLimitWait,
} from "./failover";
import {
  isReadOnlyTaskMode,
  isResponseTaskMode,
  PawsShutdown,
  RunnerCapacityWait,
  RunnerSetupRequired,
  WORKSPACE_HOOK_LIMIT,
  type WorkspaceHook,
} from "../core";
import {
  PlacementRaceError,
  quotaSignal,
  RUNNER_ONLINE_MS,
  SESSION_GRACE_MS,
  type RunnerPlacement,
} from "../runner-placement";

class RunnerUnavailableError extends Error {
  override readonly name = "RunnerUnavailableError";
}

/** The runner did not finish preparing the agent in time. It is temporary, so the item retries. */
export class RemotePreparationTimeout extends Error {
  override readonly name = "TimeoutError";
  constructor() {
    super("Remote agent preparation timed out");
  }
}

const DEFAULT_POLL_INTERVAL_MS = 250;
/** Above the longest silent tool call seen; a run this quiet must be confirmed by its runner. */
const DEFAULT_SILENT_RUN_MS = 20 * 60_000;
/** A confirmation older than this no longer counts: runners heartbeat every 15 seconds. */
const RUN_CONFIRMATION_MS = 60_000;
/** A run this quiet is hung even when its runner still confirms it: the agent is stopped. */
const DEFAULT_HUNG_RUN_MS = 45 * 60_000;
const RUN_LOST_THOUGHT = "The runner lost this run after it restarted; continuing from the branch.";
const RUN_HUNG_THOUGHT = (minutes: number) =>
  `The agent sent nothing for ${minutes} minutes, so Paws stopped it; continuing from the branch.`;
const RUN_LOST_MESSAGE = "The runner no longer runs this command.";
const NO_FREE_CAPACITY = ": no free capacity";
type SessionHolder = { runnerId: string; agent: string; sessionId: string };

function earlierSession(
  db: Database,
  itemId: string,
  runnerId: string,
  agent: string,
): string | undefined {
  const holder = sessionHolder(db, itemId);
  return holder?.runnerId === runnerId && holder.agent === agent ? holder.sessionId : undefined;
}

/** The runner and agent that hold the item's last resumable agent session. */
function sessionHolder(db: Database, itemId: string): SessionHolder | undefined {
  const rows = db
    .query<{ envelope: string; payload: string; receivedAt: number }, [string]>(
      `SELECT c.envelope, rr.payload, rr.received_at AS receivedAt FROM runner_result rr
       JOIN runner_command c ON c.id=rr.command_id
       JOIN run ON run.id=rr.run_id
       WHERE run.item_id=? AND c.kind='run'
       ORDER BY rr.received_at DESC, rr.generation DESC`,
    )
    .all(itemId);
  for (const row of rows) {
    const command = JSON.parse(
      Buffer.from((JSON.parse(row.envelope) as { payload: string }).payload, "base64url").toString(
        "utf8",
      ),
    ) as {
      runnerId?: string;
      checkpoint?: boolean;
      profile?: { agent?: string };
    };
    if (command.checkpoint === false) continue;
    const result = JSON.parse(row.payload) as {
      stopReason?: string;
      sessionId?: string;
      errorMessage?: string;
    };
    // An errored session may hold the prompt that failed; a usage-limit stop does not.
    const resumable =
      result.stopReason !== "error" ||
      (result.errorMessage !== undefined &&
        quotaSignal(result.errorMessage, row.receivedAt)?.state === "exhausted");
    return command.runnerId && command.profile?.agent && resumable && result.sessionId
      ? {
          runnerId: command.runnerId,
          agent: command.profile.agent,
          sessionId: result.sessionId,
        }
      : undefined;
  }
  return undefined;
}

function versionAtLeast(version: string | null | undefined, minimum: RunnerVersion): boolean {
  const parts = version
    ?.match(/^(\d+)\.(\d+)\.(\d+)/)
    ?.slice(1)
    .map(Number);
  if (!parts) return false;
  for (const [index, part] of parts.entries())
    if (part !== minimum[index]) return part > minimum[index]!;
  return true;
}

type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" | "task" }>;

/**
 * Where a command for the run goes. A turn that continues the agent session is pinned to the
 * run's runner. Merge-queue work that continues no session, such as a re-verify's checks and
 * review, is not pinned: it prefers the run's runner and takes any eligible one. So when such
 * work last ran on another runner, the merge-queue item's next turn is pinned to the runner
 * holding its session. A run that moved because its runner went away keeps its new runner.
 */
function runRunner(
  db: Database,
  input: { itemId: string; runId: string; continuesSession: boolean; sessionRunnerId?: string },
): { pinnedRunnerId?: string; preferRunnerId?: string } {
  const row = db
    .query<{ runnerId: string; kind: string | null; envelope: string | null }, [string]>(
      `SELECT w.runner_id AS runnerId, c.kind, c.envelope FROM runner_work w
       LEFT JOIN runner_command c ON c.id=w.command_id WHERE w.run_id=?`,
    )
    .get(input.runId);
  if (!row) return {};
  const merging = inMergeQueue(db, input.itemId);
  if (!input.continuesSession && merging) return { preferRunnerId: row.runnerId };
  const backToSession =
    input.continuesSession &&
    input.sessionRunnerId !== undefined &&
    (merging || restartedFromMergeQueue(db, input.itemId)) &&
    (row.kind === "review" ||
      (row.kind === "run" &&
        row.envelope !== null &&
        (
          JSON.parse(
            Buffer.from(
              (JSON.parse(row.envelope) as { payload: string }).payload,
              "base64url",
            ).toString("utf8"),
          ) as { checkpoint?: boolean }
        ).checkpoint === false));
  return { pinnedRunnerId: backToSession ? input.sessionRunnerId : row.runnerId };
}

function snapshotCommit(workspace: string, repository: { owner: string; repo: string }) {
  const fd = openSync(`${workspace}.repository.json`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = fstatSync(fd);
    if (
      !info.isFile() ||
      info.nlink !== 1 ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0 ||
      info.size > 65536
    )
      throw new Error("Repository snapshot metadata is unsafe");
    const saved = JSON.parse(readFileSync(fd, "utf8")) as {
      owner?: unknown;
      repo?: unknown;
      commit?: unknown;
    };
    if (
      saved.owner !== repository.owner ||
      saved.repo !== repository.repo ||
      typeof saved.commit !== "string" ||
      !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(saved.commit)
    )
      throw new Error("Repository snapshot binding changed");
    return saved.commit;
  } finally {
    closeSync(fd);
  }
}

export function createRemoteAgentRunner(options: {
  db: Database;
  work: RunnerWork;
  results: RunnerResults;
  health: RunnerHealth;
  artifacts?: RunnerArtifactStore;
  transcripts?: Pick<RunnerTranscripts, "download">;
  inputs?: Pick<RunnerInputStore, "stage" | "stagePrompt">;
  fetchCandidate(input: {
    itemId: string;
    worktree: string;
    baseSha: string;
    candidateSha: string;
    branch: string;
    remoteUrl: string;
    networkGit: (args: string[]) => Promise<string>;
    signal: AbortSignal;
  }): Promise<void>;
  checkpointBot?: (
    repository: string,
  ) => Promise<NonNullable<Extract<RunnerCommand, { type: "run" }>["checkpointBot"]>>;
  now?: () => number;
  pollIntervalMs?: number;
  /** How long a run may go without a runner event before Paws asks whether the runner has it. */
  silentRunMs?: number;
  /** How long a run may go without a runner event before Paws stops it, confirmed or not. */
  hungRunMs?: number;
  placement?: RunnerPlacement;
}) {
  const { db, work, results, health } = options;
  const now = options.now ?? Date.now;
  const interval = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const silentRunMs = options.silentRunMs ?? DEFAULT_SILENT_RUN_MS;
  const hungRunMs = Math.max(silentRunMs, options.hungRunMs ?? DEFAULT_HUNG_RUN_MS);
  const reservations = new Map<string, string>();
  /** Items told that their runner lost a run, so a run lost again on a retry says it once. */
  const toldLost = new Set<string>();
  function usageLimitReset(agent: string, sessionId: string | null): number | null {
    const runnerInScope = `r.status='active' AND r.revoked_at IS NULL AND r.workspace_id IN
      (SELECT w.id FROM workspace w JOIN linear_session s ON s.organization_id=w.linear_organization_id WHERE s.session_id=?2)`;
    return (
      db
        .query<{ resetsAt: number | null }, [string, string | null, number]>(
          `SELECT MIN(resets_at) AS resetsAt FROM (
         SELECT p.cooldown_until AS resets_at FROM runner_agent_policy p JOIN runner r ON r.id=p.runner_id
         WHERE p.agent=?1 AND p.cooldown_until>?3 AND ${runnerInScope})`,
        )
        .get(agent, sessionId, now())?.resetsAt ?? null
    );
  }
  /** Workspace hooks for the run's agent, signed into the command with everything else. */
  function runHooks(agent: string): { hooks?: WorkspaceHook[] } {
    const hooks = listHooks(db).filter((hook) =>
      (hook.agents as readonly string[]).includes(agent),
    );
    return hooks.length ? { hooks: hooks.slice(0, WORKSPACE_HOOK_LIMIT) } : {};
  }
  async function select(
    itemId: string,
    placement: Parameters<RunnerPlacement["candidates"]>[0],
    limit?: UsageLimit,
    /** Receives each runner's rejection as `id: reason`. */
    rejected: string[] = [],
  ) {
    const offered: string[] = [];
    const selected = await place(itemId, placement, rejected, offered);
    if (selected) return { ...selected, offered };
    const details = rejected.map((entry) => {
      const separator = entry.indexOf(":");
      const id = separator < 0 ? entry : entry.slice(0, separator);
      const name =
        db.query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?").get(id)?.name ??
        id;
      return `${name}${separator < 0 ? "" : entry.slice(separator)}`;
    });
    if (!details.length) details.push("no paired runners in the task workspace");
    console.warn("Runner placement failed", {
      itemId,
      role: placement.role,
      purpose: placement.purpose,
      rejected: details,
    });
    // No runner the delegator may use, as opposed to usable runners that are busy: a first start
    // holds the task until the delegator sets a runner up. Later runs wait as before.
    if (offered.length === 0 && options.placement?.setupNeed && !startedWork(itemId)) {
      const need = options.placement.setupNeed(placement);
      if (need) throw new RunnerSetupRequired(need);
    }
    const agent = placement.profile?.agent;
    const resetsAt = agent
      ? usageLimitReset(agent, getWorkItem(db, itemId)?.sessionKey ?? null)
      : null;
    const heldForSession =
      !placement.pinnedRunnerId &&
      placement.session !== undefined &&
      offered.length === 1 &&
      offered[0] === placement.session.runnerId;
    const busy = rejected
      .filter((reason) => reason.endsWith(NO_FREE_CAPACITY))
      .map((reason) => reason.slice(0, -NO_FREE_CAPACITY.length));
    if (
      (resetsAt === null || heldForSession) &&
      (busy.length > 0 ||
        (offered.length === 0 &&
          db
            .query("SELECT 1 FROM runner WHERE status='active' AND revoked_at IS NULL LIMIT 1")
            .get() !== null))
    )
      throw new RunnerCapacityWait(busy, heldForSession ? SESSION_GRACE_MS : undefined, details);
    if (agent && limit && limit.resumeAt > now())
      throw new UsageLimitPause(agent, limit.resumeAt, limit.resetsAt, limit.runnerId);
    if (!agent || resetsAt === null)
      throw new RunnerUnavailableError(
        `No available paired runner can access this Linear task repository (${details.join("; ")})`,
      );
    throw new UsageLimitPause(agent, resetsAt + USAGE_LIMIT_RESUME_SLACK_MS, resetsAt, null);
  }
  /**
   * Places a handed-over run. With no eligible runner the run waits where it is, keeping its
   * turn, says why once, and is placed as soon as a runner fits or the run stops.
   */
  async function selectAfterHandover(
    itemId: string,
    placement: Parameters<RunnerPlacement["candidates"]>[0],
    limit: UsageLimit | undefined,
    move: HandoverMove,
    onEvent: RunAgentOptions["onEvent"],
    runId: string,
  ) {
    for (;;) {
      const rejected: string[] = [];
      try {
        const selected = await select(itemId, placement, limit, rejected);
        // It lands: the session leaves the old runner's card and shows on the new one.
        if (move.from) clearRunnerSessionMove(db, runId, move.from);
        return selected;
      } catch (error) {
        if (error instanceof UsageLimitPause || placement.signal?.aborted) throw error;
        journalCaught(
          error,
          "runner-backend.selectAfterHandover",
          itemId,
          "waiting for an eligible runner",
        );
        if (!move.waiting) {
          move.waiting = true;
          const why = handoverWaitReason(move, rejected, error, placement.profile?.agent);
          // The runner card shows the reason Linear gets on the session's row.
          if (move.from)
            noteRunnerSessionMove(db, {
              runId,
              runnerId: move.from,
              status: "waiting",
              reason: why,
              now: now(),
            });
          await onEvent?.({ type: "progress", text: handoverWaitNotice(db, move, why) });
        }
      }
      await delay(interval * 20, undefined, { signal: placement.signal });
    }
  }
  /**
   * A placement that went stale before assignment, usually a runner restarting, is not a run
   * failure. Nothing was assigned, so the item waits for a runner like an offline one and is
   * placed again with the runner-wait backoff, on the same runner once it is back or another.
   */
  function placementRace(itemId: string, runnerId: string, error: PlacementRaceError) {
    const name =
      db.query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?").get(runnerId)
        ?.name ?? runnerId;
    journal(
      `item ${itemId} placement on runner ${runnerId} raced: ${error.message}; placing again`,
    );
    return new RunnerCapacityWait([], undefined, [`${name}: ${error.message}`]);
  }
  /** Whether any runner has already run work, not just preparation, for the item. */
  function startedWork(itemId: string): boolean {
    return (
      db
        .query("SELECT 1 FROM runner_execution_usage WHERE item_id=? AND purpose='work' LIMIT 1")
        .get(itemId) !== null
    );
  }
  /** Reservations per runner whose run has no runner_work row there yet. */
  function unassigned() {
    const counts = new Map<string, number>();
    for (const [runId, hostId] of reservations)
      if (
        !db
          .query<{ held: number }, [string, string]>(
            "SELECT 1 AS held FROM runner_work WHERE run_id=? AND runner_id=?",
          )
          .get(runId, hostId)
      )
        counts.set(hostId, (counts.get(hostId) ?? 0) + 1);
    return counts;
  }
  async function place(
    itemId: string,
    placement: Parameters<RunnerPlacement["candidates"]>[0],
    rejected: string[],
    offered: string[] = [],
  ) {
    const item = getWorkItem(db, itemId);
    if (!item?.currentRunId) throw new Error("Remote task has no current run");
    let candidates = options.placement
      ? await options.placement.candidates({
          ...placement,
          reserved: unassigned(),
          onRejected: (id, reason) => rejected.push(`${id}: ${reason}`),
        })
      : db
          .query<{ id: string; workspaceId: string }, []>(
            `SELECT r.id,r.workspace_id AS workspaceId FROM runner r
       JOIN workspace_member m ON m.workspace_id=r.workspace_id AND m.user_id=r.owner_user_id
       WHERE r.status='active' AND r.revoked_at IS NULL AND m.active=1
       AND r.last_seen_at>${now() - 60_000}
       ORDER BY r.last_seen_at DESC,r.id`,
          )
          .all();
    const pinnedOnline = Boolean(
      placement.purpose !== "prepare" &&
      placement.pinnedRunnerId &&
      placement.pinnedRunnerId !== placement.handedOverFrom &&
      db
        .query(
          "SELECT 1 FROM runner WHERE id=? AND status='active' AND revoked_at IS NULL AND last_seen_at>?",
        )
        .get(placement.pinnedRunnerId, now() - RUNNER_ONLINE_MS),
    );
    if (pinnedOnline)
      candidates = candidates.filter((runner) => runner.id === placement.pinnedRunnerId);
    else if (placement.preferRunnerId)
      candidates = [
        ...candidates.filter((runner) => runner.id === placement.preferRunnerId),
        ...candidates.filter((runner) => runner.id !== placement.preferRunnerId),
      ];
    placement.signal?.throwIfAborted();
    offered.push(...candidates.map((runner) => runner.id));
    const pending = unassigned();
    for (const runner of candidates) {
      if (runner.id === placement.handedOverFrom) {
        rejected.push(`${runner.id}: handed the session over`);
        continue;
      }
      if (placement.excludeRunnerIds?.includes(runner.id) && !pinnedOnline) {
        rejected.push(`${runner.id}: excluded after failed attempt`);
        continue;
      }
      const reserved = pending.get(runner.id) ?? 0;
      if (reservations.has(item.currentRunId)) {
        rejected.push(`${runner.id}: the run is already being placed`);
        continue;
      }
      const held =
        runnerSlotsHeldBetweenCommands(db, runner.id, now(), item.currentRunId) +
        pinnedSlotsReserved(db, runner.id, itemId, now());
      if (!runnerHasCapacity(db, runner.id, now(), item.currentRunId, reserved + held)) {
        rejected.push(`${runner.id}${NO_FREE_CAPACITY}`);
        continue;
      }
      try {
        const mode = getTaskMode(db, itemId);
        if (isResponseTaskMode(mode))
          work.scopeTask(item.currentRunId, runner.workspaceId, work.identity(runner.id).userId);
        else work.scope(item.currentRunId, runner.workspaceId);
        reservations.set(item.currentRunId, runner.id);
        releasePinnedSlot(db, itemId);
        return { ...runner, runId: item.currentRunId };
      } catch (error) {
        journalCaught(error, "runner-backend.place.getTaskMode", itemId);
        rejected.push(`${runner.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return null;
  }
  /**
   * The open work a runner kept for the item. A Closeout review or check run passes its prompt,
   * which names the heads it covers: it attaches only to the same command, and cancels other open
   * work no attempt here is reading so it can be placed again.
   */
  function attachedWork(itemId: string, type: WorkCommand["type"], closeoutPrompt?: string) {
    const runId = getWorkItem(db, itemId)?.currentRunId;
    if (!runId) return undefined;
    const row = db
      .query<
        {
          runnerId: string;
          workspaceId: string;
          envelope: string;
          cursor: number;
          generation: number;
        },
        [string, number]
      >(
        `SELECT w.runner_id AS runnerId, w.workspace_id AS workspaceId, c.envelope,
         w.consumed_sequence AS cursor, w.generation
         FROM runner_work w JOIN runner_command c ON c.id=w.command_id
         WHERE w.run_id=?1 AND w.ended_at IS NULL AND (w.lease_until>?2 OR EXISTS(
           SELECT 1 FROM runner_result r
           WHERE r.run_id=w.run_id AND r.generation=w.generation AND r.command_id=w.command_id))`,
      )
      .get(runId, runnerLeaseCutoff(now()));
    if (!row) return undefined;
    const command = JSON.parse(
      Buffer.from((JSON.parse(row.envelope) as { payload: string }).payload, "base64url").toString(
        "utf8",
      ),
    ) as WorkCommand;
    if (
      closeoutPrompt !== undefined &&
      (command.type !== type || command.prompt !== closeoutPrompt)
    ) {
      // The run holds one command at a time, so the stale one would block the new assignment.
      if (!reservations.has(runId)) {
        try {
          const issuedAt = now();
          work.enqueue({
            id: randomUUID(),
            runnerId: row.runnerId,
            workspaceId: row.workspaceId,
            issuedAt,
            expiresAt: issuedAt + 60_000,
            type: "cancel",
            runId,
            generation: row.generation,
          });
        } catch (error) {
          journalCaught(error, "runner-backend.attachedWork.cancelStale", itemId);
        }
      }
      return undefined;
    }
    if (command.type !== type) return undefined;
    return {
      selected: {
        id: row.runnerId,
        workspaceId: row.workspaceId,
        runId,
      },
      assigned: command,
      // A response task without a repository has no commit.
      baseSha: command.repository?.baseSha,
      mainSha: command.type === "task" ? undefined : command.repository.mainSha,
      deadline: command.expiresAt,
      cursor: row.cursor,
    };
  }
  const checkpointBeforeStop = createRemoteCheckpoint(options);
  const cancelItem = createRemoteCancellation({ ...options, checkpoint: checkpointBeforeStop });
  const handOverItem = createRemoteHandover(options);
  function usageLimitWait(itemId: string, input: RunAgentOptions): UsageLimitWait {
    return {
      now,
      async pause(limit) {
        const runId = getWorkItem(db, itemId)?.currentRunId;
        if (!runId) throw limit;
        const agent = agentName(limit.agent);
        startUsagePause(db, {
          runId,
          itemId,
          agent: limit.agent,
          runnerId: limit.runnerId,
          resetsAt: limit.resetsAt,
          resumeAt: limit.resumeAt,
          pausedAt: now(),
        });
        try {
          await input.onEvent?.({
            type: "progress",
            text: `Paused: ${agent} reached its usage limit. Paws continues at ${clockTime(limit.resumeAt, now())}.`,
          });
          // Resume now moves resume_at forward; Stop aborts the signal.
          for (;;) {
            const wait = (usagePause(db, runId)?.resumeAt ?? 0) - now();
            if (wait <= 0) break;
            await delay(Math.min(wait, interval * 20), undefined, { signal: input.signal });
          }
        } finally {
          endUsagePause(db, runId);
        }
        input.signal?.throwIfAborted();
        await input.onEvent?.({
          type: "progress",
          text: `Continuing: Paws is trying ${agent} again after its usage limit.`,
        });
      },
    };
  }
  return {
    cancelItem,
    handOverItem,
    forItem(itemId: string) {
      const attempt = async (
        input: RunAgentOptions,
        excluded: readonly string[],
        limit: UsageLimit | undefined,
        move: HandoverMove,
      ): Promise<RunAgentResult> => {
        input.signal?.throwIfAborted();
        if (!input.profile) throw new Error("Remote agent profile is required");
        // A handover outlives this call: after a restart the run still avoids the runner it left.
        if (!move.from && !input.prepareOnly && input.role === "implementer") {
          const left = handedOverFrom(db, itemId);
          if (left) Object.assign(move, left);
        }
        const mode = getTaskMode(db, itemId);
        const responseTask = isResponseTaskMode(mode);
        if (
          responseTask &&
          (input.role !== "implementer" ||
            (!input.prepareOnly && Boolean(input.readOnly) !== isReadOnlyTaskMode(mode)))
        )
          throw new Error("Remote response task role or access changed");
        if (responseTask && !options.transcripts)
          throw new Error("Remote response task transcript is unavailable");
        if (!responseTask && !input.prepareOnly && input.readOnly && input.role !== "reviewer")
          throw new Error("Read-only remote work requires the reviewer role");
        if (
          input.reviewCommand &&
          (responseTask || input.prepareOnly || input.role !== "reviewer" || !input.readOnly)
        )
          throw new Error("A review command runs only as read-only reviewer work");
        if (input.reviewCommand && (input.profile.agent === "grok" || !input.profile.model))
          throw new Error(
            "The reviewer profile needs a Claude or Codex model to run the agent's review command",
          );
        const suppliedInputs = snapshotAgentInputs(input.worktreePath, input.inputFiles);
        const profile = { ...input.profile, model: input.profile.model ?? null };
        const continuesSession =
          !responseTask &&
          !input.prepareOnly &&
          input.role === "implementer" &&
          input.checkpoint !== false;
        const holder = continuesSession ? sessionHolder(db, itemId) : undefined;
        const session = holder?.agent === profile.agent ? { runnerId: holder.runnerId } : undefined;
        const runId = getWorkItem(db, itemId)?.currentRunId;
        const { pinnedRunnerId, preferRunnerId } =
          !input.prepareOnly && runId
            ? runRunner(db, {
                itemId,
                runId,
                continuesSession,
                ...(session ? { sessionRunnerId: session.runnerId } : {}),
              })
            : {};
        const placementRequest: Parameters<RunnerPlacement["candidates"]>[0] = {
          itemId,
          profile,
          role: input.role,
          purpose: input.prepareOnly ? "prepare" : "work",
          excludeRunnerIds: excluded,
          ...(pinnedRunnerId ? { pinnedRunnerId } : {}),
          ...(preferRunnerId ? { preferRunnerId } : {}),
          ...(move.from ? { handedOverFrom: move.from } : {}),
          ...(session ? { session } : {}),
          // A moved run prefers a runner that can continue its saved agent session.
          ...(pinnedRunnerId &&
          runId &&
          !responseTask &&
          input.role === "implementer" &&
          input.checkpoint !== false
            ? {
                restore: (runnerId: string) => {
                  const plan = planSessionRestore(db, {
                    runId,
                    agent: profile.agent,
                    targetRunnerId: runnerId,
                  });
                  return plan.eligible
                    ? { sameVersion: plan.restoreSession.agentVersion === plan.targetVersion }
                    : null;
                },
              }
            : {}),
          signal: input.signal,
        };
        // A Closeout review or check run: work that continues no session and runs while verifying.
        const closeoutWork =
          !responseTask && (input.role === "reviewer" || input.checkpoint === false);
        // Work a runner kept through a Paws restart is read from where it stopped. A response
        // task binds its Linear session again below, before any event is read.
        const attached = input.prepareOnly
          ? undefined
          : attachedWork(
              itemId,
              responseTask ? "task" : input.role === "reviewer" ? "review" : "run",
              closeoutWork ? input.prompt : undefined,
            );
        const chosen = attached
          ? undefined
          : move.from
            ? await selectAfterHandover(
                itemId,
                placementRequest,
                limit,
                move,
                input.onEvent,
                input.runId,
              )
            : await select(itemId, placementRequest, limit);
        const selected = attached?.selected ?? chosen!;
        const sessionBusy =
          session !== undefined &&
          chosen?.offered.includes(session.runnerId) === true &&
          !runnerHasCapacity(db, session.runnerId, now(), selected.runId);
        const controller = new AbortController();
        const abort = () => controller.abort(input.signal?.reason);
        input.signal?.addEventListener("abort", abort, { once: true });
        if (input.signal?.aborted) abort();
        const signal = controller.signal;
        let command: WorkCommand | undefined;
        let question: Promise<void> | undefined;
        let questionError: unknown;
        let publishedEffects = false;
        let asked = false;
        let transcriptBytes = 0;
        let previousTranscript = Buffer.alloc(0);
        const transcript = `${runDir(input.pawsRoot, input.runId)}/acp.jsonl`;
        const emit = async (event: AcpEvent, origin?: AcpEventOrigin) => {
          const line = `${JSON.stringify({ t: new Date(now()).toISOString(), event })}\n`;
          transcriptBytes += Buffer.byteLength(line);
          if (transcriptBytes > 16_777_216) throw new Error("Remote transcript exceeds limit");
          appendFileSync(transcript, line, { mode: 0o600 });
          await input.onEvent?.(event, origin);
        };
        try {
          const taskScope = responseTask
            ? work.scopeTask(
                selected.runId,
                selected.workspaceId,
                work.identity(selected.id).userId,
              )
            : undefined;
          mkdirSync(runDir(input.pawsRoot, input.runId), { recursive: true, mode: 0o700 });
          signal.throwIfAborted();
          if (options.transcripts && existsSync(transcript))
            previousTranscript = readFileSync(transcript);
          if (input.prepareOnly) {
            const id = randomUUID();
            const issuedAt = now();
            try {
              immediate(db, () => {
                work.enqueue({
                  id,
                  runnerId: selected.id,
                  workspaceId: selected.workspaceId,
                  issuedAt,
                  expiresAt: issuedAt + 120_000,
                  type: "probe",
                  profile,
                });
                options.placement?.started({
                  commandId: id,
                  runnerId: selected.id,
                  itemId,
                  runId: selected.runId,
                  profile,
                  role: input.role,
                  purpose: "prepare",
                  startedAt: issuedAt,
                });
              });
            } catch (error) {
              if (error instanceof PlacementRaceError)
                throw placementRace(itemId, selected.id, error);
              throw error;
            }
            while (now() < issuedAt + 120_000) {
              signal.throwIfAborted();
              if (taskScope)
                work.scopeTask(
                  selected.runId,
                  selected.workspaceId,
                  work.identity(selected.id).userId,
                );
              else work.scope(selected.runId, selected.workspaceId);
              const result = health.read(selected.id, id);
              if (result) {
                const disposition = immediate(db, () =>
                  options.placement?.finished({
                    commandId: id,
                    runnerId: selected.id,
                    profile,
                    result,
                    finishedAt: now(),
                  }),
                );
                if (
                  disposition?.retryable &&
                  result.agentExited &&
                  !result.cancelled &&
                  !result.timedOut
                )
                  throw new RetryableRunnerError(
                    selected.id,
                    result.authRequired
                      ? "The runner agent requires sign-in."
                      : "The runner agent exhausted its observed quota.",
                    undefined,
                    false,
                    disposition.usageLimit,
                  );
                return { ...result, role: input.role, transcriptPath: transcript };
              }
              await delay(interval, undefined, { signal });
            }
            throw new RemotePreparationTimeout();
          }
          /**
           * Brings a WIP commit a runner published after this worktree's head into it, so a
           * restarted turn starts from the work a stopped or lost one saved.
           */
          const importCheckpoint = async (networkGit: (args: string[]) => Promise<string>) => {
            const scoped = work.scope(selected.runId, selected.workspaceId);
            if (scoped.repository && scoped.item.branchName)
              await fastForwardToBranchTip({
                worktree: input.worktreePath,
                branch: scoped.item.branchName,
                remoteUrl: scoped.repository.remoteUrl,
                networkGit,
                signal,
              });
            const wip = getWorkItem(db, itemId)?.checkpoint?.wipCommit;
            const head = (await git(["-C", input.worktreePath, "rev-parse", "HEAD"])).trim();
            if (!wip || wip === head || !scoped.repository) return;
            const known = await git([
              "-C",
              input.worktreePath,
              "merge-base",
              "--is-ancestor",
              wip,
              head,
            ]).then(
              () => true,
              () => false,
            );
            if (known) return;
            // A commit Paws already holds is its own history; only a runner's checkpoint is new.
            const local = await git([
              "-C",
              input.worktreePath,
              "cat-file",
              "-e",
              `${wip}^{commit}`,
            ]).then(
              () => true,
              () => false,
            );
            if (local) return;
            // The turn must start from the saved work; a checkout without it would lose it.
            try {
              await options.fetchCandidate({
                itemId,
                worktree: input.worktreePath,
                baseSha: head,
                candidateSha: wip,
                branch: scoped.item.branchName,
                remoteUrl: scoped.repository.remoteUrl,
                networkGit,
                signal,
              });
            } catch (error) {
              throw new Error(
                `Paws could not restore the saved work at ${wip.slice(0, 7)} from ${scoped.item.branchName}: ${error instanceof Error ? error.message : String(error)}`,
                { cause: error },
              );
            }
          };
          const placed =
            attached ??
            (await (async () => {
              // A runner command does not carry the caller's session, so a resume replays.
              const prompt = input.resume?.replayPrompt ?? input.prompt;
              const prepared = input.prepareInputFiles
                ? await input.prepareInputFiles({
                    workspace: input.worktreePath,
                    prompt,
                    signal,
                  })
                : { prompt, inputFiles: [] };
              const scoped = taskScope ?? work.scope(selected.runId, selected.workspaceId);
              const files = snapshotAgentInputs(input.worktreePath, [
                ...suppliedInputs,
                ...prepared.inputFiles,
              ]);
              const skillBundle =
                !taskScope && input.role === "implementer"
                  ? await snapshotImplementationSkills({
                      pawsRoot: input.pawsRoot,
                      worktree: input.worktreePath,
                      repository: `${scoped.repository!.owner}/${scoped.repository!.repo}`,
                      signal,
                    })
                  : undefined;
              const skillsInputId = skillBundle ? files.length : undefined;
              if (skillBundle)
                files.push({
                  path: `${input.worktreePath}/.paws-skills-${randomUUID()}.json`,
                  mimeType: "application/vnd.paws.skills+json",
                  bytes: skillBundle,
                });
              if (files.length && !options.inputs)
                throw new Error("Remote agent input transfer is unavailable");
              if (prepared.prompt.length > 65_536 && !options.inputs)
                throw new Error("Remote conversation context transfer is unavailable");
              const commandId = randomUUID();
              const inputFiles = files.length
                ? options.inputs!.stage(
                    commandId,
                    files.map((file) => ({
                      ...file,
                      path: relative(input.worktreePath, file.path).split(sep).join("/"),
                    })),
                  )
                : undefined;
              const promptContext =
                prepared.prompt.length > 65_536
                  ? options.inputs!.stagePrompt(commandId, prepared.prompt)
                  : undefined;
              // A run that leaves its pinned runner may continue its saved agent session there.
              const restorePlan: SessionRestorePlan | undefined =
                !taskScope &&
                input.role === "implementer" &&
                input.checkpoint !== false &&
                pinnedRunnerId &&
                pinnedRunnerId !== selected.id
                  ? planSessionRestore(db, {
                      runId: selected.runId,
                      agent: profile.agent,
                      targetRunnerId: selected.id,
                    })
                  : undefined;
              if (!taskScope && input.role === "implementer" && input.networkGit)
                await importCheckpoint(input.networkGit);
              const head = taskScope
                ? undefined
                : (await git(["-C", input.worktreePath, "rev-parse", "HEAD"])).trim();
              // The checkout holds the snapshot's commit, or the latest pushed commit when newer.
              const baseSha = taskScope
                ? taskScope.repository
                  ? snapshotCommit(input.worktreePath, taskScope.repository)
                  : undefined
                : restorePlan?.eligible &&
                    restorePlan.commitSha !== head &&
                    (await git([
                      "-C",
                      input.worktreePath,
                      "merge-base",
                      "--is-ancestor",
                      head!,
                      restorePlan.commitSha,
                    ]).then(
                      () => true,
                      (caughtError) => {
                        journalCaught(caughtError, "runner-backend.forItem.restoreCommit", itemId);
                        return false;
                      },
                    ))
                  ? restorePlan.commitSha
                  : head;
              if (!taskScope && !scoped.item.checkpoint && input.role === "implementer")
                saveCheckpoint(db, itemId, { phase: "running", baseSha, wipCommit: baseSha });
              const acceptsMainCommit = versionAtLeast(
                db
                  .query<{ version: string | null }, [string]>(
                    "SELECT runner_version AS version FROM runner_host_status WHERE runner_id=?",
                  )
                  .get(selected.id)?.version,
                MAIN_COMMIT_RUNNER_VERSION,
              );
              const acceptsRebase =
                !taskScope &&
                versionAtLeast(
                  db
                    .query<{ version: string | null }, [string]>(
                      "SELECT runner_version AS version FROM runner_host_status WHERE runner_id=?",
                    )
                    .get(selected.id)?.version,
                  REBASE_RUNNER_VERSION,
                );
              const checkpointBase = getWorkItem(db, itemId)?.checkpoint?.baseSha;
              const upstreamMain = acceptsRebase
                ? await git([
                    "-C",
                    input.worktreePath,
                    "rev-parse",
                    "--verify",
                    "--quiet",
                    "refs/paws/upstream-main^{commit}",
                  ]).then(
                    (sha) => sha.trim() || undefined,
                    (caughtError1) => {
                      journalCaught(caughtError1, "runner-backend.forItem.git", itemId);
                      return undefined;
                    },
                  )
                : undefined;
              const fetchedMain =
                upstreamMain &&
                checkpointBase &&
                (await git([
                  "-C",
                  input.worktreePath,
                  "merge-base",
                  "--is-ancestor",
                  upstreamMain,
                  checkpointBase,
                ])
                  .then(() => true)
                  .catch((caughtError1) => {
                    journalCaught(caughtError1, "runner-backend.forItem.then", itemId);
                    return false;
                  }))
                  ? undefined
                  : upstreamMain;
              const mainCandidate = input.mainSha ?? fetchedMain ?? checkpointBase;
              const mainSha =
                !taskScope &&
                acceptsMainCommit &&
                baseSha &&
                mainCandidate &&
                mainCandidate !== baseSha &&
                (acceptsRebase ||
                  (await git([
                    "-C",
                    input.worktreePath,
                    "merge-base",
                    "--is-ancestor",
                    mainCandidate,
                    baseSha,
                  ])
                    .then(() => true)
                    .catch((caughtError2) => {
                      journalCaught(caughtError2, "runner-backend.forItem.then", itemId);
                      return false;
                    })))
                  ? mainCandidate
                  : undefined;
              const generation =
                (db
                  .query<{ generation: number }, [string]>(
                    "SELECT generation FROM runner_work WHERE run_id=?",
                  )
                  .get(selected.runId)?.generation ?? 0) + 1;
              const issuedAt = now();
              const deadline = issuedAt + (input.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS);
              const checkpointBot =
                !taskScope && input.role === "implementer"
                  ? await options.checkpointBot?.(
                      `${scoped.repository!.owner}/${scoped.repository!.repo}`,
                    )
                  : undefined;
              if (
                input.commitPolicy &&
                checkpointBot &&
                (input.commitPolicy.bot.appId !== checkpointBot.appId ||
                  input.commitPolicy.bot.id !== checkpointBot.id ||
                  input.commitPolicy.bot.login !== checkpointBot.login)
              )
                throw new Error("Run attribution App bot authority changed");
              if (options.placement) {
                const admitted = (await options.placement.candidates(placementRequest)).some(
                  (runner) =>
                    runner.id === selected.id && runner.workspaceId === selected.workspaceId,
                );
                if (!admitted)
                  throw placementRace(
                    itemId,
                    selected.id,
                    new PlacementRaceError(
                      "Selected runner is no longer available after preparation",
                    ),
                  );
              }
              signal.throwIfAborted();
              const boundRepository = taskScope?.repository ?? scoped.repository;
              // The command schema refuses a trailing slash, so a folder entry goes as its path.
              const checkoutExclusions = (
                input.checkoutExclusions
                  ? [...input.checkoutExclusions]
                  : boundRepository
                    ? checkoutExclusionsFor(
                        loadConfigFile(join(input.pawsRoot, "config.toml")).checkoutProjects,
                        `${boundRepository.owner}/${boundRepository.repo}`,
                      ).agent
                    : undefined
              )?.map((entry) => entry.replace(/\/$/, ""));
              const resumeSessionId =
                !excluded.includes(selected.id) &&
                (!pinnedRunnerId || pinnedRunnerId === selected.id) &&
                !taskScope &&
                input.role === "implementer" &&
                input.checkpoint !== false &&
                versionAtLeast(
                  db
                    .query<{ version: string | null }, [string]>(
                      "SELECT runner_version AS version FROM runner_host_status WHERE runner_id=?",
                    )
                    .get(selected.id)?.version,
                  SESSION_RESUME_RUNNER_VERSION,
                )
                  ? earlierSession(db, itemId, selected.id, profile.agent)
                  : restorePlan?.eligible
                    ? restorePlan.restoreSession.sessionId
                    : undefined;
              const runtimeList =
                input.runtimes && (!taskScope || taskScope.repository)
                  ? await input.runtimes().catch((error: unknown) => {
                      journalCaught(error, "runner-backend.forItem.runtimes", itemId);
                      return {
                        runtimes: [],
                        notices: [
                          `Paws could not read the repository's runtime list: ${error instanceof Error ? error.message : String(error)}.`,
                        ],
                      };
                    })
                  : undefined;
              signal.throwIfAborted();
              const acceptsRuntimes = versionAtLeast(
                db
                  .query<{ version: string | null }, [string]>(
                    "SELECT runner_version AS version FROM runner_host_status WHERE runner_id=?",
                  )
                  .get(selected.id)?.version,
                RUNTIMES_RUNNER_VERSION,
              );
              const runtimes =
                runtimeList?.runtimes.length && acceptsRuntimes ? runtimeList.runtimes : undefined;
              if (
                input.reviewCommand &&
                !versionAtLeast(
                  db
                    .query<{ version: string | null }, [string]>(
                      "SELECT runner_version AS version FROM runner_host_status WHERE runner_id=?",
                    )
                    .get(selected.id)?.version,
                  REVIEW_COMMAND_RUNNER_VERSION,
                )
              )
                throw new Error(
                  `Runner ${selected.id} needs runner ${REVIEW_COMMAND_RUNNER_VERSION.join(".")} or later to run the agent's review command. Upgrade the runner, then review again.`,
                );
              const runtimeNotices = [
                ...(runtimeList?.notices ?? []),
                ...(runtimeList?.runtimes.length && !acceptsRuntimes
                  ? [
                      `Paws did not send the repository's runtimes to this runner because it needs runner ${RUNTIMES_RUNNER_VERSION.join(".")} or later.`,
                    ]
                  : []),
              ];
              const assigned: WorkCommand = {
                id: commandId,
                runnerId: selected.id,
                workspaceId: selected.workspaceId,
                issuedAt,
                expiresAt: deadline,
                runId: selected.runId,
                itemId,
                generation,
                profile,
                prompt: promptContext
                  ? "Use the complete supplied conversation context."
                  : prepared.prompt,
                inputFiles,
                promptContext,
                ...(runtimes ? { runtimes } : {}),
                ...(taskScope
                  ? {
                      type: "task" as const,
                      sessionId: taskScope.sessionId,
                      sessionGeneration: taskScope.sessionGeneration,
                      taskModeGeneration: taskScope.taskModeGeneration,
                      purpose: taskScope.purpose,
                      ...(taskScope.repository
                        ? {
                            repository: {
                              ...taskScope.repository,
                              baseSha: baseSha!,
                              checkoutExclusions,
                            },
                          }
                        : {}),
                    }
                  : {
                      type: input.role === "reviewer" ? ("review" as const) : ("run" as const),
                      ...(input.role === "reviewer" && input.reviewCommand
                        ? { reviewCommand: { base: input.reviewCommand.base } }
                        : {}),
                      ...(skillsInputId !== undefined ? { skillsInputId } : {}),
                      ...(input.role === "reviewer" ? {} : runHooks(profile.agent)),
                      repository: {
                        ...scoped.repository!,
                        baseSha: baseSha!,
                        checkoutExclusions,
                        ...(mainSha ? { mainSha } : {}),
                      },
                      ...(acceptsMainCommit &&
                      input.role !== "reviewer" &&
                      input.checkpoint === false
                        ? { checkpoint: false as const }
                        : {}),
                      ...(resumeSessionId ? { resumeSessionId } : {}),
                      ...(restorePlan?.eligible
                        ? { restoreSession: restorePlan.restoreSession }
                        : {}),
                      ...(checkpointBot ? { checkpointBot } : {}),
                      ...(input.commitPolicy
                        ? {
                            commitPolicy: input.commitPolicy,
                            checkpointBot: input.commitPolicy.bot,
                          }
                        : {}),
                    }),
              };
              try {
                immediate(db, () => {
                  if (!runnerHasCapacity(db, selected.id, now(), selected.runId))
                    throw new RetryableRunnerError(
                      selected.id,
                      "Runner became busy before assignment",
                      undefined,
                      false,
                      undefined,
                      true,
                    );
                  work.assign(assigned);
                  options.placement?.started({
                    commandId: assigned.id,
                    runnerId: selected.id,
                    itemId,
                    runId: selected.runId,
                    profile,
                    role: input.role,
                    purpose: "work",
                    startedAt: issuedAt,
                  });
                });
              } catch (error) {
                if (error instanceof PlacementRaceError)
                  throw placementRace(itemId, selected.id, error);
                throw error;
              }
              for (const notice of runtimeNotices)
                await emit({ type: "progress", text: `${notice}\n` });
              const name = (id: string) =>
                db.query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?").get(id)
                  ?.name ?? id;
              // One start line names the runner, the repository and the runtimes it installs.
              const where = `${name(selected.id)}${
                boundRepository ? ` in ${boundRepository.owner}/${boundRepository.repo}` : ""
              }${runtimes ? `, ${runtimes.map((runtime) => `${runtime.tool} ${runtime.version}`).join(", ")}` : ""}`;
              // One notice per move. A restore waits for the runner to say whether it loaded.
              const restoreNotice =
                restorePlan && pinnedRunnerId
                  ? {
                      from: pinnedRunnerId,
                      to: selected.id,
                      ...(pinnedRunnerId === move.from
                        ? {}
                        : { gone: runnerGoneReason(db, pinnedRunnerId, now() - RUNNER_ONLINE_MS) }),
                      agent: profile.agent,
                    }
                  : undefined;
              if (restoreNotice) {
                // An eligible restore waits for the runner's session_restore event.
                if (restorePlan && !restorePlan.eligible)
                  await emit({
                    type: "progress",
                    text: sessionMoveNotice({
                      db,
                      ...restoreNotice,
                      outcome: { restored: false, failure: restorePlan.failure },
                    }),
                  });
              } else if (pinnedRunnerId && pinnedRunnerId !== selected.id)
                await emit({
                  type: "progress",
                  text: `Starting a new session on ${where}; ${name(pinnedRunnerId)} is unavailable.\n`,
                });
              else if (session && (!pinnedRunnerId || session.runnerId === pinnedRunnerId))
                await emit({
                  type: "progress",
                  text: resumeSessionId
                    ? `Continuing the agent's session on ${where}.\n`
                    : selected.id === session.runnerId
                      ? `Starting a new session on ${where}; this runner version can't resume the earlier session.\n`
                      : `Starting a new session on ${where}; ${name(session.runnerId)} is ${sessionBusy ? "busy" : "unavailable"}.\n`,
                });
              else if (input.role === "implementer")
                await emit({ type: "progress", text: `Starting on ${where}.\n` });
              return {
                assigned,
                baseSha,
                mainSha,
                deadline,
                restore:
                  restoreNotice && restorePlan?.eligible
                    ? { notice: restoreNotice, plan: restorePlan }
                    : undefined,
              };
            })());
          const { assigned, baseSha, mainSha, deadline } = placed;
          let restore = "restore" in placed ? placed.restore : undefined;
          const scoped = taskScope ?? work.scope(selected.runId, selected.workspaceId);
          command = assigned;
          let cursor = attached?.cursor ?? 0;
          let complete: RunnerResult | null = null;
          let disposition: ReturnType<RunnerPlacement["finished"]> | undefined;
          let heardAt = now();
          const liveness = () =>
            db
              .query<{ confirmedAt: number | null; lostAt: number | null }, [string, number]>(
                "SELECT confirmed_at AS confirmedAt,lost_at AS lostAt FROM runner_work WHERE run_id=? AND generation=?",
              )
              .get(assigned.runId, assigned.generation);
          const lostRun = async (how: string, thought = RUN_LOST_THOUGHT) => {
            journal(
              `item ${itemId} run ${assigned.runId} generation ${assigned.generation} lost on runner ${selected.id}: ${how}`,
            );
            if (!toldLost.has(itemId)) {
              toldLost.add(itemId);
              await emit({ type: "progress", text: `${thought}\n` });
            }
            return new RetryableRunnerError(
              selected.id,
              RUN_LOST_MESSAGE,
              transcript,
              publishedEffects,
              undefined,
              true,
            );
          };
          while (now() < deadline) {
            signal.throwIfAborted();
            try {
              work.current(assigned.runId, assigned.generation);
            } catch (error) {
              if (!(error instanceof RunnerWorkFencedError) || !options.placement) throw error;
              signal.throwIfAborted();
              // The runner's heartbeat no longer names this work, so it is gone, not just quiet.
              if (liveness()?.lostAt != null) {
                const recovered = immediate(db, () =>
                  options.placement?.finished({
                    commandId: assigned.id,
                    runnerId: selected.id,
                    profile,
                    failure: "heartbeat_lost",
                    finishedAt: now(),
                  }),
                );
                if (!recovered?.retryable) throw error;
                throw await lostRun("the runner no longer reports the command");
              }
              const interrupted = immediate(db, () =>
                options.placement?.finished({
                  commandId: assigned.id,
                  runnerId: selected.id,
                  profile,
                  failure: "heartbeat_lost",
                  finishedAt: now(),
                }),
              );
              if (!interrupted?.retryable) throw error;
              throw new RetryableRunnerError(
                selected.id,
                "The runner restarted or lost its lease during the run.",
                transcript,
                publishedEffects,
                undefined,
                true,
              );
            }
            if (questionError) throw questionError;
            complete = results.read(assigned.runId, assigned.generation, assigned.id);
            if (complete && !disposition)
              disposition = immediate(db, () =>
                options.placement?.finished({
                  commandId: assigned.id,
                  runnerId: selected.id,
                  profile,
                  result: complete!,
                  finishedAt: now(),
                }),
              );
            if (complete && disposition?.retryable && input.role === "reviewer")
              throw new RetryableRunnerError(
                selected.id,
                disposition.usageLimit
                  ? "The reviewer agent reached its usage limit."
                  : "The reviewer runner requires a fresh eligible agent.",
                transcript,
                publishedEffects,
                disposition.usageLimit,
              );
            const pendingEvents = results.events(assigned.runId, assigned.generation, cursor);
            for (const row of pendingEvents) {
              const event = row.event;
              const origin = {
                runId: assigned.runId,
                generation: assigned.generation,
                sequence: row.sequence,
              };
              if (event.type === "activity") {
                if (event.update.sessionUpdate === "agent_message_chunk" && taskScope)
                  await emit(
                    {
                      type: "progress",
                      text: event.update.content.text,
                      messageChunk: true,
                    },
                    origin,
                  );
                else if (event.update.sessionUpdate === "agent_message_chunk")
                  await emit(
                    {
                      type: "session_update",
                      sessionId: assigned.id,
                      update: {
                        ...event.update,
                        sessionUpdate:
                          input.role === "reviewer" ? "agent_thought_chunk" : "agent_message_chunk",
                      },
                    },
                    origin,
                  );
                else
                  await emit(
                    {
                      type: "session_update",
                      sessionId: assigned.id,
                      update: event.update,
                    },
                    origin,
                  );
              }
              if (event.type === "permission")
                await emit({ type: "permission", ...event.permission }, origin);
              if (event.type === "session_restore" && restore) {
                const { notice, plan } = restore;
                restore = undefined;
                await emit(
                  {
                    type: "progress",
                    text: sessionMoveNotice({
                      db,
                      ...notice,
                      outcome: event.restored
                        ? { restored: true, turn: plan.turn }
                        : {
                            restored: false,
                            failure: event.reason ?? "load",
                            versions: {
                              saved: plan.restoreSession.agentVersion,
                              savedOn: plan.sourceRunnerId,
                              target: plan.targetVersion,
                            },
                          },
                    }),
                  },
                  origin,
                );
              }
              if (event.type === "hook_failed") await emit(event, origin);
              if (event.type === "checkpoint" && assigned.type === "run")
                recordRunnerCheckpoint(db, {
                  itemId,
                  runId: assigned.runId,
                  baseSha: baseSha!,
                  event,
                  now: now(),
                });
              if (event.type === "handover" && !event.handedOver) {
                const runner =
                  db
                    .query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?")
                    .get(selected.id)?.name ?? selected.id;
                await emit(
                  {
                    type: "progress",
                    text:
                      event.reason === "timeout"
                        ? `${runner} found no safe point to hand this session over within 2 minutes, so it keeps running there.\n`
                        : `${runner} stopped this session for a move but couldn't ${HANDOVER_FAILURE_STEP[event.reason ?? "publication"]}, so it stays there and goes on with its next turn.\n`,
                  },
                  origin,
                );
              }
              // Runners from before the start line named the runtimes still report the install.
              if (
                event.type === "progress" &&
                !(event.notice && /^Installed runtimes /.test(event.text))
              ) {
                if (input.postUpdate && !event.notice)
                  await input.postUpdate.post(event.text, origin).catch((caughtError3) => {
                    journalCaught(caughtError3, "runner-backend.forItem.post", itemId);
                    return undefined;
                  });
                else await emit({ type: "progress", text: event.text }, origin);
              }
              // A replay after a restart keeps the stored answer instead of publishing again.
              const answered =
                (event.type === "artifact" || event.type === "closeout_policy") &&
                results.answered(assigned.runId, assigned.generation, row.sequence) !== null;
              if (answered && event.type === "artifact" && event.dropped === undefined)
                publishedEffects = true;
              if (event.type === "closeout_policy" && !answered) {
                const policy = input.closeoutPolicy
                  ? await input.closeoutPolicy().catch((error: unknown) => {
                      journalCaught(error, "runner-backend.forItem.closeoutPolicy", itemId);
                      return {
                        ok: false as const,
                        message: error instanceof Error ? error.message : String(error),
                      };
                    })
                  : {
                      ok: false as const,
                      message: "Paws has no trusted Closeout policy for this run",
                    };
                signal.throwIfAborted();
                results.answer({
                  runId: assigned.runId,
                  generation: assigned.generation,
                  sequence: row.sequence,
                  answer: encodePolicyFiles(policy),
                });
              }
              if (event.type === "artifact" && !answered && event.dropped !== undefined) {
                journal(
                  `item ${itemId} runner dropped artifact ${JSON.stringify(event.artifact.path)}: ${event.dropped}`,
                );
                signal.throwIfAborted();
                results.answer({
                  runId: assigned.runId,
                  generation: assigned.generation,
                  sequence: row.sequence,
                  answer: JSON.stringify({
                    error: `${event.artifact.path} was not published: ${event.dropped}.`,
                  }),
                });
              } else if (event.type === "artifact" && !answered) {
                if (!input.publishArtifact || !options.artifacts)
                  throw new Error("Remote artifact publication is unavailable");
                const snapshot = options.artifacts.snapshot(
                  assigned.runId,
                  assigned.generation,
                  event.artifact,
                );
                const evidence = event.artifact.evidence;
                const publication = await input.publishArtifact
                  .publish(snapshot, {
                    request: {
                      path: snapshot.path,
                      displayName: snapshot.displayName,
                      mimeType: snapshot.mimeType,
                      attachToIssue: event.artifact.attachToIssue,
                      ...(evidence ? { checkId: evidence.checkId } : {}),
                    },
                    itemId: input.itemId,
                    runId: selected.runId,
                    worktreePath: input.worktreePath,
                    role: input.role,
                    signal,
                    ...(evidence ? { evidence } : {}),
                  })
                  .catch((error: unknown) => {
                    if (error instanceof ArtifactRejectedError) {
                      journalCaught(error, "runner-backend.forItem.publish", itemId);
                      return { error: error.message };
                    }
                    throw error;
                  });
                publishedEffects = true;
                // Store the outcome before a shutdown stops the read, so a replay does not publish again.
                results.answer({
                  runId: assigned.runId,
                  generation: assigned.generation,
                  sequence: row.sequence,
                  answer: JSON.stringify(publication),
                });
                signal.throwIfAborted();
              }
              if (event.type === "pull_request")
                await input.pullRequest?.update({ title: event.title, body: event.body });
              if (event.type === "closeout") await input.closeoutProgress?.record(event.progress);
              if (event.type === "plan")
                await emit(
                  {
                    type: "session_update",
                    sessionId: assigned.id,
                    update: {
                      sessionUpdate: "plan",
                      entries: event.steps.map((step) => ({
                        content: step.content,
                        priority: "medium" as const,
                        status: (step.status === "inProgress" ? "in_progress" : step.status) as
                          | "pending"
                          | "in_progress"
                          | "completed",
                      })),
                    },
                  },
                  origin,
                );
              if (event.type === "question") {
                if (question) throw new Error("Remote runner sent overlapping questions");
                if (!input.askTeam) throw new Error("Remote question channel is unavailable");
                publishedEffects = true;
                asked = true;
                await emit({ type: "ask_team", question: event.text, phase: "asked" });
                const currentCommand = assigned;
                question = (async () => {
                  const answer = await input.askTeam!.ask(
                    { question: event.text, options: event.options, context: event.context },
                    { itemId: input.itemId, runId: selected.runId, role: input.role, signal },
                  );
                  signal.throwIfAborted();
                  results.answer({
                    runId: currentCommand.runId,
                    generation: currentCommand.generation,
                    sequence: row.sequence,
                    answer: answer.answer,
                  });
                  await emit({
                    type: "ask_team",
                    question: event.text,
                    phase: "answered",
                    answer: answer.answer,
                  });
                })()
                  .catch((error) => {
                    journalCaught(error, "runner-backend.forItem.ask", itemId);
                    questionError = error;
                  })
                  .finally(() => {
                    question = undefined;
                  });
              }
              cursor = row.sequence;
              db.run("UPDATE runner_work SET consumed_sequence=? WHERE run_id=? AND generation=?", [
                cursor,
                assigned.runId,
                assigned.generation,
              ]);
            }
            if (pendingEvents.length) heardAt = now();
            if (complete && pendingEvents.length < 64) break;
            if (pendingEvents.length === 64) continue;
            if (!complete && results.read(assigned.runId, assigned.generation, assigned.id))
              continue;
            // A long silence is checked against the runner. A question waits on a person, so its
            // wait is not silence. A runner that still names the command in its heartbeat keeps a
            // quiet tool call until the hung bound, where the agent is stopped all the same.
            if (question) heardAt = now();
            if (options.placement && now() - heardAt >= silentRunMs) {
              const confirmedAt = liveness()?.confirmedAt ?? null;
              const unconfirmed =
                confirmedAt === null || confirmedAt <= now() - RUN_CONFIRMATION_MS;
              if (unconfirmed || now() - heardAt >= hungRunMs) {
                const at = now();
                const minutes = Math.round((at - heardAt) / 60_000);
                const recovered = immediate(db, () => {
                  db.run(
                    "UPDATE runner_work SET ended_at=?,lost_at=? WHERE run_id=? AND generation=? AND ended_at IS NULL",
                    [at, at, assigned.runId, assigned.generation],
                  );
                  db.run("DELETE FROM runner_work_grant WHERE run_id=?", [assigned.runId]);
                  return options.placement?.finished({
                    commandId: assigned.id,
                    runnerId: selected.id,
                    profile,
                    failure: "heartbeat_lost",
                    finishedAt: at,
                  });
                });
                if (!recovered?.retryable) throw new Error(RUN_LOST_MESSAGE);
                throw await lostRun(
                  unconfirmed
                    ? `no runner event for ${minutes} minutes and the runner does not confirm the command`
                    : `no runner event for ${minutes} minutes although the runner confirms the command, so the agent is hung`,
                  unconfirmed ? RUN_LOST_THOUGHT : RUN_HUNG_THOUGHT(minutes),
                );
              }
            }
            if (
              options.placement &&
              (db
                .query<{ lastSeen: number | null }, [string]>(
                  "SELECT last_seen_at AS lastSeen FROM runner WHERE id=?",
                )
                .get(selected.id)?.lastSeen ?? 0) <=
                now() - 60_000 - RUNNER_LEASE_GRACE_MS
            ) {
              const lost = immediate(db, () =>
                options.placement?.finished({
                  commandId: assigned.id,
                  runnerId: selected.id,
                  profile,
                  failure: "heartbeat_lost",
                  finishedAt: now(),
                }),
              );
              if (!lost?.retryable) throw new Error("The runner stopped sending heartbeats.");
              throw new RetryableRunnerError(
                selected.id,
                "The runner stopped sending heartbeats.",
                transcript,
                publishedEffects,
              );
            }
            await delay(interval, undefined, { signal });
          }
          if (!complete) throw new Error("Remote run timed out");
          // A handover can stop the agent while Paws still posts its question, whether the
          // handover then succeeds or fails after the interrupt; the question stays either way.
          if (question && (complete.handedOver || complete.handoverFailure)) await question;
          if (questionError) throw questionError;
          if (question) throw new Error("Remote run completed with an unanswered question");
          if (assigned.type === "task" && (complete.candidateSha || complete.reviewText))
            throw new Error("Remote response task returned code work");
          if (options.transcripts) {
            work.current(assigned.runId, assigned.generation);
            const bytes = await options.transcripts.download(
              assigned.runId,
              assigned.generation,
              complete.executionId,
            );
            signal.throwIfAborted();
            work.current(assigned.runId, assigned.generation);
            if (bytes.length > 16_777_216 || (bytes.length && bytes[bytes.length - 1] !== 10))
              throw new Error("Remote transcript is incomplete");
            const pending = `${transcript}.${randomUUID()}.pending`;
            try {
              writeFileSync(pending, Buffer.concat([previousTranscript, bytes]), {
                flag: "wx",
                mode: 0o600,
              });
              renameSync(pending, transcript);
            } finally {
              rmSync(pending, { force: true });
            }
          }
          if (complete.pushFailure && assigned.type === "run" && input.askTeam)
            await input.askTeam.ask(
              {
                question: `Paws could not push the candidate to \`${complete.pushFailure.branch}\` on GitHub:\n\n\`\`\`\n${complete.pushFailure.error}\n\`\`\`\n\nFix the cause if it needs one, then reply to run the task again.`,
                pushRejected: { branch: complete.pushFailure.branch },
              },
              { itemId: input.itemId, runId: selected.runId, role: input.role, signal },
            );
          if (
            disposition?.retryable &&
            complete.agentExited &&
            !complete.cancelled &&
            !complete.timedOut &&
            !complete.candidateSha
          )
            throw new RetryableRunnerError(
              selected.id,
              complete.authRequired
                ? "The runner agent requires sign-in."
                : "The runner agent exhausted its observed quota.",
              transcript,
              publishedEffects,
              disposition.usageLimit,
            );
          if (complete.reviewText)
            await emit({
              type: "session_update",
              sessionId: complete.sessionId ?? assigned.id,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: complete.reviewText },
              },
            });
          if (
            assigned.type === "run" &&
            complete.stopReason === "end_turn" &&
            !complete.cancelled &&
            !complete.timedOut &&
            !complete.authRequired &&
            complete.agentExited &&
            !complete.errorMessage &&
            !complete.candidateSha
          )
            throw new Error("Remote implementation has no candidate commit");
          if (complete.candidateSha) {
            if (assigned.type !== "run" || !input.networkGit)
              throw new Error("Runner candidate requires an authorized implementation import.");
            await options.fetchCandidate({
              itemId,
              worktree: input.worktreePath,
              baseSha: baseSha!,
              ...(mainSha ? { mainSha } : {}),
              candidateSha: complete.candidateSha,
              branch: scoped.item.branchName,
              remoteUrl: assigned.repository.remoteUrl,
              networkGit: input.networkGit,
              signal,
            });
            signal.throwIfAborted();
            work.current(assigned.runId, assigned.generation);
            if (
              (await git(["-C", input.worktreePath, "rev-parse", "HEAD"])).trim() !==
              complete.candidateSha
            )
              throw new Error("Fetched runner candidate HEAD does not match");
            await assertDescendsFromAny(
              (args) => git(["-C", input.worktreePath, ...args]),
              mainSha ? [baseSha!, mainSha] : [baseSha!],
              complete.candidateSha,
            );
            if (complete.stopReason !== "end_turn" || complete.errorMessage)
              saveCheckpoint(db, itemId, {
                phase: "running",
                baseSha: getWorkItem(db, itemId)?.checkpoint?.baseSha ?? baseSha!,
                wipCommit: complete.candidateSha,
              });
            // The checkpoint keeps the work so far; the task waits for the reset.
            if (
              disposition?.usageLimit &&
              complete.stopReason !== "end_turn" &&
              !complete.cancelled &&
              !complete.timedOut
            )
              throw new RetryableRunnerError(
                selected.id,
                "The runner agent reached its usage limit.",
                transcript,
                publishedEffects,
                disposition.usageLimit,
              );
          }
          // The runner stopped the session at a safe point and Paws holds its WIP commit: another
          // runner continues it there with its session. A run still waiting on its question keeps
          // it; one whose question was answered moves like any other.
          if (
            complete.handedOver &&
            assigned.type === "run" &&
            !(asked && waitsOnQuestion(db, selected.runId))
          ) {
            work.finish(assigned.runId, assigned.generation);
            command = undefined;
            move.from = selected.id;
            move.repository = `${assigned.repository.owner}/${assigned.repository.repo}`;
            move.waiting = false;
            throw new RetryableRunnerError(
              selected.id,
              "Paws moved this session to another runner. Your work so far is committed; continue where you left off.",
              transcript,
              false,
              undefined,
              false,
              true,
            );
          }
          if (complete.handedOver && assigned.type === "run")
            noteRunnerSessionMove(db, {
              runId: assigned.runId,
              runnerId: selected.id,
              status: "stayed",
              reason: "The session waits on its question, so it stays here until the team answers.",
              now: now(),
            });
          if (assigned.type === "task") {
            const history = await recoverAcpConversation(transcript, previousTranscript.length);
            signal.throwIfAborted();
            work.current(assigned.runId, assigned.generation);
            const text = history
              .filter((entry) => entry.kind === "response")
              .map((entry) => entry.body)
              .join("\n\n");
            if (text)
              await input.onEvent?.({
                type: "session_update",
                sessionId: complete.sessionId ?? assigned.id,
                update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
              });
            signal.throwIfAborted();
            work.current(assigned.runId, assigned.generation);
          }
          work.finish(assigned.runId, assigned.generation);
          command = undefined;
          await emit({ type: "prompt_complete", stopReason: complete.stopReason });
          return { ...complete, transcriptPath: transcript };
        } catch (error) {
          if (!(error instanceof Error) || error.message !== "cancelled" || !signal.aborted) {
            throw error;
          }
          journalCaught(
            error,
            "runner-backend.forItem.scopeTask",
            itemId,
            "cancellation may interrupt work",
          );
          return {
            role: input.role,
            stopReason: "cancelled",
            timedOut: false,
            cancelled: true,
            authRequired: false,
            agentExited: true,
            transcriptPath: transcript,
          };
        } finally {
          // A Paws restart leaves implementer work and response tasks running on the runner, and
          // a verifying item's Closeout review or check run; the startup resume or re-verify
          // reattaches to them.
          const state = getWorkItem(db, itemId)?.state;
          const detached =
            signal.reason instanceof PawsShutdown &&
            command !== undefined &&
            (closeoutWork
              ? state === "verifying"
              : ((command.type === "run" && command.checkpoint !== false) ||
                  command.type === "task") &&
                state === "running");
          // A stop Paws asked for keeps the turn's work: the runner publishes it as a WIP commit
          // first, and the next turn starts from it.
          const saving =
            command?.type === "run" &&
            command.checkpoint !== false &&
            !detached &&
            signal.aborted &&
            !(signal.reason instanceof PawsShutdown)
              ? checkpointBeforeStop(command.runId)
              : null;
          if (saving) await saving;
          if (command && !detached) {
            try {
              const issuedAt = now();
              work.enqueue({
                id: randomUUID(),
                runnerId: selected.id,
                workspaceId: selected.workspaceId,
                issuedAt,
                expiresAt: issuedAt + 60_000,
                type: "cancel",
                runId: command.runId,
                generation: command.generation,
              });
            } catch (caughtError4) {
              journalCaught(caughtError4, "runner-backend.forItem.now", itemId);
            }
          }
          controller.abort();
          await question;
          input.signal?.removeEventListener("abort", abort);
          reservations.delete(selected.runId);
        }
      };
      return (input: RunAgentOptions) => {
        const move: HandoverMove = {};
        const moving: FailoverAttempt = (next, excluded, limit) =>
          attempt(next, excluded, limit, move);
        return runWithFailover(
          input,
          moving,
          async () => cancelItem(itemId, input.signal),
          usageLimitWait(itemId, input),
        );
      };
    },
  };
}

export { createRemoteSessionAgentRunner } from "./helpers";

export { fastForwardToBranchTip, fetchRunnerCandidate } from "./candidate";

export { remoteCommandsGone } from "./released";

export { createRemoteCheckpoint } from "./checkpoint";

export { createRemoteHandover, type RunnerHandoverOutcome } from "./handover";

const HANDOVER_FAILURE_STEP = {
  commit: "commit its work in progress",
  snapshot: "save its Claude session",
  publication: "publish its work in progress and session",
} as const;

/** A run's handover within one failover call: the runner it left, and whether Linear heard why it waits. */
type HandoverMove = { from?: string; repository?: string; waiting?: boolean };

/**
 * Whether the run still waits on a question it asked. A question asked outside the question
 * store, as in a fake, counts as waiting; a stored one counts until it is answered or cancelled.
 */
function waitsOnQuestion(db: Database, runId: string): boolean {
  const row = db
    .query<{ stored: number; open: number }, [string]>(
      `SELECT COUNT(*) AS stored, COALESCE(SUM(status IN ('open','queued') AND cancelled_at IS NULL),0)
       AS open FROM question WHERE run_id=?`,
    )
    .get(runId);
  return !row || row.stored === 0 || row.open > 0;
}

/**
 * The runner the item's last implementer turn handed its session over from, read from that
 * turn's stored result so a restart keeps the move. Null once a later turn ran anywhere.
 */
function handedOverFrom(db: Database, itemId: string): HandoverMove | null {
  const row = db
    .query<{ runnerId: string; envelope: string; payload: string }, [string]>(
      `SELECT c.runner_id AS runnerId, c.envelope, rr.payload FROM runner_result rr
       JOIN runner_command c ON c.id=rr.command_id
       JOIN run ON run.id=rr.run_id
       WHERE run.item_id=? AND c.kind='run'
       ORDER BY rr.received_at DESC, rr.generation DESC LIMIT 1`,
    )
    .get(itemId);
  if (!row || (JSON.parse(row.payload) as { handedOver?: boolean }).handedOver !== true)
    return null;
  const command = JSON.parse(
    Buffer.from((JSON.parse(row.envelope) as { payload: string }).payload, "base64url").toString(
      "utf8",
    ),
  ) as { repository?: { owner?: string; repo?: string } };
  const repository = command.repository;
  return {
    from: row.runnerId,
    ...(repository?.owner && repository.repo
      ? { repository: `${repository.owner}/${repository.repo}` }
      : {}),
  };
}

/** Why no runner can take a handed-over run yet. */
function handoverWaitReason(
  move: HandoverMove,
  rejected: readonly string[],
  error: unknown,
  agent: string | undefined,
): string {
  const reasons = rejected.flatMap((entry) => {
    const separator = entry.indexOf(":");
    return separator < 0 || entry.slice(0, separator) === move.from
      ? []
      : [entry.slice(separator + 1).trim()];
  });
  const message = error instanceof Error ? error.message : "";
  return /repository is outside workspace access/.test(message) && move.repository
    ? `No other runner allows ${move.repository}.`
    : reasons.some((reason) => reason === NO_FREE_CAPACITY.slice(2))
      ? "Every other runner is busy."
      : reasons.some((reason) => reason === "agent-not-signed-in" || reason === "auth-expired")
        ? `Sign in to ${agent ? agentName(agent) : "the agent"} on another runner.`
        : reasons.length === 0 || reasons.every((reason) => /^(offline|paused)$/.test(reason))
          ? "No other runner is online."
          : "No other runner can take this work.";
}

/** The wait reason as Linear hears it, posted once while the run waits. */
function handoverWaitNotice(db: Database, move: HandoverMove, why: string): string {
  const from = move.from
    ? (db.query<{ name: string }, [string]>("SELECT name FROM runner WHERE id=?").get(move.from)
        ?.name ?? move.from)
    : "its runner";
  return `Waiting to move this session from ${from}: ${why} Paws moves it as soon as a runner fits.\n`;
}

function agentName(agent: string): string {
  return agent.charAt(0).toUpperCase() + agent.slice(1);
}

function clockTime(at: number, now: number): string {
  const time = new Date(at).toISOString();
  const day =
    time.slice(0, 10) === new Date(now).toISOString().slice(0, 10) ? "" : `${time.slice(0, 10)} `;
  return `${day}${time.slice(11, 16)} UTC`;
}

export { UsageLimitExhaustedError } from "./failover";
