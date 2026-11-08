import {
  acknowledgeRunnerCommand,
  assignRunnerWork,
  availableRunnerIdentity,
  confirmRunnerWork,
  confirmRunnerWorkTeardown,
  deleteRunnerWorkGrants,
  deliverableRunnerCommands,
  endRunnerWork,
  extendRunnerWorkLease,
  finishRunnerWork,
  getRun,
  insertRunnerCommand,
  insertRunnerEvent,
  insertRunnerWorkGrant,
  linearSessionClientId,
  loseRunnerWork,
  noteRunnerLiveReport,
  noteRunnerSeen,
  noteRunnerTerminations,
  openRunnerAssignments,
  runnerCheckpointPending,
  runnerCommandAcknowledgedBy,
  runnerCommandEnvelope,
  runnerHostVersion,
  runnerResultRecorded,
  runnerWorkAssignment,
  runnerWorkGrantValid,
  runnerWorkStillReported,
  setRunnerWorkLastSequence,
  storedRunnerEvent,
  type RunnerAssignment as Assignment,
  workspaceInLinearOrganization,
  workspaceSessionRepositoryAllowed,
  listSkills,
  recordCommandAccount,
  recordRunnerAccountCapability,
  recordRunAgentSetup,
  recordRunnerCapacity,
  recordRunnerAgents,
  recordRunnerRepositories,
  recordRunnerRuntimes,
  recordRunnerSkills,
  runnerAgentTargets,
  lastInstanceHeartbeat,
  runnerLeaseCutoff,
  getLinearSessionAccess,
  getLinearSession,
  getTaskMode,
  getTaskModeGeneration,
  getWorkItem,
  getWorkItemRepository,
  immediate,
  recordRunnerHostStatus,
  runnerHasCapacity,
  runnerLeaseLive,
  type RunnerHostSample,
  taskRequiresRepository,
  workspaceSessionIds,
  runnerCancelPending,
  runTeardownOwner,
  nextRoutineHealthCommand,
} from "../db";
import { journalCaught } from "../journal";
import type { KeyObject } from "node:crypto";
import type { Database } from "bun:sqlite";
import {
  executionAuthorityUntil,
  LIVE_PREVIEW_RUNNER_VERSION,
  OFFLINE_LEASE_RUNNER_VERSION,
  RUNNER_LEASE_GRACE_MS,
  RUNNER_LEASE_MS,
  RUNNER_OFFLINE_BUDGET_MS,
  OPENCODE_RUNNER_VERSION,
  RunnerCommandSchema,
  runnerReleaseAtLeast,
  RunnerEventSchema,
  type RunnerEvent,
  signRunnerCommand,
  type RunnerCommand,
  RunnerAgentTargetSchema,
  type RunnerAgentTarget,
  type RunnerAccountCapability,
  type RunnerInstalledAgent,
  type RunnerInstalledRuntime,
  type RunnerInstalledSkill,
  type RunnerSkill,
  type SignedRunnerCommand,
  withoutJournalTime,
} from "../runner-protocol";
import { workspaceSecret, workspaceTokenHash } from "../workspace";
import { findOpenQuestion } from "../questions";
import {
  deliverRepositoryCommands,
  repositoryCommandDeliveredTo,
} from "../runner-repository-commands";
import { openRunnerEvent, payloadSha256, sealRunnerEvent, type StoredRunnerEvent } from "./events";

export { RunnerEventSchema, type RunnerEvent } from "../runner-protocol";
type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" | "task" }>;

/**
 * Work the runner acknowledged this long ago and no longer reports is lost. The margin covers a
 * heartbeat sampled just before the runner acknowledged the command.
 */
export const RUNNER_LIVE_GRACE_MS = 30_000;

export class RunnerTeardownPending extends Error {
  override readonly name = "RunnerTeardownPending";
  constructor(readonly runnerIds: readonly string[]) {
    super(`Runner cancellation cleanup on ${runnerIds.join(", ")} is not confirmed yet`);
  }
}

export class RunnerWorkFencedError extends Error {
  override readonly name = "RunnerWorkFencedError";
}

