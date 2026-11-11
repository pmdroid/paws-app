import {
  extendStalledRunnerWorkSteps,
  acknowledgeRunnerCommandSteps,
  assignRunnerWorkSteps,
  availableRunnerIdentitySteps,
  confirmRunnerWorkSteps,
  confirmRunnerWorkTeardownSteps,
  deleteRunnerWorkGrantsSteps,
  deliverableRunnerCommandsSteps,
  emitJobReady,
  endRunnerWorkSteps,
  extendRunnerWorkLeaseSteps,
  finishRunnerWorkSteps,
  getLinearSessionAccessSteps,
  getLinearSessionSteps,
  getRunSteps,
  getTaskModeGenerationSteps,
  getTaskModeSteps,
  getWorkItemRepositorySteps,
  getWorkItemSteps,
  insertRunnerCommandSteps,
  insertRunnerEventSteps,
  insertRunnerWorkGrantSteps,
  lastInstanceHeartbeatSteps,
  linearSessionClientIdSteps,
  listSkillsSteps,
  loseRunnerWorkSteps,
  nextRoutineHealthCommandSteps,
  noteRunnerLiveReportSteps,
  noteRunnerSeenSteps,
  noteRunnerTerminationsSteps,
  openRunnerAssignmentsSteps,
  recordCommandAccountSteps,
  recordRunAgentSetupSteps,
  recordRunnerAccountCapabilitySteps,
  recordRunnerAgentsSteps,
  recordRunnerCapacityWakingSteps,
  recordRunnerHostStatusSteps,
  recordRunnerRepositoriesSteps,
  recordRunnerRuntimesSteps,
  recordRunnerSkillsSteps,
  runnerAgentTargetsSteps,
  runnerCancelPendingSteps,
  runnerCheckpointPendingSteps,
  runnerCommandAcknowledgedBySteps,
  runnerCommandAuthorityUntilSteps,
  runnerCommandEnvelopeSteps,
  runnerFinishedRunsSteps,
  runnerHasCapacitySteps,
  runnerHostVersionSteps,
  runnerLeaseCutoff,
  runnerLeaseLive,
  runnerResultForCommandSteps,
  runnerStandingSteps,
  runnerWorkAssignmentSteps,
  runnerWorkGrantValidSteps,
  runnerWorkStillReportedSteps,
  runTeardownOwnerSteps,
  setRunnerWorkLastSequenceSteps,
  settled as settledValue,
  sqliteDb,
  storedRunnerEventSteps,
  taskRequiresRepositorySteps,
  wakeRunnerSlotWaitsSteps,
  workspaceInLinearOrganizationSteps,
  workspaceSessionIdsSteps,
  workspaceSessionRepositoryAllowedSteps,
  type Db,
  type Q,
  type Steps,
  type RunnerAssignment as Assignment,
  type RunnerHostSample,
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
  CONTROL_PLANE_LEVEL_RUNNER_VERSION,
  CONTROL_PLANE_PROTOCOL_LEVEL,
  WORK_ROOT_CLEANUP_RUNNER_VERSION,
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
import { findOpenQuestionSteps } from "../questions";
import {
  deliverRepositoryCommands,
  repositoryCommandDeliveredToSteps,
} from "../runner-repository-commands";
import {
  openRunnerEventSteps,
  payloadSha256,
  sealRunnerEvent,
  type StoredRunnerEvent,
} from "./events";

export { RunnerEventSchema, type RunnerEvent } from "../runner-protocol";
type WorkCommand = Extract<RunnerCommand, { type: "run" | "review" | "task" }>;
type ResponseTask = {
  item: { id: string };
  sessionId: string;
  sessionGeneration: number;
  taskModeGeneration: number;
  purpose: string | null;
  repository: { owner: string; repo: string; remoteUrl: string } | undefined;
};

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
  const store = sqliteDb(db);
  // Methods that still return synchronously read the settled result of their SQLite Steps,
  // which finish before they return, until every caller can await them.
  const transaction = <T>(body: (q: Q) => Steps<T>) => settledValue(store.transaction(body));
  const read = <T>(body: (q: Q) => Steps<T>) => settledValue(store.run(body));
  const { eventKey } = options;
  const now = options.now ?? Date.now;
  /** Registered skills a runner should have installed. Removed ones are left out, so runners delete them. */
  function* skillManifestSteps(q: Q): Steps<RunnerSkill[]> {
    return (yield* listSkillsSteps(q))
      .filter((skill) => skill.removedAt === null)
      .map(({ name, version, sha256, sizeBytes, agents }) => ({
        name,
        version,
        sha256,
        sizeBytes,
        agents,
      }));
  }
  function* runnerSteps(q: Q, id: string) {
    const row = yield* availableRunnerIdentitySteps(q, id);
    if (!row) throw new Error("Runner identity is unavailable.");
    return row;
  }
  function* activeTaskSteps(q: Q, runId: string, allowPendingQuestion = false) {
    const execution = yield* getRunSteps(q, runId);
    const item = execution ? yield* getWorkItemSteps(q, execution.itemId) : null;
    // A run Paws stops for a cap or a restart publishes its WIP commit first: until that
    // checkpoint request expires, its runner may still send the commit and push it.
    const checkpointing =
      item?.currentRunId === runId && (yield* runnerCheckpointPendingSteps(q, runId, now()));
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
    if (!sessionId || (yield* getLinearSessionAccessSteps(q, sessionId)) !== "allowed")
      throw new Error("Linear task access is unavailable.");
    if (item.state === "awaiting_input" && !allowPendingQuestion && !checkpointing) {
      const question = yield* findOpenQuestionSteps(q, sessionId);
      if (question?.itemId !== item.id || question.runId !== runId)
        throw new Error("Run has no matching open question.");
    }
    return { item, sessionId };
  }
  function* taskSteps(q: Q, runId: string, workspaceId: string, allowPendingQuestion = false) {
    const { item, sessionId } = yield* activeTaskSteps(q, runId, allowPendingQuestion);
    const repository = yield* getWorkItemRepositorySteps(q, item.id);
    if (!repository) throw new Error("Run repository is not bound.");
    if (
      !(yield* workspaceSessionRepositoryAllowedSteps(
        q,
        workspaceId,
        sessionId,
        `${repository.owner}/${repository.repo}`,
      ))
    )
      throw new Error("Run is outside the runner workspace repository access.");
    return { item, repository };
  }
  function* responseTaskSteps(
    q: Q,
    runId: string,
    workspaceId: string,
    allowPendingQuestion = false,
    userId?: string,
  ) {
    const { item, sessionId } = yield* activeTaskSteps(q, runId, allowPendingQuestion);
    const session = yield* getLinearSessionSteps(q, sessionId);
    const purpose = yield* getTaskModeSteps(q, item.id);
    const clientId = yield* linearSessionClientIdSteps(q, sessionId);
    if (
      !session ||
      session.stoppedAt !== null ||
      !clientId ||
      (purpose !== "answer" && purpose !== "artifact" && purpose !== "plan") ||
      !(yield* workspaceInLinearOrganizationSteps(q, workspaceId, session.organizationId)) ||
      (userId !== undefined &&
        !(yield* workspaceSessionIdsSteps(q, workspaceId, userId, clientId)).includes(sessionId))
    )
      throw new RunnerWorkFencedError("Linear response task authority changed");
    return {
      item,
      sessionId,
      sessionGeneration: session.generation,
      taskModeGeneration: yield* getTaskModeGenerationSteps(q, item.id),
      purpose,
      repository: (yield* taskRequiresRepositorySteps(q, item.id))
        ? (yield* taskSteps(q, runId, workspaceId, allowPendingQuestion)).repository
        : undefined,
    };
  }
  function bindTask(command: Extract<WorkCommand, { type: "task" }>, current: ResponseTask) {
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
  function* liveSteps(
    q: Q,
    runnerId: string,
    runId: string,
    generation: number,
    at: number,
    allowPendingQuestion = false,
    settled = false,
    reported?: boolean,
  ): Steps<Assignment> {
    const identity = yield* runnerSteps(q, runnerId);
    const work = yield* runnerWorkAssignmentSteps(q, runId);
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
          // Whether the runner's latest heartbeat named this run among the work it still runs.
          (!(reported ?? (yield* runnerWorkStillReportedSteps(q, runnerId, runId))) &&
            !(yield* runnerHasCapacitySteps(q, runnerId, at, runId)))))
    )
      throw new RunnerWorkFencedError("Runner work is fenced or its lease expired.");
    const command = yield* workCommandSteps(q, work);
    if (command.expiresAt <= at && !settled)
      throw new RunnerWorkFencedError("Runner command expired.");
    if (command.type === "task") {
      bindTask(
        command,
        yield* responseTaskSteps(q, runId, work.workspaceId, allowPendingQuestion, identity.userId),
      );
      return work;
    }
    const current = yield* taskSteps(q, runId, work.workspaceId, allowPendingQuestion);
    if (
      current.item.id !== command.itemId ||
      current.repository.owner !== command.repository.owner ||
      current.repository.repo !== command.repository.repo ||
      current.repository.remoteUrl !== command.repository.remoteUrl
    )
      throw new Error("Run repository binding changed.");
    return work;
  }
  function* renewSteps(
    q: Q,
    work: Assignment,
    at: number,
    credit?: { offlineBudgetMs: number; aliveAt: number },
  ) {
    const expiresAt = (yield* workCommandSteps(q, work)).expiresAt;
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
    yield* extendRunnerWorkLeaseSteps(
      q,
      work.runId,
      Math.max(leaseUntil, authorityUntil - RUNNER_LEASE_GRACE_MS),
    );
    return leaseUntil;
  }
  function* acceptedSteps(q: Q, work: Assignment) {
    return (yield* runnerResultForCommandSteps(q, work, work.commandId)) !== null;
  }
  function* workCommandSteps(q: Q, work: Assignment): Steps<WorkCommand> {
    const stored = yield* runnerCommandEnvelopeSteps(q, work.commandId);
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
    return { ...command, expiresAt: yield* runnerCommandAuthorityUntilSteps(q, work.commandId) };
  }
  function* authorizedSteps(
    q: Q,
    input: {
      runnerId: string;
      runId: string;
      generation: number;
      token: string;
    },
    allowPendingQuestion = false,
  ): Steps<Assignment> {
    const at = now();
    const work = yield* liveSteps(
      q,
      input.runnerId,
      input.runId,
      input.generation,
      at,
      allowPendingQuestion,
    );
    if (
      !(yield* runnerWorkGrantValidSteps(
        q,
        {
          tokenHash: workspaceTokenHash(input.token),
          runId: input.runId,
          generation: input.generation,
        },
        at,
      ))
    )
      throw new Error("Run grant is invalid or expired.");
    return work;
  }
  function* supportsAgentSteps(q: Q, runnerId: string, agent: string) {
    if (agent !== "opencode") return true;
    const version = yield* runnerHostVersionSteps(q, runnerId);
    const parts = version
      ?.match(/^(\d+)\.(\d+)\.(\d+)(?:$|[-+])/)
      ?.slice(1)
      .map(Number);
    if (!parts) return false;
    for (const [index, part] of parts.entries())
      if (part !== OPENCODE_RUNNER_VERSION[index]) return part > OPENCODE_RUNNER_VERSION[index]!;
    return true;
  }
  function* queueSteps(q: Q, command: RunnerCommand) {
    const agent =
      "profile" in command ? command.profile.agent : "agent" in command ? command.agent : null;
    if (agent && !(yield* supportsAgentSteps(q, command.runnerId, agent)))
      throw new Error(
        `OpenCode needs runner ${OPENCODE_RUNNER_VERSION.join(".")} or later. Upgrade the runner, then try again.`,
      );
    const envelope = signRunnerCommand({
      keyId: options.keyId,
      privateKey: options.privateKey,
      command,
    });
    yield* q.transaction((savepoint) => recordCommandAccountSteps(savepoint, command, now()));
    yield* insertRunnerCommandSteps(q, {
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
  function* assignSteps(q: Q, input: WorkCommand) {
    const command = RunnerCommandSchema.parse(input);
    if (command.type !== "run" && command.type !== "review" && command.type !== "task")
      throw new Error("Work command is required.");
    const at = now();
    const accepting = yield* runnerSteps(q, command.runnerId);
    if (
      accepting.status !== "active" ||
      accepting.workspaceId !== command.workspaceId ||
      command.issuedAt > at ||
      command.expiresAt <= at
    )
      throw new Error("Runner is not accepting this assignment.");
    if (
      (yield* runnerCancelPendingSteps(q, command.runnerId)) &&
      !(yield* runnerHasCapacitySteps(q, command.runnerId, at, command.runId))
    )
      throw new RunnerTeardownPending([command.runnerId]);
    if (!(yield* runnerHasCapacitySteps(q, command.runnerId, at, command.runId)))
      throw new Error("Runner is occupied by active work.");
    if (command.type === "task")
      bindTask(
        command,
        yield* responseTaskSteps(q, command.runId, command.workspaceId, false, accepting.userId),
      );
    else {
      const { item, repository } = yield* taskSteps(q, command.runId, command.workspaceId);
      if (
        item.id !== command.itemId ||
        repository.owner !== command.repository.owner ||
        repository.repo !== command.repository.repo ||
        repository.remoteUrl !== command.repository.remoteUrl
      )
        throw new Error("Run assignment repository or task changed.");
    }
    const owner = yield* runTeardownOwnerSteps(q, command.runId);
    if (owner !== null) throw new RunnerTeardownPending([owner]);
    const previous = yield* runnerWorkAssignmentSteps(q, command.runId);
    if (
      command.generation !== (previous?.generation ?? 0) + 1 ||
      (previous?.endedAt === null &&
        ((yield* acceptedSteps(q, previous))
          ? previous.leaseUntil > at
          : runnerLeaseLive(previous.leaseUntil, at)) &&
        (yield* availableRunnerIdentitySteps(q, previous.runnerId))?.fence === previous.runnerFence)
    )
      throw new Error("Run assignment generation conflicts.");
    const leaseUntil = Math.min(command.expiresAt, at + RUNNER_LEASE_MS);
    if (
      command.type === "run" &&
      command.livePreview &&
      !runnerReleaseAtLeast(
        yield* runnerHostVersionSteps(q, command.runnerId),
        LIVE_PREVIEW_RUNNER_VERSION,
      )
    )
      delete command.livePreview;
    const envelope = yield* queueSteps(q, command);
    yield* assignRunnerWorkSteps(q, {
      runId: command.runId,
      runnerId: command.runnerId,
      workspaceId: command.workspaceId,
      generation: command.generation,
      runnerFence: accepting.fence,
      commandId: command.id,
      leaseUntil,
    });
    yield* deleteRunnerWorkGrantsSteps(q, command.runId);
    yield* recordRunAgentSetupSteps(q, {
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
  }
  function parseEnqueued(input: RunnerCommand) {
    const command = RunnerCommandSchema.parse(input);
    if (command.type === "run" || command.type === "review" || command.type === "task")
      throw new Error("Use work assignment for run commands.");
    if (command.type === "helper") throw new Error("Use session assignment for helper commands.");
    if (command.type === "rebase")
      throw new Error("Use enqueueRepositoryCommand for repository commands.");
    return command;
  }
  function* enqueuedSteps(q: Q, command: ReturnType<typeof parseEnqueued>) {
    const identity = yield* runnerSteps(q, command.runnerId);
    if (
      identity.workspaceId !== command.workspaceId ||
      command.issuedAt > now() ||
      command.expiresAt <= now()
    )
      throw new Error("Command scope or lifetime is invalid.");
    if (command.type === "cancel") {
      const work = yield* runnerWorkAssignmentSteps(q, command.runId);
      if (!work || work.runnerId !== command.runnerId || work.generation !== command.generation)
        throw new Error("Cancellation assignment changed.");
      yield* endRunnerWorkSteps(q, work.runId, work.generation, now());
      yield* deleteRunnerWorkGrantsSteps(q, work.runId);
    }
    if (command.type === "handover" || command.type === "checkpoint") {
      const work = yield* runnerWorkAssignmentSteps(q, command.runId);
      if (
        !work ||
        work.runnerId !== command.runnerId ||
        work.generation !== command.generation ||
        work.endedAt !== null ||
        (yield* workCommandSteps(q, work)).type !== "run"
      )
        throw new Error(
          command.type === "handover"
            ? "Handover assignment changed."
            : "Checkpoint assignment changed.",
        );
    }
    return yield* queueSteps(q, command);
  }
  function* currentSteps(q: Q, runId: string, generation: number) {
    const assigned = yield* runnerWorkAssignmentSteps(q, runId);
    if (!assigned) throw new RunnerWorkFencedError("Runner work is unavailable.");
    const current = yield* liveSteps(
      q,
      assigned.runnerId,
      runId,
      generation,
      now(),
      false,
      yield* acceptedSteps(q, assigned),
    );
    return { assignment: current, command: yield* workCommandSteps(q, current) };
  }
  function* authorizeSteps(
    q: Q,
    input: { runnerId: string; runId: string; generation: number; token: string },
  ) {
    const work = yield* authorizedSteps(q, input);
    const command = yield* workCommandSteps(q, work);
    return {
      command,
      branch:
        command.type === "task" ? null : (yield* getWorkItemSteps(q, command.itemId))!.branchName,
    };
  }
  function openEventSteps(q: Q, row: StoredRunnerEvent): Steps<RunnerEvent> {
    return openRunnerEventSteps(q, eventKey, row);
  }
  return {
    supportsAgentSteps,
    supportsAgent(runnerId: string, agent: string) {
      return read((q) => supportsAgentSteps(q, runnerId, agent));
    },
    identity(runnerId: string) {
      return read((q) => runnerSteps(q, runnerId));
    },
    scope(runId: string, workspaceId: string) {
      return read((q) => taskSteps(q, runId, workspaceId));
    },
    scopeTask(runId: string, workspaceId: string, userId?: string) {
      return read((q) => responseTaskSteps(q, runId, workspaceId, false, userId));
    },
    current(runId: string, generation: number) {
      return read((q) => currentSteps(q, runId, generation));
    },
    currentAsync(runId: string, generation: number) {
      return store.run((q) => currentSteps(q, runId, generation));
    },
    currentSteps,
    assignSteps,
    assign(input: WorkCommand) {
      return transaction((q) => assignSteps(q, input));
    },
    enqueue(input: RunnerCommand) {
      const command = parseEnqueued(input);
      return transaction((q) => enqueuedSteps(q, command));
    },
    enqueueSteps(q: Q, input: RunnerCommand) {
      return enqueuedSteps(q, parseEnqueued(input));
    },
    async commands(runnerId: string): Promise<SignedRunnerCommand[]> {
      const result = await store.run(function* (q) {
        yield* runnerSteps(q, runnerId);
        const signed: SignedRunnerCommand[] = [];
        // A sign-in someone is waiting on goes out before probes and sign-in checks queued earlier.
        const routine = yield* nextRoutineHealthCommandSteps(q, runnerId, now());
        let ordinal = 0;
        while (signed.length < 16) {
          const rows = yield* deliverableRunnerCommandsSteps(q, {
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
                yield* liveSteps(q, runnerId, row.runId!, row.generation!, now());
              } catch (caughtError1) {
                journalCaught(caughtError1, "control.commands.live", null);
                continue;
              }
            }
            signed.push(envelope);
            if (signed.length === 16) break;
          }
          if (rows.length < 64) break;
        }
        return signed;
      });
      for (const command of deliverRepositoryCommands(db, runnerId, now(), 16 - result.length))
        result.push(
          signRunnerCommand({ keyId: options.keyId, privateKey: options.privateKey, command }),
        );
      return result;
    },
    async acknowledge(runnerId: string, commandId: string) {
      await store.run((q) => runnerSteps(q, runnerId));
      if (
        (await store.run((q) => acknowledgeRunnerCommandSteps(q, runnerId, commandId, now()))) !==
          1 &&
        !(await store.run((q) => repositoryCommandDeliveredToSteps(q, runnerId, commandId)))
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
    async heartbeat(
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
      // The capacity, repository and slot-wait writes that wake jobs say so once they commit.
      let woke = false;
      const reply = await store.transaction(function* (q) {
        yield* runnerSteps(q, runnerId);
        const storedVersion = yield* runnerHostVersionSteps(q, runnerId);
        const version = host.runnerVersion ?? storedVersion;
        const aliveAt = yield* lastInstanceHeartbeatSteps(q);
        const offlineCredit =
          aliveAt !== null &&
          runnerReleaseAtLeast(host.runnerVersion ?? storedVersion, OFFLINE_LEASE_RUNNER_VERSION)
            ? { offlineBudgetMs: RUNNER_OFFLINE_BUDGET_MS, aliveAt }
            : undefined;
        const at = now();
        const reconnected =
          ((yield* runnerStandingSteps(q, runnerId))?.lastSeenAt ?? 0) <= at - 60_000;
        const capacityRecorded = yield* recordRunnerCapacityWakingSteps(
          q,
          runnerId,
          capacity,
          ceiling,
          conversations,
          at,
        );
        const concurrency = capacityRecorded.concurrency;
        woke = capacityRecorded.woke;
        yield* noteRunnerSeenSteps(q, runnerId, at);
        if (Object.values(host).some((value) => value !== undefined))
          yield* recordRunnerHostStatusSteps(q, runnerId, host, at);
        const skills: RunnerSkill[] | undefined = installed && (yield* skillManifestSteps(q));
        if (installed) yield* recordRunnerSkillsSteps(q, runnerId, installed, at);
        if (runtimes) yield* recordRunnerRuntimesSteps(q, runnerId, runtimes, at);
        if (agents) yield* recordRunnerAgentsSteps(q, runnerId, agents, at);
        if (
          repositories !== undefined &&
          (yield* q.transaction((savepoint) =>
            recordRunnerRepositoriesSteps(savepoint, runnerId, repositories, at),
          ))
        )
          woke = true;
        yield* recordRunnerAccountCapabilitySteps(q, runnerId, accounts, at);
        if (reconnected && (yield* wakeRunnerSlotWaitsSteps(q, runnerId, at))) woke = true;
        let targets: RunnerAgentTarget[] | undefined;
        if (agents) {
          targets = [];
          for (const target of yield* runnerAgentTargetsSteps(q, runnerId)) {
            const parsed = RunnerAgentTargetSchema.safeParse(target);
            if (parsed.success && (yield* supportsAgentSteps(q, runnerId, parsed.data.agent)))
              targets.push(parsed.data);
          }
        }
        // A receipt ACK and an expired command never confirm worker termination.
        // Only a generation/command-bound broker confirmation releases cleanup ownership.
        for (const entry of terminated ?? [])
          yield* confirmRunnerWorkTeardownSteps(q, { ...entry, runnerId, at });
        const rows = yield* openRunnerAssignmentsSteps(q, runnerId);
        const leases: { runId: string; generation: number; expiresAt: number }[] = [];
        const fenced: { runId: string; generation: number }[] = [];
        const causal = running !== undefined && liveAfter !== undefined;
        const sampledAfter =
          running && liveAfter !== undefined ? Math.min(liveAfter, at) : at - RUNNER_LIVE_GRACE_MS;
        for (const row of rows) {
          try {
            const settled = yield* acceptedSteps(q, row);
            const named = running?.has(`${row.runId}:${row.generation}`);
            const observed =
              running !== undefined &&
              (yield* runnerCommandAcknowledgedBySteps(q, row.commandId, sampledAfter));
            yield* liveSteps(
              q,
              runnerId,
              row.runId,
              row.generation,
              at,
              true,
              settled,
              named || !causal || observed ? named : undefined,
            );
            if (named)
              yield* confirmRunnerWorkSteps(q, {
                runId: row.runId,
                generation: row.generation,
                at,
              });
            else if (running && !settled && observed) {
              yield* loseRunnerWorkSteps(q, row.runId, row.generation, at);
              yield* deleteRunnerWorkGrantsSteps(q, row.runId);
              fenced.push({ runId: row.runId, generation: row.generation });
              continue;
            }
            if (row.leaseUntil + RUNNER_LEASE_GRACE_MS <= at) continue;
            leases.push({
              runId: row.runId,
              generation: row.generation,
              expiresAt: yield* renewSteps(q, row, at, offlineCredit),
            });
          } catch (caughtError2) {
            journalCaught(caughtError2, "control.heartbeat.live", null);
            yield* endRunnerWorkSteps(q, row.runId, row.generation, at);
            yield* deleteRunnerWorkGrantsSteps(q, row.runId);
            fenced.push({ runId: row.runId, generation: row.generation });
          }
        }
        // A run Paws already ended that the runner still names keeps its process alive there, so
        // a conversation blocked on its cleanup stays blocked until a report leaves it out.
        if (reported && terminated) yield* noteRunnerTerminationsSteps(q, runnerId, at);
        if (reported) {
          yield* noteRunnerLiveReportSteps(q, runnerId, at);
          for (const { runId, generation } of reported)
            yield* confirmRunnerWorkSteps(q, { runId, generation, at, runnerId });
        }
        const finishedRuns = runnerReleaseAtLeast(
          host.runnerVersion ?? storedVersion,
          WORK_ROOT_CLEANUP_RUNNER_VERSION,
        )
          ? yield* runnerFinishedRunsSteps(q, runnerId)
          : [];
        return {
          leases,
          fenced,
          ...(finishedRuns.length ? { finishedRuns } : {}),
          ...(liveAfter === undefined ? {} : { observedAt: at }),
          ...(terminated === undefined ? {} : { terminated: [...terminated] }),
          ...(offlineCredit === undefined ? {} : offlineCredit),
          ...(concurrency === undefined ? {} : { concurrency }),
          ...(skills === undefined ? {} : { skills }),
          ...(targets === undefined ? {} : { agents: targets }),
          // Older runners parse this reply strictly, so only a known older release goes without.
          ...(!version || runnerReleaseAtLeast(version, CONTROL_PLANE_LEVEL_RUNNER_VERSION)
            ? { protocolLevel: CONTROL_PLANE_PROTOCOL_LEVEL }
            : {}),
        };
      });
      if (woke) emitJobReady(store);
      return reply;
    },
    /** The registered bundle a runner may download: only the current pin of a skill that is not removed. */
    skillBundle(runnerId: string, name: string, version: string): Promise<RunnerSkill> {
      return store.run(function* (q) {
        yield* runnerSteps(q, runnerId);
        const skill = (yield* skillManifestSteps(q)).find((entry) => entry.name === name);
        if (!skill || skill.version !== version) throw new Error("Skill bundle is not registered.");
        return skill;
      });
    },
    issueGrant(input: { runnerId: string; runId: string; commandId: string; generation: number }) {
      return store.transaction(function* (q) {
        const work = yield* liveSteps(q, input.runnerId, input.runId, input.generation, now());
        if (work.commandId !== input.commandId) throw new Error("Run command changed.");
        const token = workspaceSecret();
        const leaseUntil =
          work.leaseUntil > now() ? work.leaseUntil : yield* renewSteps(q, work, now());
        const expiresAt = Math.min(leaseUntil, now() + 60_000);
        yield* deleteRunnerWorkGrantsSteps(q, input.runId);
        yield* insertRunnerWorkGrantSteps(q, {
          tokenHash: workspaceTokenHash(token),
          runId: input.runId,
          generation: input.generation,
          expiresAt,
        });
        return { token, expiresAt };
      });
    },
    async event(input: {
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
      return store.transaction(function* (q) {
        const at = now();
        const key = {
          runId: input.runId,
          generation: input.generation,
          sequence: input.sequence,
        };
        const saved = yield* storedRunnerEventSteps(q, key, key.sequence);
        const work = yield* authorizedSteps(q, input, saved !== null);
        const command = yield* workCommandSteps(q, work);
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
        yield* insertRunnerEventSteps(q, key, sealed, at);
        yield* setRunnerWorkLastSequenceSteps(q, input.runId, input.sequence);
        return { duplicate: false };
      });
    },
    openEvent(row: StoredRunnerEvent): RunnerEvent {
      return read((q) => openEventSteps(q, row));
    },
    openEventSteps,
    authorize(input: { runnerId: string; runId: string; generation: number; token: string }) {
      return read((q) => authorizeSteps(q, input));
    },
    authorizeAsync(input: { runnerId: string; runId: string; generation: number; token: string }) {
      return store.run((q) => authorizeSteps(q, input));
    },
    authorizeSteps,
    async finish(runId: string, generation: number) {
      await store.transaction(function* (q) {
        if ((yield* finishRunnerWorkSteps(q, runId, generation, now())) !== 1)
          throw new Error("Run assignment changed.");
        yield* deleteRunnerWorkGrantsSteps(q, runId);
      });
    },
  };
}
export type RunnerWork = ReturnType<typeof createRunnerWork>;

// Use the same monotonic lease extension as heartbeat renewal.
export function recoverRunnerWorkStall(store: Db, startedAt: number, lagMs: number): Promise<void> {
  return store.transaction((q) => extendStalledRunnerWorkSteps(q, startedAt, lagMs));
}