export function createRunnerWork(options: {
  db: Database;
  keyId: string;
  privateKey: KeyObject;
  eventKey: Buffer;
  now?: () => number;
}) {
  const { db } = options;
  const { eventKey } = options;
  const now = options.now ?? Date.now;
  function assignment(runId: string) {
    return runnerWorkAssignment(db, runId);
  }
  function availableIdentity(id: string) {
    return availableRunnerIdentity(db, id);
  }
  /** Registered skills a runner should have installed. Removed ones are left out, so runners delete them. */
  function skillManifest(): RunnerSkill[] {
    return listSkills(db)
      .filter((skill) => skill.removedAt === null)
      .map(({ name, version, sha256, sizeBytes, agents }) => ({
        name,
        version,
        sha256,
        sizeBytes,
        agents,
      }));
  }
  function runner(id: string) {
    const row = availableIdentity(id);
    if (!row) throw new Error("Runner identity is unavailable.");
    return row;
  }
  function activeTask(runId: string, allowPendingQuestion = false) {
    const execution = getRun(db, runId);
    const item = execution ? getWorkItem(db, execution.itemId) : null;
    // A run Paws stops for a cap or a restart publishes its WIP commit first: until that
    // checkpoint request expires, its runner may still send the commit and push it.
    const checkpointing = item?.currentRunId === runId && runnerCheckpointPending(db, runId, now());
    if (
      !item ||
      item.currentRunId !== runId ||
      (!checkpointing &&
        (!["provisioning", "active"].includes(execution!.status) ||
          item.cancelRequested ||
          !["running", "verifying", "awaiting_input"].includes(item.state)))
    )
      throw new Error("Run is no longer active.");
    const sessionId = item.sessionKey;
    if (!sessionId || getLinearSessionAccess(db, sessionId) !== "allowed")
      throw new Error("Linear task access is unavailable.");
    if (item.state === "awaiting_input" && !allowPendingQuestion && !checkpointing) {
      const question = findOpenQuestion(db, sessionId);
      if (question?.itemId !== item.id || question.runId !== runId)
        throw new Error("Run has no matching open question.");
    }
    return { item, sessionId };
  }
  function task(runId: string, workspaceId: string, allowPendingQuestion = false) {
    const { item, sessionId } = activeTask(runId, allowPendingQuestion);
    const repository = getWorkItemRepository(db, item.id);
    if (!repository) throw new Error("Run repository is not bound.");
    if (
      !workspaceSessionRepositoryAllowed(
        db,
        workspaceId,
        sessionId,
        `${repository.owner}/${repository.repo}`,
      )
    )
      throw new Error("Run is outside the runner workspace repository access.");
    return { item, repository };
  }
  function responseTask(
    runId: string,
    workspaceId: string,
    allowPendingQuestion = false,
    userId?: string,
  ) {
    const { item, sessionId } = activeTask(runId, allowPendingQuestion);
    const session = getLinearSession(db, sessionId);
    const purpose = getTaskMode(db, item.id);
    const clientId = linearSessionClientId(db, sessionId);
    if (
      !session ||
      session.stoppedAt !== null ||
      !clientId ||
      (purpose !== "answer" && purpose !== "artifact" && purpose !== "plan") ||
      !workspaceInLinearOrganization(db, workspaceId, session.organizationId) ||
      (userId !== undefined &&
        !workspaceSessionIds(db, workspaceId, userId, clientId).includes(sessionId))
    )
      throw new RunnerWorkFencedError("Linear response task authority changed");
    return {
      item,
      sessionId,
      sessionGeneration: session.generation,
      taskModeGeneration: getTaskModeGeneration(db, item.id),
      purpose,
      repository: taskRequiresRepository(db, item.id)
        ? task(runId, workspaceId, allowPendingQuestion).repository
        : undefined,
    };
  }
  function bindTask(
    command: Extract<WorkCommand, { type: "task" }>,
    current: ReturnType<typeof responseTask>,
  ) {
    if (
      command.itemId !== current.item.id ||
      command.sessionId !== current.sessionId ||
      command.sessionGeneration !== current.sessionGeneration ||
      command.taskModeGeneration !== current.taskModeGeneration ||
      command.purpose !== current.purpose ||
      (command.repository === undefined) !== (current.repository === undefined) ||
      (command.repository &&
        (!current.repository ||
          command.repository.owner !== current.repository.owner ||
          command.repository.repo !== current.repository.repo ||
          command.repository.remoteUrl !== current.repository.remoteUrl))
    )
      throw new RunnerWorkFencedError("Linear response task binding changed");
  }
  /** Whether the runner's latest heartbeat named this run among the work it still runs. */
  function stillReported(runnerId: string, runId: string) {
    return runnerWorkStillReported(db, runnerId, runId);
  }
  function live(
    runnerId: string,
    runId: string,
    generation: number,
    at: number,
    allowPendingQuestion = false,
    settled = false,
    reported?: boolean,
  ): Assignment {
    const identity = runner(runnerId);
    const work = assignment(runId);
    const lapsed = work !== null && work.leaseUntil <= at && !settled;
    // A lapsed lease keeps its grace while the runner still reports the run, however full the
    // runner is: a busy Paws answers the renewing heartbeat late. Capacity decides the rest.
    if (
      !work ||
      work.runnerId !== runnerId ||
      work.workspaceId !== identity.workspaceId ||
      work.generation !== generation ||
      work.runnerFence !== identity.fence ||
      work.endedAt !== null ||
      (lapsed &&
        (work.leaseUntil + RUNNER_LEASE_GRACE_MS <= at ||
          (!(reported ?? stillReported(runnerId, runId)) &&
            !runnerHasCapacity(db, runnerId, at, runId))))
    )
      throw new RunnerWorkFencedError("Runner work is fenced or its lease expired.");
    const command = workCommand(work);
    if (command.expiresAt <= at && !settled)
      throw new RunnerWorkFencedError("Runner command expired.");
    if (command.type === "task") {
      bindTask(
        command,
        responseTask(runId, work.workspaceId, allowPendingQuestion, identity.userId),
      );
      return work;
    }
    const current = task(runId, work.workspaceId, allowPendingQuestion);
    if (
      current.item.id !== command.itemId ||
      current.repository.owner !== command.repository.owner ||
      current.repository.repo !== command.repository.repo ||
      current.repository.remoteUrl !== command.repository.remoteUrl
    )
      throw new Error("Run repository binding changed.");
    return work;
  }
  function renew(
    work: Assignment,
    at: number,
    credit?: { offlineBudgetMs: number; aliveAt: number },
  ) {
    const expiresAt = workCommand(work).expiresAt;
    const leaseUntil = Math.min(expiresAt, at + RUNNER_LEASE_MS);
    const authorityUntil = credit
      ? executionAuthorityUntil({
          renewedAt: at,
          leaseUntil,
          expiresAt,
          aliveAt: credit.aliveAt,
          budgetMs: credit.offlineBudgetMs,
        })
      : leaseUntil + RUNNER_LEASE_GRACE_MS;
    extendRunnerWorkLease(
      db,
      work.runId,
      Math.max(leaseUntil, authorityUntil - RUNNER_LEASE_GRACE_MS),
    );
    return leaseUntil;
  }
  function accepted(work: Assignment) {
    return runnerResultRecorded(db, work);
  }
  function acknowledgedBy(work: Assignment, at: number) {
    return runnerCommandAcknowledgedBy(db, work.commandId, at);
  }
  function workCommand(work: Assignment): WorkCommand {
    const stored = runnerCommandEnvelope(db, work.commandId);
    if (stored === null) throw new Error("Run command is unavailable.");
    const envelope = JSON.parse(stored) as { payload: string };
    const command = RunnerCommandSchema.parse(
      JSON.parse(Buffer.from(envelope.payload, "base64url").toString("utf8")),
    );
    if (
      (command.type !== "run" && command.type !== "review" && command.type !== "task") ||
      command.runId !== work.runId ||
      command.runnerId !== work.runnerId ||
      command.workspaceId !== work.workspaceId ||
      command.generation !== work.generation
    )
      throw new Error("Run command binding changed.");
    return command;
  }
  function authorized(
    input: {
      runnerId: string;
      runId: string;
      generation: number;
      token: string;
    },
    allowPendingQuestion = false,
  ): Assignment {
    const at = now();
    const work = live(input.runnerId, input.runId, input.generation, at, allowPendingQuestion);
    if (
      !runnerWorkGrantValid(
        db,
        {
          tokenHash: workspaceTokenHash(input.token),
          runId: input.runId,
          generation: input.generation,
        },
        at,
      )
    )
      throw new Error("Run grant is invalid or expired.");
    return work;
  }
  function supportsAgent(runnerId: string, agent: string) {
    if (agent !== "opencode") return true;
    const version = runnerHostVersion(db, runnerId);
    const parts = version
      ?.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/)
      ?.slice(1)
      .map(Number);
    if (!parts) return false;
    for (const [index, part] of parts.entries())
      if (part !== OPENCODE_RUNNER_VERSION[index]) return part > OPENCODE_RUNNER_VERSION[index]!;
    return true;
  }
  function queue(command: RunnerCommand) {
    const agent =
      "profile" in command ? command.profile.agent : "agent" in command ? command.agent : null;
    if (agent && !supportsAgent(command.runnerId, agent))
      throw new Error(
        `OpenCode needs runner ${OPENCODE_RUNNER_VERSION.join(".")} or later. Upgrade the runner, then try again.`,
      );
    const envelope = signRunnerCommand({
      keyId: options.keyId,
      privateKey: options.privateKey,
      command,
    });
    recordCommandAccount(db, command, now());
    insertRunnerCommand(db, {
      id: command.id,
      runnerId: command.runnerId,
      runId: "runId" in command ? command.runId : null,
      generation: "generation" in command ? command.generation : null,
      kind: command.type,
      envelope,
      expiresAt: command.expiresAt,
    });
    return envelope;
  }
  return {
    supportsAgent,
    identity(runnerId: string) {
      return runner(runnerId);
    },
    scope(runId: string, workspaceId: string) {
      return task(runId, workspaceId);
    },
    scopeTask(runId: string, workspaceId: string, userId?: string) {
      return responseTask(runId, workspaceId, false, userId);
    },
    current(runId: string, generation: number) {
      const assigned = assignment(runId);
      if (!assigned) throw new RunnerWorkFencedError("Runner work is unavailable.");
      const current = live(assigned.runnerId, runId, generation, now(), false, accepted(assigned));
      return { assignment: current, command: workCommand(current) };
    },
    assign(input: WorkCommand) {
      const command = RunnerCommandSchema.parse(input);
      if (command.type !== "run" && command.type !== "review" && command.type !== "task")
        throw new Error("Work command is required.");
      return immediate(db, () => {
        const at = now();
        const accepting = runner(command.runnerId);
        if (
          accepting.status !== "active" ||
          accepting.workspaceId !== command.workspaceId ||
          command.issuedAt > at ||
          command.expiresAt <= at
        )
          throw new Error("Runner is not accepting this assignment.");
        if (
          runnerCancelPending(db, command.runnerId) &&
          !runnerHasCapacity(db, command.runnerId, at, command.runId)
        )
          throw new RunnerTeardownPending([command.runnerId]);
        if (!runnerHasCapacity(db, command.runnerId, at, command.runId))
          throw new Error("Runner is occupied by active work.");
        if (command.type === "task")
          bindTask(
            command,
            responseTask(command.runId, command.workspaceId, false, accepting.userId),
          );
        else {
          const { item, repository } = task(command.runId, command.workspaceId);
          if (
            item.id !== command.itemId ||
            repository.owner !== command.repository.owner ||
            repository.repo !== command.repository.repo ||
            repository.remoteUrl !== command.repository.remoteUrl
          )
            throw new Error("Run assignment repository or task changed.");
        }
        const owner = runTeardownOwner(db, command.runId);
        if (owner !== null) throw new RunnerTeardownPending([owner]);
        const previous = assignment(command.runId);
        if (
          command.generation !== (previous?.generation ?? 0) + 1 ||
          (previous?.endedAt === null &&
            (accepted(previous)
              ? previous.leaseUntil > at
              : runnerLeaseLive(previous.leaseUntil, at)) &&
            availableIdentity(previous.runnerId)?.fence === previous.runnerFence)
        )
          throw new Error("Run assignment generation conflicts.");
        const leaseUntil = Math.min(command.expiresAt, at + RUNNER_LEASE_MS);
        if (
          command.type === "run" &&
          command.livePreview &&
          !runnerReleaseAtLeast(
            runnerHostVersion(db, command.runnerId),
            LIVE_PREVIEW_RUNNER_VERSION,
          )
        )
          delete command.livePreview;
        const envelope = queue(command);
        assignRunnerWork(db, {
          runId: command.runId,
          runnerId: command.runnerId,
          workspaceId: command.workspaceId,
          generation: command.generation,
          runnerFence: accepting.fence,
          commandId: command.id,
          leaseUntil,
        });
        deleteRunnerWorkGrants(db, command.runId);
        recordRunAgentSetup(db, {
          runId: command.runId,
          runnerId: command.runnerId,
          agent: command.profile.agent,
          hooks:
            command.type === "run" &&
            (command.profile.agent === "claude" || command.profile.agent === "codex")
              ? [
                  { name: "Paws Closeout", event: "stop" },
                  ...(command.hooks ?? []).map((hook) => ({
                    name: hook.command,
                    event: hook.event,
                  })),
                ]
              : [],
          at,
        });
        return { envelope, leaseUntil };
      });
    },
    enqueue(input: RunnerCommand) {
      const command = RunnerCommandSchema.parse(input);
      if (command.type === "run" || command.type === "review" || command.type === "task")
        throw new Error("Use work assignment for run commands.");
      if (command.type === "helper") throw new Error("Use session assignment for helper commands.");
      if (command.type === "rebase")
        throw new Error("Use enqueueRepositoryCommand for repository commands.");
      return immediate(db, () => {
        const identity = runner(command.runnerId);
        if (
          identity.workspaceId !== command.workspaceId ||
          command.issuedAt > now() ||
          command.expiresAt <= now()
        )
          throw new Error("Command scope or lifetime is invalid.");
        if (command.type === "cancel") {
          const work = assignment(command.runId);
          if (!work || work.runnerId !== command.runnerId || work.generation !== command.generation)
            throw new Error("Cancellation assignment changed.");
          endRunnerWork(db, work.runId, work.generation, now());
          deleteRunnerWorkGrants(db, work.runId);
        }
        // A handover keeps the work live: the runner still publishes its WIP commit and result.
        // So does a checkpoint: the runner publishes the WIP commit while the agent goes on.
        if (command.type === "handover" || command.type === "checkpoint") {
          const work = assignment(command.runId);
          if (
            !work ||
            work.runnerId !== command.runnerId ||
            work.generation !== command.generation ||
            work.endedAt !== null ||
            workCommand(work).type !== "run"
          )
            throw new Error(
              command.type === "handover"
                ? "Handover assignment changed."
                : "Checkpoint assignment changed.",
            );
        }
        return queue(command);
      });
    },
    commands(runnerId: string): SignedRunnerCommand[] {
      runner(runnerId);
      const result: SignedRunnerCommand[] = [];
      // A sign-in someone is waiting on goes out before probes and sign-in checks queued earlier.
      const routine = nextRoutineHealthCommand(db, runnerId, now());
      let ordinal = 0;
      while (result.length < 16) {
        const rows = deliverableRunnerCommands(db, {
          runnerId,
          now: now(),
          after: ordinal,
          leaseCutoff: runnerLeaseCutoff(now()),
        });
        for (const row of rows) {
          ordinal = row.ordinal;
          const envelope = JSON.parse(row.envelope) as SignedRunnerCommand;
          const payload = JSON.parse(
            Buffer.from(envelope.payload, "base64url").toString("utf8"),
          ) as RunnerCommand;
          if (
            (payload.type === "probe" || payload.type === "login_check") &&
            row.ordinal !== routine
          )
            continue;
          if (payload.type === "run" || payload.type === "review" || payload.type === "task") {
            try {
              live(runnerId, row.runId!, row.generation!, now());
            } catch (caughtError1) {
              journalCaught(caughtError1, "control.commands.live", null);
              continue;
            }
          }
          result.push(envelope);
          if (result.length === 16) break;
        }
        if (rows.length < 64) break;
      }
      for (const command of deliverRepositoryCommands(db, runnerId, now(), 16 - result.length))
        result.push(
          signRunnerCommand({ keyId: options.keyId, privateKey: options.privateKey, command }),
        );
      return result;
    },
    acknowledge(runnerId: string, commandId: string) {
      runner(runnerId);
      if (
        acknowledgeRunnerCommand(db, runnerId, commandId, now()) !== 1 &&
        !repositoryCommandDeliveredTo(db, runnerId, commandId)
      )
        throw new Error("Runner command is unknown.");
    },
    /**
     * `ceiling` comes from runners that apply the desired concurrency from the reply. `installed`
     * comes from runners that install skills; only they get the skill manifest back. `runtimes`
     * comes from runners that have installed task runtimes with mise. `agents` comes from runners
     * whose coding agents the installer manages; only they get the agent versions asked for back.
     * `reported` comes from runners that name the work they still run: only that work is renewed,
     * and acknowledged work without a result that the runner no longer runs is fenced as lost.
     */
    heartbeat(
      runnerId: string,
      capacity = 1,
      host: RunnerHostSample = {},
      ceiling?: number,
      installed?: readonly RunnerInstalledSkill[],
      runtimes?: readonly RunnerInstalledRuntime[],
      agents?: readonly RunnerInstalledAgent[],
      reported?: readonly { runId: string; generation: number }[],
      repositories?: readonly string[] | null,
      terminated?: readonly { runId: string; generation: number; commandId: string }[],
      liveAfter?: number,
      accounts?: RunnerAccountCapability,
      conversations?: number,
    ) {
      const running =
        reported && new Set(reported.map(({ runId, generation }) => `${runId}:${generation}`));
      return immediate(db, () => {
        runner(runnerId);
        const storedVersion = runnerHostVersion(db, runnerId);
        const aliveAt = lastInstanceHeartbeat(db);
        const offlineCredit =
          aliveAt !== null &&
          runnerReleaseAtLeast(host.runnerVersion ?? storedVersion, OFFLINE_LEASE_RUNNER_VERSION)
            ? { offlineBudgetMs: RUNNER_OFFLINE_BUDGET_MS, aliveAt }
            : undefined;
        const concurrency = recordRunnerCapacity(db, runnerId, capacity, ceiling, conversations);
        const at = now();
        noteRunnerSeen(db, runnerId, at);
        if (Object.values(host).some((value) => value !== undefined))
          recordRunnerHostStatus(db, runnerId, host, at);
        const skills: RunnerSkill[] | undefined = installed && skillManifest();
        if (installed) recordRunnerSkills(db, runnerId, installed, at);
        if (runtimes) recordRunnerRuntimes(db, runnerId, runtimes, at);
        if (agents) recordRunnerAgents(db, runnerId, agents, at);
        if (repositories !== undefined) recordRunnerRepositories(db, runnerId, repositories, at);
        recordRunnerAccountCapability(db, runnerId, accounts, at);
        const targets: RunnerAgentTarget[] | undefined =
          agents &&
          runnerAgentTargets(db, runnerId).flatMap((target) => {
            const parsed = RunnerAgentTargetSchema.safeParse(target);
            return parsed.success && supportsAgent(runnerId, parsed.data.agent)
              ? [parsed.data]
              : [];
          });
        // A receipt ACK and an expired command never confirm worker termination.
        // Only a generation/command-bound broker confirmation releases cleanup ownership.
        for (const entry of terminated ?? [])
          confirmRunnerWorkTeardown(db, { ...entry, runnerId, at });
        const rows = openRunnerAssignments(db, runnerId);
        const leases: { runId: string; generation: number; expiresAt: number }[] = [];
        const fenced: { runId: string; generation: number }[] = [];
        const causal = running !== undefined && liveAfter !== undefined;
        const sampledAfter =
          running && liveAfter !== undefined ? Math.min(liveAfter, at) : at - RUNNER_LIVE_GRACE_MS;
        for (const row of rows) {
          try {
            const settled = accepted(row);
            const named = running?.has(`${row.runId}:${row.generation}`);
            const observed = running !== undefined && acknowledgedBy(row, sampledAfter);
            live(
              runnerId,
              row.runId,
              row.generation,
              at,
              true,
              settled,
              named || !causal || observed ? named : undefined,
            );
            if (named) confirmRunnerWork(db, { runId: row.runId, generation: row.generation, at });
            else if (running && !settled && observed) {
              loseRunnerWork(db, row.runId, row.generation, at);
              deleteRunnerWorkGrants(db, row.runId);
              fenced.push({ runId: row.runId, generation: row.generation });
              continue;
            }
            if (row.leaseUntil + RUNNER_LEASE_GRACE_MS <= at) continue;
            leases.push({
              runId: row.runId,
              generation: row.generation,
              expiresAt: renew(row, at, offlineCredit),
            });
          } catch (caughtError2) {
            journalCaught(caughtError2, "control.heartbeat.live", null);
            endRunnerWork(db, row.runId, row.generation, at);
            deleteRunnerWorkGrants(db, row.runId);
            fenced.push({ runId: row.runId, generation: row.generation });
          }
        }
        // A run Paws already ended that the runner still names keeps its process alive there, so
        // a conversation blocked on its cleanup stays blocked until a report leaves it out.
        if (reported && terminated) noteRunnerTerminations(db, runnerId, at);
        if (reported) {
          noteRunnerLiveReport(db, runnerId, at);
          for (const { runId, generation } of reported)
            confirmRunnerWork(db, { runId, generation, at, runnerId });
        }
        return {
          leases,
          fenced,
          ...(liveAfter === undefined ? {} : { observedAt: at }),
          ...(terminated === undefined ? {} : { terminated: [...terminated] }),
          ...(offlineCredit === undefined ? {} : offlineCredit),
          ...(concurrency === undefined ? {} : { concurrency }),
          ...(skills === undefined ? {} : { skills }),
          ...(targets === undefined ? {} : { agents: targets }),
        };
      });
    },
    /** The registered bundle a runner may download: only the current pin of a skill that is not removed. */
    skillBundle(runnerId: string, name: string, version: string): RunnerSkill {
      runner(runnerId);
      const skill = skillManifest().find((entry) => entry.name === name);
      if (!skill || skill.version !== version) throw new Error("Skill bundle is not registered.");
      return skill;
    },
    issueGrant(input: { runnerId: string; runId: string; commandId: string; generation: number }) {
      return immediate(db, () => {
        const work = live(input.runnerId, input.runId, input.generation, now());
        if (work.commandId !== input.commandId) throw new Error("Run command changed.");
        const token = workspaceSecret();
        const leaseUntil = work.leaseUntil > now() ? work.leaseUntil : renew(work, now());
        const expiresAt = Math.min(leaseUntil, now() + 60_000);
        deleteRunnerWorkGrants(db, input.runId);
        insertRunnerWorkGrant(db, {
          tokenHash: workspaceTokenHash(token),
          runId: input.runId,
          generation: input.generation,
          expiresAt,
        });
        return { token, expiresAt };
      });
    },
    event(input: {
      runnerId: string;
      runId: string;
      generation: number;
      sequence: number;
      token: string;
      event: RunnerEvent;
    }) {
      const event = JSON.stringify(RunnerEventSchema.parse(withoutJournalTime(input.event)));
      if (!Number.isSafeInteger(input.sequence) || input.sequence < 1)
        throw new Error("Event sequence is invalid.");
      return immediate(db, () => {
        const at = now();
        const key = { runId: input.runId, generation: input.generation, sequence: input.sequence };
        const saved = storedRunnerEvent(db, key);
        const work = authorized(input, saved !== null);
        const command = workCommand(work);
        if (
          command.type === "task" &&
          (input.event.type === "candidate" ||
            (command.purpose !== "artifact" && input.event.type === "artifact"))
        )
          throw new Error("Response task event is not authorized");
        if (saved) {
          if ((saved.payloadSha256 ?? payloadSha256(saved.payload)) !== payloadSha256(event))
            throw new Error("Event replay changed its payload.");
          return { duplicate: true };
        }
        if (input.sequence !== work.lastSequence + 1) throw new Error("Event sequence has a gap.");
        const sealed = sealRunnerEvent(eventKey, input, event);
        insertRunnerEvent(db, key, sealed, at);
        setRunnerWorkLastSequence(db, input.runId, input.sequence);
        return { duplicate: false };
      });
    },
    openEvent(row: StoredRunnerEvent): RunnerEvent {
      return openRunnerEvent(db, eventKey, row);
    },
    authorize(input: { runnerId: string; runId: string; generation: number; token: string }) {
      const work = authorized(input);
      const command = workCommand(work);
      return {
        command,
        branch: command.type === "task" ? null : getWorkItem(db, command.itemId)!.branchName,
      };
    },
    finish(runId: string, generation: number) {
      immediate(db, () => {
        if (finishRunnerWork(db, runId, generation, now()) !== 1)
          throw new Error("Run assignment changed.");
        deleteRunnerWorkGrants(db, runId);
      });
    },
  };
}
export type RunnerWork = ReturnType<typeof createRunnerWork>;
