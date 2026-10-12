import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type { AskTeamHook, AgentIdentity } from "../acp";
import {
  executeItem,
  git,
  removeWorktree,
  resolveAdapter,
  worktreePath,
  runDir,
  runAgent,
  createWorktree,
  ensureBareMirror,
  FOLLOW_UP_INTERRUPTION,
  type RunAgentOptions,
  type RunAgentResult,
  prepareRepositorySnapshot,
} from "../acp";
import { loadConfigFile, resolveAgentProfiles, type AgentProfile } from "../config";
import {
  createCloseoutGate,
  reviewRequirements,
  bypassable,
  snapshotRetryBaseline,
  type GateResult,
  type CloseoutVerdict,
  type CandidateIdentity,
} from "../closeout";
import {
  CommandBus,
  JOB_KIND,
  MERGE_LANE,
  transitionEpic,
  type Clock,
  type LinearCommand,
  type EpicState,
  type RepositoryBinding,
  systemClock,
} from "../core";
import {
  getTaskMode,
  getLinearSessionAccess,
  recordConfirmedRemoteMerge,
  getConfirmedRemoteMerge,
  getLinearTaskDelegation,
  getTaskModeGeneration,
  getLinearSessionGeneration,
  getLinearSession,
  acceptLinearStop,
  listPendingLinearTurns,
  saveTaskMode,
  taskRequiresRepository,
  selectTaskModeForTurn,
  completeAnswerTask,
  completeArtifactTask,
  artifactPublicationReady,
  listArtifacts,
  getTaskClassification,
  resolveTaskClassification,
  applyWorkItemEvent,
  configureWorkItem,
  drainCommands,
  enqueueJobOnce,
  enqueueOutboxOnce,
  failWorkItem,
  getRun,
  getConversation,
  saveConversation,
  listLinearTurnsForItem,
  announceLinearTurn,
  getLinearTurnGeneration,
  discardLinearTurns,
  bindWorkItemRepository,
  getWorkItemRepository,
  getWorkItemRepositoryAnswer,
  getWorkItemRepositoryChoice,
  rememberWorkItemRepositoryChoice,
  isWorkItemRepositoryQuestion,
  saveWorkItemRepositoryQuestion,
  getWorkItem,
  immediate,
  insertRun,
  listInFlightItems,
  listCloseoutRecoveries,
  saveCloseoutRecovery,
  type CloseoutRecovery,
  markRun,
  saveCheckpoint,
  saveRunResult,
  bindLinearSessionTask,
  ensureLinearSession,
  activateLinearItem,
  linearSessionForEpic,
  recordLinearTurn,
  applyLinearTurns,
  saveLinearSessionContext,
  getLinearSessionContext,
  hasLinearSessionSnapshotContext,
  saveLinearSessionSnapshotContext,
  saveLinearActivitySnapshot,
  listLinearActivitySnapshots,
  setCurrentRun,
  applyLinearCommand,
  type JobLoop,
  type OutboxDispatcher,
  type WorkItemRecord,
} from "../db";
import {
  publishAccepted,
  serialMerge,
  type GitHubClient,
  type GitHubTokenProvider,
} from "../github";
import { intakeDelegatedIssue, type IntakeResult } from "../intake";
import type {
  AcceptedLinearEvent,
  ProgressUpdate,
  TrackerAdapter,
  TrackerRequestOptions,
  LinearActivitySnapshot,
  LinearFileTransfer,
} from "../linear";
import { parseLinearSessionContext, renderLinearSessionContext } from "../linear";
import {
  answerQuestion,
  elicitationBody,
  findOpenQuestion,
  handoffNote,
  openQuestion,
  questionReplyConsumed,
} from "../questions";
import { createAcpActivityReporter, FIRST_ACTIVITY_MS, KEEPALIVE_MS } from "./activity";
import { parseRecoveryAnswer, recoveryOptions, recoveryQuestion } from "./closeout-recovery";
import { createDbCloseoutProgress } from "./closeout-progress";
import { isGitHubIssue, itemPathId, publishIssueKey, worktreeBranch } from "./sources";
import {
  createAcpCodexReviewer,
  createAcpFixRunner,
  implementPrompt,
  type AgentLaunch,
  type AcpAgentDeps,
} from "./agents";
import { deliverLinearOutbox } from "./dispatch";
import { durableConversation } from "./conversation";
import { createLinearSessionProgress } from "./session-progress";
import { renderWorkBrief } from "./brief";
import { recordLinearSessionEvent, sessionTaskKey } from "./linear-routing";
import { createLinearArtifactPublisher } from "./artifacts";
import { createLinearInputLoader } from "./input-files";
import { createTaskPlanner } from "./task-planner";
import { classifyTask } from "./task-classifier";
import type { LinearTaskAccess } from "./linear-task-access";
import { guardGitHubPublication } from "./publication";
import { createRepositoryGit } from "./repository-git";
import { GitHubAuthQuestions, type HostGitHubAuth } from "./github-auth";
import {
  interpretRepositoryAnswer,
  rankRepositories,
  repositoryAnswer,
} from "./repository-selection";

export type GitHubBinding = {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  client: GitHubClient;
  /** `github.auth = "gh"`. When set, push and merge do not mint a GitHub App token. */
  tokenProvider?: GitHubTokenProvider;
};

export type { RepositoryBinding } from "../core";

export type OrchestratorOptions = {
  db: Database;
  jobs: JobLoop;
  outbox: OutboxDispatcher;
  pawsRoot: string;
  home?: string;
  tracker?: TrackerAdapter | null;
  linearTaskModes?: boolean;
  linearAccess?: LinearTaskAccess;
  githubAuth?: HostGitHubAuth;
  files?: LinearFileTransfer | null;
  secretsDir?: string;
  catchUp?: () => Promise<void>;
  repository?: RepositoryBinding | null;
  repositories?: readonly RepositoryBinding[];
  repositoryAccess?: (
    repository: RepositoryBinding,
    signal: AbortSignal,
    access?: "read" | "write",
  ) => Promise<boolean>;
  repositoryToken?: (
    item: WorkItemRecord,
    repository: RepositoryBinding,
    signal: AbortSignal,
    access: "read" | "write",
  ) => Promise<string>;
  github?: GitHubBinding | null;
  githubForRepository?: (repository: RepositoryBinding) => GitHubBinding | null;
  launch?: AgentLaunch;
  clock?: Clock;
  /** Comment mode posts on the Linear issue. Agent-session mode keeps the session id. */
  channel?: "comments" | "agent-session";
  caps?: { maxTurns: number; maxAwakeMs: number };
  /** Sandbox for ACP spawns. The host path is unchanged when this is omitted. */
  docker?: { proxyUrl: string; image?: string; bin?: string };
};

type AnswerWaiter = (answer: string) => void;

/**
 * One process loop: intake, one item at a time, ACP, Closeout, pull request, serial merge.
 * Linear effects go through the outbox. State changes go through `transition()`.
 */
export class Orchestrator {
  readonly bus = new CommandBus();
  private tracker: TrackerAdapter | null;
  private catchUpFn: () => Promise<void>;
  private readonly waiters = new Map<string, AnswerWaiter>();
  private readonly live = new Map<
    string,
    {
      itemId: string;
      sessionId: string | null;
      generation: number;
      controller: AbortController;
      done: Promise<void>;
      finish(): void;
    }
  >();
  private readonly stopEvents = new Map<string, Promise<void>>();
  private readonly sessionEvents = new Map<string, Promise<void>>();
  private readonly conversations = new Map<
    string,
    (options: RunAgentOptions) => Promise<RunAgentResult>
  >();
  private shuttingDown = false;
  private activitySeq = 0;
  private readonly activityRequests = new Map<number, AbortSignal>();
  private readonly inputLoader: ReturnType<typeof createLinearInputLoader> | null;
  private readonly taskPlanner: ReturnType<typeof createTaskPlanner>;
  private readonly githubAuth: GitHubAuthQuestions | null;
  private readonly authRecoveryController = new AbortController();
  private authRecovery: Promise<void> | null = null;

  constructor(private readonly options: OrchestratorOptions) {
    this.tracker = options.tracker ?? null;
    this.githubAuth = options.githubAuth
      ? new GitHubAuthQuestions(
          options.db,
          options.githubAuth,
          () => this.now(),
          (item) =>
            !this.taskAccess(item) ||
            (item.sessionKey !== null &&
              getLinearSessionAccess(this.db, item.sessionKey) === "allowed"),
        )
      : null;
    this.inputLoader = options.files
      ? createLinearInputLoader({
          db: options.db,
          files: options.files,
          cacheDir: join(options.secretsDir ?? join(options.pawsRoot, "secrets"), "linear-inputs"),
        })
      : null;
    this.taskPlanner = createTaskPlanner({
      db: options.db,
      pawsRoot: options.pawsRoot,
      home: options.home,
      launch: (input) => this.launchAgent(input),
      profile: () =>
        resolveAgentProfiles(loadConfigFile(join(options.pawsRoot, "config.toml"))).implementer,
    });
    this.catchUpFn = options.catchUp ?? (() => Promise.resolve());
    this.bus.subscribe((command) => {
      this.githubAuth?.revoke(command.itemId);
      this.abortItem(command.itemId);
    });
    this.register();
  }

  setTracker(tracker: TrackerAdapter | null): void {
    this.tracker = tracker;
  }

  setCatchUp(catchUp: () => Promise<void>): void {
    this.catchUpFn = catchUp;
  }

  agentAlive = (runId: string): boolean => this.live.has(runId);

  async onLinearEvent(event: AcceptedLinearEvent): Promise<void> {
    if (this.shuttingDown) throw new Error("Paws is shutting down");
    if (event.signal === "stop") {
      const receiptKey = JSON.stringify(
        event.activityId ? ["activity", event.activityId] : ["event", event.dedupeKey],
      );
      const key = JSON.stringify([event.sessionId, receiptKey]);
      const previous = this.stopEvents.get(key);
      if (previous) return previous;
      const done = this.stopSession(event.sessionId, receiptKey, event.updatedAtMs);
      this.stopEvents.set(key, done);
      try {
        await done;
      } finally {
        if (this.stopEvents.get(key) === done) this.stopEvents.delete(key);
      }
      return;
    }
    if (event.action === "prompted" && !event.body?.trim()) return;
    if (
      event.action === "prompted" &&
      event.sessionId &&
      event.body !== null &&
      !findOpenQuestion(this.db, event.sessionId) &&
      this.options.channel !== "comments" &&
      !isGitHubIssue(event.issueId ?? event.sessionId)
    ) {
      const turn = this.recordTurn(event);
      if (turn && announceLinearTurn(this.db, event.sessionId, turn.eventKey, this.now())) {
        for (const live of this.live.values())
          if (this.itemsForSession(event.sessionId).some((item) => item.id === live.itemId))
            live.controller.abort(FOLLOW_UP_INTERRUPTION);
        await this.stopTaskPlanning(event.sessionId);
      }
    }
    const key = event.sessionId ?? event.issueId ?? event.dedupeKey;
    const previous = this.sessionEvents.get(key) ?? Promise.resolve();
    const done = previous.catch(() => undefined).then(() => this.handleLinearEvent(event));
    this.sessionEvents.set(key, done);
    try {
      await done;
    } finally {
      if (this.sessionEvents.get(key) === done) this.sessionEvents.delete(key);
    }
  }

  async interruptLinearSession(sessionId: string): Promise<void> {
    const items = this.itemsForSession(sessionId);
    for (const item of items) this.githubAuth?.revoke(item.id);
    const owned = [...this.live.values()].filter((live) =>
      items.some((item) => item.id === live.itemId),
    );
    for (const live of owned) live.controller.abort();
    const joined = await Promise.allSettled([
      this.stopTaskPlanning(sessionId),
      ...owned.map((live) => live.done),
    ]);
    if (items.some((item) => getConversation(this.db, item.id).blocked))
      throw new Error("ACP process cleanup could not be verified");
    const failure = joined.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.authRecoveryController.abort();
    this.githubAuth?.close();
    const owned = [...this.live.values()];
    for (const live of owned) live.controller.abort();
    const joined = await Promise.allSettled([
      this.authRecovery,
      this.stopTaskPlanning(),
      ...owned.map((live) => live.done),
    ]);
    await Promise.allSettled([...this.sessionEvents.values(), ...this.stopEvents.values()]);
    if (this.allItems().some((item) => getConversation(this.db, item.id).blocked))
      throw new Error("ACP process cleanup could not be verified");
    const failure = joined.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  recoverGitHubAuth(): Promise<void> {
    if (this.authRecovery) return this.authRecovery;
    const pending =
      this.githubAuth?.recover(this.authRecoveryController.signal) ?? Promise.resolve();
    this.authRecovery = pending;
    return pending.finally(() => {
      if (this.authRecovery === pending) this.authRecovery = null;
    });
  }

  private recordTurn(event: AcceptedLinearEvent) {
    if (!event.sessionId || event.body === null) return null;
    recordLinearSessionEvent(this.db, event, this.now());
    return recordLinearTurn(this.db, {
      eventKey: event.dedupeKey,
      activityId: event.activityId,
      sessionId: event.sessionId,
      actorId: "actorId" in event && typeof event.actorId === "string" ? event.actorId : null,
      body: event.body,
      payload: event.payload,
      createdAtMs:
        "activityCreatedAtMs" in event && typeof event.activityCreatedAtMs === "number"
          ? event.activityCreatedAtMs
          : event.updatedAtMs,
      now: this.now(),
    });
  }

  private async handleLinearEvent(event: AcceptedLinearEvent): Promise<void> {
    if (this.shuttingDown) throw new Error("Paws is shutting down");
    if (event.action === "prompted") {
      const question = event.sessionId ? findOpenQuestion(this.db, event.sessionId) : null;
      const questionItem = question ? getWorkItem(this.db, question.itemId) : null;
      const linearPrompt =
        this.options.channel !== "comments" &&
        event.sessionId &&
        !isGitHubIssue(event.sessionId) &&
        !isGitHubIssue(questionItem?.linearIssueId ?? event.issueId ?? "");
      if (linearPrompt && event.sessionId && event.body) {
        const session = recordLinearSessionEvent(this.db, event, this.now());
        if (questionItem && session && !session.epicId) {
          bindLinearSessionTask(this.db, event.sessionId, questionItem.epicId);
          activateLinearItem(this.db, event.sessionId, questionItem.id);
        }
        const turn = this.recordTurn(event);
        if (turn?.state !== "pending") return;
        event = { ...event, dedupeKey: turn.eventKey, body: turn.body, payload: turn.payload };
      }
      if (linearPrompt && !question && event.sessionId) {
        await this.resumeLinearSession(event.sessionId);
        return;
      }
      const outcome = await this.deliverPrompt(
        event,
        Boolean(
          linearPrompt &&
          questionItem &&
          question &&
          !isWorkItemRepositoryQuestion(this.db, questionItem.id, question.id) &&
          ["answer", "artifact"].includes(getTaskMode(this.db, questionItem.id) ?? ""),
        ),
      );
      if (linearPrompt && event.sessionId) {
        if (outcome === "rejected") discardLinearTurns(this.db, event.sessionId, [event.dedupeKey]);
        if (outcome === "redirect") await this.resumeLinearSession(event.sessionId);
      }
      return;
    }
    if (event.action !== "created" || event.issueId === null) return;
    if (event.sessionId !== null) {
      const context = parseLinearSessionContext(event.payload);
      saveLinearSessionContext(
        this.db,
        event.sessionId,
        renderLinearSessionContext(context),
        context.promptContext ? 2 : 1,
      );
    }
    const tracker = this.tracker;
    if (tracker === null) throw new Error("Linear is not connected");
    const session =
      this.options.channel !== "comments" && !isGitHubIssue(event.issueId)
        ? recordLinearSessionEvent(this.db, event, this.now())
        : null;
    const taskKey = session ? sessionTaskKey(this.db, session) : null;
    if (session?.stoppedAt !== null && session?.stoppedAt !== undefined) return;
    let result: IntakeResult;
    try {
      result = await this.intakeLinearTask(event.issueId, event.sessionId, taskKey ?? undefined);
    } catch (error) {
      const current = session ? getLinearSession(this.db, session.sessionId) : null;
      if (session && (current?.stoppedAt !== null || current.generation !== session.generation))
        return;
      throw error;
    }
    if (result.ok) {
      const caps = this.options.caps;
      if (caps !== undefined) {
        for (const saved of result.items) {
          configureWorkItem(this.db, saved.id, {
            maxTurns: caps.maxTurns,
            maxAwakeMs: caps.maxAwakeMs,
          });
        }
      }
      this.pump();
    }
    await this.flush();
  }

  sessionProgressReporter(event: AcceptedLinearEvent): TrackerAdapter["postProgress"] {
    const generation = event.sessionId
      ? getLinearSessionGeneration(this.db, event.sessionId)
      : undefined;
    return (update, request) =>
      this.enqueueSessionProgress(
        update,
        `ack:${event.dedupeKey}:${update.kind}`,
        (event.sessionId
          ? getLinearTurnGeneration(this.db, event.sessionId, event.dedupeKey, event.activityId)
          : null) ?? generation,
        request,
        event.action === "created" && update.kind === "thought",
      );
  }

  private async enqueueSessionProgress(
    update: ProgressUpdate,
    idempotencyKey: string,
    generation?: number,
    request?: TrackerRequestOptions,
    initialActivity = false,
  ): Promise<void> {
    request?.signal?.throwIfAborted();
    const id = enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "activity",
      orderingKey: update.sessionId,
      idempotencyKey,
      payload: { ...update, id: update.id ?? crypto.randomUUID() },
      ...(initialActivity ? { delivery: "critical" } : {}),
      ...(generation === undefined ? {} : { generation }),
      now: this.now(),
    });
    if (request?.signal) this.activityRequests.set(id, request.signal);
    try {
      await this.flush(request?.signal);
      request?.signal?.throwIfAborted();
    } finally {
      if (this.activityRequests.get(id) === request?.signal) this.activityRequests.delete(id);
    }
  }

  async intakeLinearTask(
    issueId: string,
    sessionId: string | null,
    taskKey?: string,
    options: { followupBodies?: readonly string[]; conversation?: string } = {},
  ) {
    const tracker = this.tracker;
    if (!tracker) throw new Error("Linear is not connected");
    const initialSession = sessionId ? getLinearSession(this.db, sessionId) : null;
    const isCurrent = () => {
      if (this.shuttingDown) return false;
      if (initialSession === null || sessionId === null) return true;
      const current = getLinearSession(this.db, sessionId);
      return current?.generation === initialSession.generation && current.stoppedAt === null;
    };
    if (!isCurrent()) throw new Error("The Linear request changed before intake");
    const savedRequest = taskKey ? getTaskClassification(this.db, taskKey) : null;
    const redirect = savedRequest?.mode !== "clarify" ? savedRequest?.redirect : undefined;
    if (redirect) taskKey = redirect.taskKey;
    const progressTracker =
      sessionId && this.options.channel !== "comments" && !isGitHubIssue(issueId)
        ? {
            ...tracker,
            postProgress: (update: ProgressUpdate) =>
              this.enqueueSessionProgress(
                update,
                `intake:${taskKey ?? issueId}:${update.kind}`,
                initialSession?.generation,
              ),
          }
        : tracker;
    let intakeTracker = progressTracker;
    const classification =
      this.options.linearTaskModes &&
      sessionId &&
      taskKey &&
      this.options.channel !== "comments" &&
      !isGitHubIssue(issueId)
        ? await this.taskPlanner.plan({
            taskKey,
            sessionId,
            request: async (signal) => {
              const snapshot = await tracker.loadEpic(issueId);
              signal.throwIfAborted();
              intakeTracker = { ...progressTracker, loadEpic: async () => snapshot };
              await this.hydrateLinearContext(sessionId, signal);
              const history = listLinearActivitySnapshots(this.db, sessionId)
                .map((raw) => JSON.parse(raw) as LinearActivitySnapshot)
                .filter((activity) => activity.content.type !== "thought" && !activity.ephemeral);
              return [
                JSON.stringify(snapshot),
                getLinearSessionContext(this.db, sessionId),
                JSON.stringify(history),
                options.conversation ?? "",
                ...(options.followupBodies ??
                  listPendingLinearTurns(this.db, sessionId).map((turn) => turn.body)),
              ].join("\n\n");
            },
          })
        : null;
    if (!isCurrent()) throw new Error("The Linear request changed before intake");
    const result = await intakeDelegatedIssue(this.db, intakeTracker, {
      linearIssueId: issueId,
      sessionId,
      isCurrent,
      onAccepted: (accepted) => {
        immediate(this.db, () => {
          if (redirect) {
            const previous = getWorkItem(this.db, redirect.itemId);
            if (previous && previous.state !== "cancelled") {
              applyWorkItemEvent(this.db, previous.id, "cancel");
              if (previous.currentRunId)
                markRun(this.db, previous.currentRunId, "ended", this.now());
              const epic = this.epicRow(previous.epicId);
              if (epic) {
                const retired = transitionEpic(epic.state, "cancel");
                if (retired.ok)
                  this.db.run("UPDATE epic SET state = ?, version = version + 1 WHERE id = ?", [
                    retired.to,
                    previous.epicId,
                  ]);
              }
              this.db.run(
                "UPDATE job SET status = 'cancelled', finished_at = ? WHERE status = 'pending' AND json_extract(payload,'$.itemId') = ?",
                [this.now(), previous.id],
              );
            }
          }
          if (accepted.ok && options.conversation)
            for (const child of accepted.items) {
              const stored = getConversation(this.db, child.id);
              if (stored.entries === "[]" && !stored.transcript)
                saveConversation(this.db, child.id, options.conversation, null);
            }
          if (sessionId !== null) {
            if (initialSession) bindLinearSessionTask(this.db, sessionId, accepted.epic.id);
            this.assignSession(accepted.epic.id, sessionId);
          }
          if (redirect && accepted.ok && this.options.caps)
            for (const child of accepted.items)
              configureWorkItem(this.db, child.id, {
                maxTurns: this.options.caps.maxTurns,
                maxAwakeMs: this.options.caps.maxAwakeMs,
              });
        });
      },
      ...(taskKey ? { taskKey } : {}),
      ...(classification && classification.mode !== "code" ? { singleIssue: true } : {}),
    });
    if (!isCurrent()) throw new Error("The Linear request changed during intake");
    if (result.ok && classification && classification.mode !== "clarify") {
      for (const item of result.items) {
        if (!getTaskMode(this.db, item.id))
          saveTaskMode(
            this.db,
            item.id,
            classification.mode,
            sessionId ? getLinearSessionGeneration(this.db, sessionId) : 0,
            classification.repository === true,
          );
      }
    }
    return result;
  }

  stopTaskPlanning = (sessionId?: string): Promise<void> => this.taskPlanner.stop(sessionId);

  private get db(): Database {
    return this.options.db;
  }

  private register(): void {
    const jobs = this.options.jobs;
    jobs.register(JOB_KIND.command, (_job) => {
      drainCommands(this.db, this.bus, this.now());
    });
    jobs.register(JOB_KIND.catchup, (job) => {
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "linear.catchup",
        idempotencyKey: `catchup:${job.id}:${job.attempts}`,
        payload: job.payload,
        now: this.now(),
      });
    });
    jobs.register(JOB_KIND.start, (job, context) =>
      this.executeQueued(job.payload, context.extendLease),
    );
    jobs.register(JOB_KIND.resume, (job, context) =>
      this.executeQueued(job.payload, context.extendLease),
    );
    jobs.register(JOB_KIND.reverify, (job) =>
      this.runOwnedJob(job.payload, () => this.reverify(job.payload)),
    );
    jobs.register(JOB_KIND.merge, async (job, context) => {
      const lease = setInterval(() => context.extendLease(60_000), 10_000);
      lease.unref?.();
      try {
        await this.runOwnedJob(job.payload, () => this.merge(job.payload));
      } finally {
        clearInterval(lease);
      }
    });
    this.options.outbox.setHandler(async (message, context) => {
      if (message.target !== "linear") return;
      const requestSignal = this.activityRequests.get(message.id);
      if (requestSignal)
        context = { ...context, signal: AbortSignal.any([context.signal, requestSignal]) };
      context.signal.throwIfAborted();
      const tracker = this.tracker;
      if (tracker === null) throw new Error("Linear is not connected");
      if (
        this.options.linearAccess &&
        this.options.channel !== "comments" &&
        message.orderingKey &&
        !isGitHubIssue(message.orderingKey) &&
        message.op !== "catchup" &&
        message.op !== "linear.catchup"
      ) {
        const itemId =
          readString(message.payload, "itemId") ??
          getLinearSession(this.db, message.orderingKey)?.activeItemId ??
          undefined;
        const issueId =
          readString(message.payload, "linearIssueId") ??
          readString(message.payload, "issueId") ??
          undefined;
        if (
          message.op === "status" &&
          (!itemId || !issueId || !getLinearTaskDelegation(this.db, itemId, issueId)?.humanActorId)
        )
          throw new Error("Linear workflow updates require verified human task ownership.");
        await this.options.linearAccess.assertDelivery(message.orderingKey, context.signal, {
          itemId,
          issueId,
          stop: message.delivery === "stop",
          isCurrent: context.isCurrent,
        });
      }
      await deliverLinearOutbox(message, tracker, () => this.catchUpFn(), context, this.db);
    });
  }

  private async executeQueued(
    payload: unknown,
    extendLease: (leaseMs?: number) => boolean,
  ): Promise<void> {
    if (this.shuttingDown) throw new Error("Paws is shutting down");
    const itemId = readString(payload, "itemId");
    if (itemId === null) return;
    const loaded = getWorkItem(this.db, itemId);
    if (loaded === null) return;
    if (loaded.cancelRequested || loaded.state === "cancelled") return;
    if (loaded.state === "awaiting_input" || loaded.state === "paused") return;
    const sessionId = linearSessionForEpic(this.db, loaded.epicId);
    if (sessionId) activateLinearItem(this.db, sessionId, loaded.id);
    if (loaded.state === "queued") applyWorkItemEvent(this.db, loaded.id, "dispatched");
    if (loaded.state === "recovering") applyWorkItemEvent(this.db, loaded.id, "recovered");
    const item = getWorkItem(this.db, loaded.id);
    if (item === null || item.state !== "running") return;

    const lease = setInterval(() => extendLease(60_000), 10_000);
    lease.unref?.();
    try {
      const handoff = readString(payload, "handoff") ?? undefined;
      if (
        this.options.linearTaskModes &&
        item.sessionKey &&
        !isGitHubIssue(item.linearIssueId) &&
        this.options.channel !== "comments"
      ) {
        if (!(await this.resolveTaskMode(item, handoff))) return;
        const mode = getTaskMode(this.db, item.id);
        if (mode === "answer" || mode === "artifact") {
          if (
            taskRequiresRepository(this.db, item.id) &&
            !(await this.selectRepository(item, "read"))
          )
            return;
          await this.runResponse(item, mode, handoff);
          return;
        }
      }
      if (!(await this.selectRepository(item))) return;
      await this.runItem(item, handoff);
    } finally {
      clearInterval(lease);
    }
  }

  private async resolveTaskMode(item: WorkItemRecord, handoff?: string): Promise<boolean> {
    if (getConversation(this.db, item.id).blocked)
      throw new Error("ACP process cleanup could not be verified");
    const saved = getTaskMode(this.db, item.id);
    const generation = item.sessionKey ? getLinearSessionGeneration(this.db, item.sessionKey) : 0;
    const taskKey = this.db
      .query<{ task_key: string }, [string]>("SELECT task_key FROM epic WHERE id = ?")
      .get(item.epicId)?.task_key;
    const classification = taskKey ? getTaskClassification(this.db, taskKey) : null;
    if (classification?.mode === "code" && classification.redirect) {
      await this.intakeLinearTask(this.epicIssueId(item.epicId)!, item.sessionKey, taskKey);
      this.pump();
      return false;
    }
    if (saved === "code") return true;
    if (
      saved &&
      taskRequiresRepository(this.db, item.id) &&
      getWorkItemRepositoryAnswer(this.db, item.id) &&
      !getWorkItemRepository(this.db, item.id)
    )
      return true;
    if (saved && (!handoff || getTaskModeGeneration(this.db, item.id) >= generation)) return true;
    if (!saved && (!classification || classification.mode !== "clarify")) {
      saveTaskMode(
        this.db,
        item.id,
        classification?.mode ?? "code",
        generation,
        classification?.repository === true,
      );
      return true;
    }
    const run = this.ensureRun(item);
    if (!handoff) {
      if (classification?.mode !== "clarify") throw new Error("Task clarification is missing");
      return this.requestTaskClarification(item, run.id, classification.question);
    }
    const live = this.beginLive(item.id, run.id);
    const controller = live.controller;
    try {
      const resolved = await classifyTask({
        itemId: itemPathId(item),
        runId: run.id,
        request: [this.workContext(item), getConversation(this.db, item.id).entries, handoff].join(
          "\n\n",
        ),
        pawsRoot: this.options.pawsRoot,
        home: this.options.home,
        profile: this.profileSnapshot(run.id).implementer,
        signal: controller.signal,
        launch: (input) => this.launchAgent(input),
        onCleanupFailure: () => {
          const stored = getConversation(this.db, item.id);
          saveConversation(
            this.db,
            item.id,
            stored.entries,
            stored.transcript,
            true,
            stored.transcriptOffset,
          );
        },
      });
      controller.signal.throwIfAborted();
      if (
        this.stopped(item.id) ||
        (item.sessionKey && getLinearSessionGeneration(this.db, item.sessionKey) !== generation)
      )
        return false;
      if (resolved.mode === "clarify")
        return this.requestTaskClarification(item, run.id, resolved.question);
      if (
        resolved.mode === "code" &&
        (classification?.mode === "clarify" || saved === "answer" || saved === "artifact") &&
        taskKey
      ) {
        const issueId = this.epicIssueId(item.epicId)!;
        const snapshot = await this.tracker!.loadEpic(issueId);
        controller.signal.throwIfAborted();
        if (
          this.stopped(item.id) ||
          (item.sessionKey && getLinearSessionGeneration(this.db, item.sessionKey) !== generation)
        )
          return false;
        if (snapshot.subIssues.length) {
          resolveTaskClassification(this.db, {
            taskKey,
            itemId: item.id,
            context: [this.workContext(item), handoff].join("\n\n"),
          });
          await this.intakeLinearTask(issueId, item.sessionKey, taskKey);
          this.pump();
          return false;
        }
      }
      if (saved)
        selectTaskModeForTurn(
          this.db,
          item.id,
          resolved.mode,
          generation,
          resolved.repository === true,
        );
      else saveTaskMode(this.db, item.id, resolved.mode, generation, resolved.repository === true);
      return true;
    } finally {
      this.live.delete(run.id);
      live.finish();
    }
  }

  private async requestTaskClarification(
    item: WorkItemRecord,
    runId: string,
    body: string,
  ): Promise<false> {
    const sessionId = this.activitySession(item);
    if (!sessionId) throw new Error("Task clarification requires a Linear session");
    immediate(this.db, () => {
      const current = getWorkItem(this.db, item.id);
      if (current?.state !== "running" || current.cancelRequested)
        throw new Error("The task changed before clarification");
      const question = openQuestion(this.db, {
        itemId: item.id,
        runId,
        sessionId,
        body,
        options: [],
        now: this.now(),
      });
      applyWorkItemEvent(this.db, item.id, "blocking_question");
      markRunEnded(this.db, runId, this.now());
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "elicitation",
        orderingKey: sessionId,
        idempotencyKey: `task-clarification:${question.id}`,
        payload: { sessionId, questionId: question.id, body: question.body, options: [] },
        now: this.now(),
      });
    });
    await this.flush();
    return false;
  }

  private async runResponse(
    item: WorkItemRecord,
    mode: "answer" | "artifact",
    handoff?: string,
  ): Promise<void> {
    const run = this.ensureRun(item);
    const profile = this.profileSnapshot(run.id).implementer;
    const live = this.beginLive(item.id, run.id);
    const controller = live.controller;
    const workspace = join(this.options.pawsRoot, "tasks", item.id, mode);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const sessionProgress = this.sessionProgress(item, mode);
    sessionProgress?.phase("working");
    const activity = createAcpActivityReporter(
      (update) => {
        if (
          !controller.signal.aborted &&
          this.canReportProgress(item.id) &&
          update.kind !== "elicitation"
        )
          this.post(
            item,
            update.kind,
            update.body,
            `${run.id}:answer:${++this.activitySeq}`,
            update,
          );
      },
      (steps) => {
        if (!controller.signal.aborted && this.canReportProgress(item.id))
          sessionProgress?.plan(steps);
      },
    );
    const keepAlive = setInterval(() => {
      if (this.canReportProgress(item.id)) {
        this.post(
          item,
          "thought",
          "Preparing the requested answer.",
          `${run.id}:keep:${this.now()}`,
          { ephemeral: true },
        );
        void this.flush();
      }
    }, KEEPALIVE_MS);
    keepAlive.unref?.();
    try {
      await this.taskAccess(item)?.assert(item, controller.signal, { allowTerminalIssue: true });
      const promptRunner = await this.prepareConversation(item);
      let repositoryContext = "";
      if (taskRequiresRepository(this.db, item.id)) {
        const repository = getWorkItemRepository(this.db, item.id);
        if (repository === null) throw new Error("The requested repository has not been selected");
        const auth = this.authorization(item);
        if (auth && !(await auth.ensure(item, "initial", controller.signal))) return;
        const source = await prepareRepositorySnapshot({
          ...repository,
          workspace,
          networkGit: this.repositoryGit(item, repository, controller.signal, "read"),
          signal: controller.signal,
          onCleanupFailure: () => this.blockConversation(item.id),
        });
        controller.signal.throwIfAborted();
        repositoryContext = `The selected repository ${repository.owner}/${repository.repo} is available in ./repository at commit ${source.commit}. Use this private source snapshot for the requested explanation or deliverable. Publish deliverable paths relative to this workspace and return the complete answer or file links.`;
      }
      await this.hydrateLinearContext(item.sessionKey, controller.signal);
      const prompt = [
        mode === "answer"
          ? "Answer the user's request in this Linear conversation. Provide the complete answer in your final message."
          : "Create the requested deliverable files in this workspace, publish them using publish_artifact, and include the published file links in your complete final response.",
        "Use ask_team when a product decision is required.",
        repositoryContext,
        this.workContext(item),
        handoff ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const launched = this.launchAgent({
        role: "implementer",
        profile,
        purpose: mode,
        itemId: itemPathId(item),
        worktree: workspace,
        prompt,
      });
      const result = await promptRunner({
        ...launched,
        role: "implementer",
        profile,
        itemId: itemPathId(item),
        runId: run.id,
        worktreePath: workspace,
        pawsRoot: this.options.pawsRoot,
        home: this.options.home,
        prompt,
        readOnly: mode === "answer",
        publishArtifact: mode === "artifact" ? this.artifactPublisher(item) : undefined,
        checkpoint: false,
        signal: controller.signal,
        askTeam: this.askHook(item, run.id),
        prepareInputFiles: this.prepareInputFiles(item, run.id),
        onEvent: activity.onEvent,
      });
      controller.signal.throwIfAborted();
      if (this.stopped(item.id)) return;
      if (
        result.stopReason !== "end_turn" ||
        result.authRequired ||
        !result.agentExited ||
        result.errorMessage
      )
        throw new Error(result.errorMessage ?? `Answer stopped (${result.stopReason})`);
      activity.flush();
      if (mode === "artifact") {
        const links = listArtifacts(this.db, item.id)
          .filter((artifact) => artifact.state === "uploaded")
          .map(
            (artifact) =>
              `[${artifact.displayName.replace(/[\\[\]]/g, "\\$&")}](<${artifact.assetUrl}>)`,
          );
        completeArtifactTask(
          this.db,
          item.id,
          [activity.resultBody(), ...links].join("\n\n"),
          this.now(),
        );
      } else completeAnswerTask(this.db, item.id, activity.resultBody(), this.now());
      sessionProgress?.phase("completed");
      this.pump();
    } catch (error) {
      if (
        !this.stopped(item.id) &&
        !controller.signal.aborted &&
        getWorkItem(this.db, item.id)?.state !== "awaiting_input"
      )
        this.fail(item, "answer_error", error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(keepAlive);
      this.live.delete(run.id);
      live.finish();
      await this.flush();
    }
  }

  private async runItem(item: WorkItemRecord, handoff?: string): Promise<void> {
    const repository = this.repositoryForItem(item);
    if (repository === null || repository === undefined) {
      this.fail(item, "no_repository", "PAWS_GITHUB_REPOSITORY is not set.");
      return;
    }
    if (this.stopped(item.id)) return;
    const pathId = itemPathId(item);
    const branch = worktreeBranch(item);
    if (item.branchName !== branch) {
      this.db.run("UPDATE work_item SET branch_name = ? WHERE id = ?", [branch, item.id]);
    }
    const run = this.ensureRun(item);
    const profiles = this.profileSnapshot(run.id);
    const live = this.beginLive(item.id, run.id);
    const controller = live.controller;
    let posted = true;
    const first = setTimeout(() => {
      if (posted || !this.canReportProgress(item.id)) return;
      posted = true;
      this.post(item, "thought", `Working on ${item.linearIdentifier}.`, `${run.id}:first`, {
        ephemeral: true,
      });
      void this.flush();
    }, FIRST_ACTIVITY_MS);
    const keepAlive = setInterval(() => {
      if (!this.canReportProgress(item.id)) return;
      this.post(
        item,
        "thought",
        `Still working on ${item.linearIdentifier}.`,
        `${run.id}:keep:${this.now()}`,
        { ephemeral: true },
      );
      void this.flush();
    }, KEEPALIVE_MS);
    first.unref?.();
    keepAlive.unref?.();
    const askTeam = this.askHook(item, run.id);
    const sessionProgress = this.sessionProgress(item);
    const activity = createAcpActivityReporter(
      (update) => {
        if (
          controller.signal.aborted ||
          !this.canReportProgress(item.id) ||
          update.kind === "elicitation"
        )
          return;
        posted = true;
        this.activitySeq += 1;
        this.post(item, update.kind, update.body, `${run.id}:acp:${this.activitySeq}`, update);
      },
      (steps) => {
        if (!controller.signal.aborted && this.canReportProgress(item.id))
          sessionProgress?.plan(steps);
      },
    );

    try {
      await this.taskAccess(item)?.assert(item, controller.signal);
      const auth = this.authorization(item);
      if (auth && !(await auth.ensure(item, "initial", controller.signal))) return;
      await this.taskAccess(item)?.prepare(item, controller.signal);
      this.post(item, "action", `Working on ${item.linearIdentifier}.`, `${run.id}:working`, {
        ephemeral: true,
      });
      sessionProgress?.phase("implementing");
      if (!this.taskAccess(item)) this.postStatus(item, "started");
      const promptRunner = await this.prepareConversation(item);
      await this.hydrateLinearContext(item.sessionKey, controller.signal);
      const prompt = implementPrompt({
        identifier: item.linearIdentifier,
        title: item.title,
        brief: this.workContext(item),
        ...(handoff ? { handoff } : {}),
      });
      await this.flush();
      if (this.stopped(item.id)) return;
      try {
        await this.preflight(item, run.id, profiles, controller.signal);
      } catch (error) {
        if (this.stopped(item.id) || getWorkItem(this.db, item.id)?.state === "awaiting_input")
          return;
        markRunEnded(this.db, run.id, this.now());
        this.post(
          item,
          "thought",
          `Closeout: blocked\nreviewer failed: ${error instanceof Error ? error.message : String(error)}`,
          `${run.id}:profile-preflight`,
        );
        await this.askCloseoutHelp(
          item,
          undefined,
          `Closeout: blocked\nreviewer failed: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }
      const launched = this.launchAgent({
        role: "implementer",
        profile: profiles.implementer,
        purpose: "implement",
        itemId: pathId,
        worktree: worktreePath(this.options.pawsRoot, pathId),
        prompt,
      });

      const executed = await executeItem({
        role: "implementer",
        profile: profiles.implementer,
        itemId: pathId,
        runId: run.id,
        prompt,
        owner: repository.owner,
        repo: repository.repo,
        remoteUrl: repository.remoteUrl,
        networkGit: this.repositoryGit(item, repository, controller.signal, "write"),
        pawsRoot: this.options.pawsRoot,
        home: this.options.home ?? homedir(),
        signal: controller.signal,
        promptRunner,
        askTeam,
        publishArtifact: this.artifactPublisher(item),
        prepareInputFiles: this.prepareInputFiles(item, run.id),
        onEvent: activity.onEvent,
        ...(launched.command ? { command: launched.command, args: launched.args ?? [] } : {}),
        ...(launched.env ? { env: launched.env } : {}),
        ...this.itemDocker(profiles.implementer.agent),
      });
      controller.signal.throwIfAborted();
      const finished = getWorkItem(this.db, item.id);
      if (finished === null || finished.state === "cancelled" || finished.cancelRequested) return;
      if (executed.run.authRequired) {
        this.fail(finished, "auth", executed.run.errorMessage ?? "Claude login is missing.");
        return;
      }
      if (executed.run.cancelled || executed.run.stopReason === "cancelled") return;
      if (executed.run.stopReason !== "end_turn") {
        this.fail(
          finished,
          executed.run.stopReason,
          executed.run.errorMessage ?? `Run stopped (${executed.run.stopReason}).`,
        );
        return;
      }
      activity.flush();
      if (!artifactPublicationReady(this.db, item.id))
        throw new Error("A requested artifact has not been uploaded successfully");
      saveRunResult(this.db, run.id, activity.resultBody(), this.now());
      if (!executed.run.identity)
        throw new Error("Implementer did not report a concrete session model");
      this.saveCandidate(run.id, executed.run.identity);
      const head = (await git(["-C", executed.worktreePath, "rev-parse", "HEAD"])).trim();
      const base = (
        await git(["-C", executed.worktreePath, "merge-base", "HEAD", "origin/main"])
      ).trim();
      saveCheckpoint(this.db, item.id, { phase: "running", baseSha: base, wipCommit: head });
      markRunEnded(this.db, run.id, this.now());
      await this.verify(finished, executed.worktreePath, base, head, this.candidateFor(run.id));
    } catch (error) {
      const current = getWorkItem(this.db, item.id);
      if (
        !controller.signal.aborted &&
        current &&
        current.state !== "cancelled" &&
        current.state !== "awaiting_input" &&
        !current.cancelRequested
      ) {
        const message = error instanceof Error ? error.message : String(error);
        this.fail(current, "run_error", message);
      }
    } finally {
      activity.flush();
      clearTimeout(first);
      clearInterval(keepAlive);
      this.conversations.delete(item.id);
      try {
        await this.flush();
      } finally {
        this.live.delete(run.id);
        live.finish();
      }
    }
  }

  private async verify(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
    candidate: CandidateIdentity,
  ): Promise<void> {
    const current = getWorkItem(this.db, item.id);
    if (current === null || current.state !== "running") return;
    applyWorkItemEvent(this.db, item.id, "turn_ended");
    const verifying = getWorkItem(this.db, item.id);
    if (verifying === null) return;
    saveCheckpoint(this.db, item.id, { phase: "verifying", baseSha: base, wipCommit: head });
    const verdict = await this.runVerification(item, worktree, base, head, candidate);
    if (this.signalForItem(item.id)?.aborted) return;
    const after = getWorkItem(this.db, item.id);
    if (after === null || after.state === "cancelled") return;
    if (verdict.decision === "accepted" && !verdict.exhausted) {
      const acceptedHead = (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();
      applyWorkItemEvent(this.db, item.id, "closeout_accepted");
      saveCheckpoint(this.db, item.id, {
        phase: "merge_queue",
        baseSha: base,
        wipCommit: acceptedHead,
      });
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.merge,
        lane: MERGE_LANE,
        jobKey: `merge:${item.id}:${acceptedHead}`,
        payload: { itemId: item.id, summary: verdict.summary, head: acceptedHead },
        now: this.now(),
      });
      return;
    }
    await this.askCloseoutHelp(after, verdict.result, verdict.summary);
  }

  private async runVerification(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
    candidate: CandidateIdentity,
  ): Promise<CloseoutVerdict> {
    this.sessionProgress(item)?.phase("verifying");
    const deps = this.agentDeps(item);
    const onCandidate = deps.onCandidate;
    deps.onCandidate = (identity) => {
      if (deps.signal?.aborted) return;
      Object.assign(candidate, identity);
      onCandidate?.(identity);
    };
    const gate = createCloseoutGate({
      candidate,
      reviewer: createAcpCodexReviewer(deps),
      fixer: createAcpFixRunner(deps),
      recorder: {
        record: async (verdict) => {
          if (deps.signal?.aborted) return;
          this.post(
            item,
            "thought",
            verdict.summary,
            `${item.id}:verdict:${listCloseoutRecoveries(this.db, item.id).length}:${verdict.head}:${verdict.outcome}:${verdict.evaluations}:${verdict.fixAttempts}`,
          );
        },
      },
      reportDir: `${this.options.pawsRoot}/runs/${itemPathId(item)}`,
      ...this.closeoutHome(),
      ...recoveryOptions(this.db, item.id),
      progress: createDbCloseoutProgress(this.db, item.id, () => this.now()),
    });
    return gate.run({
      taskId: itemPathId(item),
      worktree,
      baseSha: base,
      headSha: head,
      attempt: 1,
    });
  }

  private async askCloseoutHelp(
    item: WorkItemRecord,
    result: GateResult | undefined,
    summary: string,
  ): Promise<void> {
    if (this.stopped(item.id)) return;
    const sessionId = this.activitySession(item);
    if (sessionId === null) throw new Error("Closeout recovery has no tracker session");
    let retryBaseline: string[] = [];
    try {
      retryBaseline = await snapshotRetryBaseline(itemPathId(item), this.options.pawsRoot);
    } catch {}
    const context = {
      itemId: item.id,
      taskId: itemPathId(item),
      base: result?.base ?? item.checkpoint?.baseSha ?? "",
      head: result?.head ?? item.checkpoint?.wipCommit ?? "",
      policyDigest: result?.decision?.policy.digest ?? "",
      failedChecks:
        result?.decision?.items
          .filter(
            (check) =>
              bypassable(check.state) &&
              !result.bypasses?.some((approval) => approval.checkIds.includes(check.id)),
          )
          .map((check) => check.id) ?? [],
      retryBaseline,
      summary,
    };
    this.openCloseoutQuestion(item, sessionId, context);
    await this.flush();
  }

  private openCloseoutQuestion(
    item: WorkItemRecord,
    sessionId: string,
    context: Omit<CloseoutRecovery, "questionId" | "answer" | "answeredBy">,
    error?: string,
  ): void {
    immediate(this.db, () => {
      const current = getWorkItem(this.db, item.id);
      if (!current || current.state === "cancelled") return;
      if (findOpenQuestion(this.db, sessionId) !== null) return;
      const body = recoveryQuestion(context, error);
      const question = openQuestion(this.db, {
        itemId: item.id,
        runId: item.currentRunId,
        sessionId,
        body,
        now: this.now(),
      });
      saveCloseoutRecovery(this.db, { ...context, questionId: question.id });
      if (current.state !== "awaiting_input")
        applyWorkItemEvent(this.db, item.id, "blocking_question");
      saveCheckpoint(this.db, item.id, {
        phase: "awaiting_input",
        baseSha: context.base,
        wipCommit: context.head,
      });
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "elicitation",
        orderingKey: sessionId,
        idempotencyKey: `closeout-help:${question.id}`,
        payload: { sessionId, questionId: question.id, body },
        now: this.now(),
      });
    });
  }

  private async reverify(payload: unknown): Promise<void> {
    const itemId = readString(payload, "itemId");
    if (itemId === null) return;
    const item = getWorkItem(this.db, itemId);
    if (item === null) return;
    const repository = this.repositoryForItem(item);
    if (repository === null || repository === undefined) {
      this.fail(item, "no_repository", "PAWS_GITHUB_REPOSITORY is not set.");
      return;
    }
    const worktree = worktreePath(this.options.pawsRoot, itemPathId(item));
    let head = "";
    let base = item.checkpoint?.baseSha ?? "";
    try {
      head = (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();
      if (base === "") {
        base = (await git(["-C", worktree, "merge-base", "HEAD", "origin/main"])).trim();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.fail(item, "reverify", message);
      return;
    }
    if (item.state !== "verifying" && item.state !== "merge_queue") return;
    const candidate = await this.candidateForItem(item);
    if (!candidate) return;
    const verdict = await this.runVerification(item, worktree, base, head, candidate);
    if (this.stopped(item.id)) return;
    if (verdict.decision !== "accepted") {
      await this.askCloseoutHelp(item, verdict.result, verdict.summary);
      return;
    }
    if (item.state === "verifying") applyWorkItemEvent(this.db, item.id, "closeout_accepted");
    head = (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();
    saveCheckpoint(this.db, item.id, { phase: "merge_queue", baseSha: base, wipCommit: head });
    enqueueJobOnce(this.db, {
      queue: JOB_KIND.merge,
      lane: MERGE_LANE,
      jobKey: `merge:${item.id}:${head}`,
      payload: { itemId: item.id, summary: verdict.summary, head },
      now: this.now(),
    });
  }

  private async merge(payload: unknown): Promise<void> {
    const itemId = readString(payload, "itemId");
    if (itemId === null) return;
    const item = getWorkItem(this.db, itemId);
    if (
      item === null ||
      item.state === "cancelled" ||
      item.state === "merged" ||
      item.state === "completed"
    )
      return;
    if (getConfirmedRemoteMerge(this.db, item.id)) {
      if (item.state === "merge_queue") {
        applyWorkItemEvent(this.db, item.id, "merge_accepted");
        this.pump();
      }
      return;
    }
    const repository = this.repositoryForItem(item);
    const configuredGitHub = repository === null ? null : this.githubForRepository(repository);
    if (
      repository === null ||
      repository === undefined ||
      configuredGitHub === null ||
      configuredGitHub === undefined
    ) {
      this.fail(item, "no_github", "GitHub App is not configured.");
      return;
    }
    if (item.state !== "merge_queue") return;
    const live = this.live.get(`operation:${item.id}`);
    if (!live) throw new Error("GitHub publication has no owned operation.");
    const github = guardGitHubPublication({
      github: configuredGitHub,
      repository,
      signal: live.controller.signal,
      onCleanupFailure: () => {
        const stored = getConversation(this.db, item.id);
        saveConversation(this.db, item.id, stored.entries, stored.transcript, true);
      },
      isCurrent: () =>
        !this.stopped(item.id) &&
        (live.sessionId === null ||
          getLinearSessionGeneration(this.db, live.sessionId) === live.generation),
      assert: async () => {
        await this.taskAccess(item)?.assert(item, live.controller.signal);
        const auth = this.authorization(item);
        if (auth && !(await auth.ensure(item, "publication", live.controller.signal)))
          throw new Error("GitHub sign-in is required before publication.");
      },
    });
    const candidate = await this.candidateForItem(item);
    if (!candidate) return;
    const worktree = worktreePath(this.options.pawsRoot, itemPathId(item));
    const summary = readString(payload, "summary") ?? "Closeout accepted.";
    if (this.stopped(item.id)) return;
    if (!artifactPublicationReady(this.db, item.id)) {
      this.fail(
        item,
        "artifact_upload",
        "A requested artifact has not been uploaded successfully.",
      );
      return;
    }
    this.sessionProgress(item)?.phase("publishing");
    const published = await publishAccepted({
      accepted: true,
      evidence: summary,
      worktree,
      issue: publishIssueKey(item),
      branchKey: itemPathId(item),
      owner: repository.owner,
      repo: repository.repo,
      title: item.title,
      client: github.client,
      gitExec: github.gitExec,
      remoteUrl: repository.remoteUrl,
      ...this.gitHubCredentials(github),
    });
    if (this.stopped(item.id)) return;
    if (getWorkItem(this.db, item.id)?.state === "awaiting_input") return;
    if (!published.published) {
      this.fail(item, "publish", published.reason);
      return;
    }
    this.post(
      item,
      "thought",
      `Opened ${published.pull.url ?? `pull request #${published.pull.number}`}.`,
      `${item.id}:pr:${published.pull.number}`,
    );
    const sessionProgress = this.sessionProgress(item);
    if (published.pull.url) sessionProgress?.link("Pull request", published.pull.url);
    sessionProgress?.phase("merging");
    let closeoutFailure: CloseoutVerdict | null = null;
    const merged = await serialMerge({
      worktree,
      issue: isGitHubIssue(item.linearIssueId) ? itemPathId(item) : item.linearIdentifier,
      branchKey: itemPathId(item),
      owner: repository.owner,
      repo: repository.repo,
      prNumber: published.pull.number,
      appId: github.appId,
      installationId: github.installationId,
      privateKeyPem: github.privateKeyPem,
      client: github.client,
      gitExec: github.gitExec,
      ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
      remoteUrl: repository.remoteUrl,
      isCancelled: () => this.stopped(item.id) || !artifactPublicationReady(this.db, item.id),
      onWait: async (message) => {
        this.post(item, "thought", message, `${item.id}:merge-wait:${message}`);
        await this.flush();
      },
      reverify: async (input) => {
        const verdict = await this.runVerification(
          item,
          input.worktree,
          input.base,
          input.head,
          candidate,
        );
        if (verdict.decision !== "accepted") closeoutFailure = verdict;
        const filesReady = artifactPublicationReady(this.db, item.id);
        return {
          accepted: verdict.decision === "accepted" && filesReady,
          outcome:
            verdict.decision === "accepted"
              ? filesReady
                ? "merged"
                : "blocked"
              : verdict.exhausted
                ? "exhausted"
                : verdict.decision,
          summary: filesReady ? verdict.summary : "A requested artifact has not been uploaded.",
        };
      },
    });
    if (merged.merged)
      recordConfirmedRemoteMerge(this.db, {
        itemId: item.id,
        repositoryOwner: repository.owner,
        repositoryName: repository.repo,
        pullNumber: published.pull.number,
        pullUrl: published.pull.url,
        mergeSha: merged.sha ?? null,
        confirmedAt: this.now(),
      });
    if (this.stopped(item.id)) {
      if (merged.merged && getWorkItem(this.db, item.id)?.state === "merge_queue")
        applyWorkItemEvent(this.db, item.id, "merge_accepted");
      return;
    }
    if (!merged.merged && getWorkItem(this.db, item.id)?.state === "awaiting_input") return;
    if (!merged.merged) {
      if (closeoutFailure !== null) {
        const failure = closeoutFailure as CloseoutVerdict;
        await this.askCloseoutHelp(item, failure.result, failure.summary);
        return;
      }
      this.post(
        item,
        "thought",
        merged.message ?? merged.outcome,
        `${item.id}:merge:${merged.outcome}`,
      );
      if (
        item.state === "merge_queue" &&
        (merged.outcome === "sha_moved" || merged.outcome === "rejected")
      ) {
        applyWorkItemEvent(this.db, item.id, "main_moved");
        enqueueJobOnce(this.db, {
          queue: JOB_KIND.reverify,
          jobKey: `reverify:${item.id}:${merged.head ?? "again"}`,
          payload: { itemId: item.id },
          now: this.now(),
        });
        return;
      }
      this.fail(item, "merge", merged.message ?? merged.outcome);
      return;
    }
    this.post(item, "thought", `Merged ${item.linearIdentifier}.`, `${item.id}:merged`);
    applyWorkItemEvent(this.db, item.id, "merge_accepted");
    sessionProgress?.phase("completed");
    this.postStatus(item, "completed");
    await removeWorktree({
      owner: repository.owner,
      repo: repository.repo,
      itemId: itemPathId(item),
      pawsRoot: this.options.pawsRoot,
    }).catch(() => undefined);
    this.pump();
    await this.flush();
  }

  private askHook(item: WorkItemRecord, runId: string): AskTeamHook {
    return {
      ask: async (request, context) => {
        const sessionId = this.activitySession(item);
        if (sessionId === null) {
          throw new Error("ask_team has no Linear session");
        }
        const options = request.options ?? [];
        const question = immediate(this.db, () => {
          const opened = openQuestion(this.db, {
            itemId: item.id,
            runId,
            sessionId,
            body: [request.question.trim(), request.context?.trim()].filter(Boolean).join("\n\n"),
            options,
            now: this.now(),
          });
          const current = getWorkItem(this.db, item.id);
          if (current?.state === "running") {
            applyWorkItemEvent(this.db, item.id, "blocking_question");
            saveCheckpoint(this.db, item.id, {
              phase: "awaiting_input",
              ...(current.checkpoint?.wipCommit ? { wipCommit: current.checkpoint.wipCommit } : {}),
              ...(current.checkpoint?.baseSha ? { baseSha: current.checkpoint.baseSha } : {}),
            });
          }
          enqueueOutboxOnce(this.db, {
            target: "linear",
            op: "elicitation",
            orderingKey: sessionId,
            idempotencyKey: `ask:${opened.id}`,
            payload: {
              id: opened.id,
              sessionId,
              questionId: opened.id,
              body: elicitationBody(request.question, request.context),
              options,
            },
            now: this.now(),
          });
          return opened;
        });
        const answer = await new Promise<string>((resolve, reject) => {
          const onAbort = () => {
            this.waiters.delete(question.id);
            reject(new Error("cancelled"));
          };
          if (context.signal.aborted) {
            onAbort();
            return;
          }
          context.signal.addEventListener("abort", onAbort, { once: true });
          this.waiters.set(question.id, (value) => {
            context.signal.removeEventListener("abort", onAbort);
            resolve(value);
          });
          void this.flush().catch((error: unknown) => {
            this.waiters.delete(question.id);
            reject(error instanceof Error ? error : new Error(String(error)));
          });
        });
        return { answer };
      },
    };
  }

  private async deliverPrompt(
    event: AcceptedLinearEvent,
    redirect = false,
  ): Promise<"answered" | "redirect" | "rejected"> {
    const sessionId = event.sessionId;
    const answer = event.body?.trim() ?? "";
    if (sessionId === null || answer === "") return "rejected";
    if (questionReplyConsumed(this.db, sessionId, event.dedupeKey)) return "rejected";
    const open = findOpenQuestion(this.db, sessionId);
    if (open === null) return "rejected";
    const createdAt =
      event.activityCreatedAtMs === undefined ? event.updatedAtMs : event.activityCreatedAtMs;
    if (createdAt === null || createdAt <= open.createdAt) return "rejected";
    const recovery = listCloseoutRecoveries(this.db, open.itemId).find(
      (entry) => entry.questionId === open.id,
    );
    let answeredBy = event.actorId ?? "unknown";
    try {
      const payload = JSON.parse(event.payload) as {
        answeredBy?: unknown;
        questionId?: unknown;
        agentActivity?: unknown;
      };
      if (typeof payload.questionId === "string" && payload.questionId !== open.id)
        return "rejected";
      if (
        payload.agentActivity === undefined &&
        typeof payload.questionId === "string" &&
        typeof payload.answeredBy === "string" &&
        payload.answeredBy.trim()
      )
        answeredBy = payload.answeredBy;
    } catch {}
    if (answeredBy === "unknown" || answeredBy === "linear" || !answeredBy.trim())
      return "rejected";
    if (this.githubAuth?.owns(open.id)) {
      const accepted = await this.githubAuth.retry(open.id, answeredBy, () => {
        if (getLinearSession(this.db, sessionId)?.activeItemId === open.itemId)
          applyLinearTurns(this.db, sessionId, [event.dedupeKey], open.itemId);
      });
      await this.flush();
      return accepted ? "answered" : "rejected";
    }
    if (recovery) {
      const parsed = parseRecoveryAnswer(answer, recovery.failedChecks);
      const item = getWorkItem(this.db, open.itemId);
      if (item === null || item.state !== "awaiting_input") return "rejected";
      const outcome = immediate(this.db, () => {
        if (
          answerQuestion(this.db, open.id, {
            answer,
            answeredBy,
            eventKey: event.dedupeKey,
            now: this.now(),
          }) === null
        )
          return "rejected";
        if (parsed === null) {
          this.openCloseoutQuestion(
            item,
            sessionId,
            recovery,
            "Use /paws bypass check-id -- your reason from an identifiable trusted account, or reply with guidance.",
          );
          return "rejected";
        }
        if (getLinearSession(this.db, sessionId)?.activeItemId === item.id)
          applyLinearTurns(this.db, sessionId, [event.dedupeKey], item.id);
        applyWorkItemEvent(this.db, item.id, "answer_received");
        if (parsed.kind === "bypass") {
          applyWorkItemEvent(this.db, item.id, "turn_ended");
          saveCheckpoint(this.db, item.id, {
            phase: "verifying",
            baseSha: recovery.base,
            wipCommit: recovery.head,
          });
          enqueueJobOnce(this.db, {
            queue: JOB_KIND.reverify,
            jobKey: `closeout-bypass:${open.id}`,
            payload: { itemId: item.id },
            now: this.now(),
          });
        } else {
          enqueueJobOnce(this.db, {
            queue: JOB_KIND.resume,
            jobKey: `closeout-guidance:${open.id}`,
            payload: {
              itemId: item.id,
              freshSession: true,
              handoff: handoffNote({ question: recovery.summary, answer: parsed.body }),
              reason: "closeout-guidance",
            },
            now: this.now(),
          });
        }
        return "answered" as const;
      });
      await this.flush();
      return outcome;
    }
    const outcome = immediate(this.db, () => {
      const item = getWorkItem(this.db, open.itemId);
      if (item?.state !== "awaiting_input") return "rejected" as const;
      if (
        answerQuestion(this.db, open.id, {
          answer,
          answeredBy,
          eventKey: event.dedupeKey,
          now: this.now(),
        }) === null
      )
        return "rejected" as const;
      applyWorkItemEvent(this.db, item.id, "answer_received");
      if (redirect) {
        announceLinearTurn(this.db, sessionId, event.dedupeKey, this.now());
        for (const live of this.live.values())
          if (live.itemId === open.itemId) live.controller.abort(FOLLOW_UP_INTERRUPTION);
        return "redirect" as const;
      }
      if (getLinearSession(this.db, sessionId)?.activeItemId === open.itemId)
        applyLinearTurns(this.db, sessionId, [event.dedupeKey], open.itemId);
      if (this.waiters.has(open.id)) return "answered" as const;
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.resume,
        jobKey: `resume:answer:${open.id}`,
        payload: {
          itemId: open.itemId,
          freshSession: true,
          handoff: handoffNote({ question: open.body, options: open.options, answer }),
          reason: "answer",
        },
        now: this.now(),
      });
      return "answered" as const;
    });
    if (outcome === "answered") {
      const waiter = this.waiters.get(open.id);
      this.waiters.delete(open.id);
      waiter?.(answer);
    }
    await this.flush();
    return outcome;
  }

  private async stopSession(sessionId: string | null, eventKey: string, at: number): Promise<void> {
    if (sessionId === null) return;
    const requestedAt = at > 0 ? at : this.now();
    const agentSession = this.options.channel !== "comments" && !isGitHubIssue(sessionId);
    const commands: LinearCommand[] = [];
    const accepted = immediate(this.db, () => {
      if (agentSession && acceptLinearStop(this.db, sessionId, eventKey, requestedAt) === null)
        return false;
      const items = this.itemsForSession(sessionId);
      if (items.length === 0 && agentSession)
        enqueueOutboxOnce(this.db, {
          target: "linear",
          op: "activity",
          orderingKey: sessionId,
          delivery: "stop",
          generation: getLinearSessionGeneration(this.db, sessionId),
          idempotencyKey: `command:stop:${sessionId}:${getLinearSessionGeneration(this.db, sessionId)}`,
          payload: {
            sessionId,
            kind: "response",
            body: "Stopped from Linear.",
            id: crypto.randomUUID(),
          },
          now: requestedAt,
        });
      for (const item of items) {
        if (item.state === "completed" || item.state === "merged" || item.state === "cancelled")
          continue;
        const command: LinearCommand = {
          type: "stop",
          itemId: item.id,
          source: "linear",
          requestedAt,
        };
        if (!applyLinearCommand(this.db, command).applied)
          throw new Error(`Could not stop Linear task ${item.id}`);
        commands.push(command);
      }
      return true;
    });
    if (!accepted) return;
    try {
      for (const command of commands) this.bus.emit(command);
    } finally {
      await this.interruptLinearSession(sessionId);
    }
    await this.flush();
  }

  private pump(): void {
    if (listInFlightItems(this.db).length > 0) return;
    const queued = this.allItems().filter((item) => item.state === "queued");
    queued.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    for (const item of queued) {
      if (!this.blockersClear(item)) continue;
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.start,
        jobKey: `start:${item.id}`,
        payload: { itemId: item.id },
        now: this.now(),
      });
      return;
    }
    const epicIds = new Set(this.allItems().map((item) => item.epicId));
    for (const epicId of epicIds) this.finishEpic(epicId);
  }

  private finishEpic(epicId: string): void {
    const items = this.epicItems(epicId);
    if (items.length === 0) return;
    if (items.some((item) => item.state !== "merged" && item.state !== "completed")) {
      const inflight = items.some((item) => inFlight(item.state));
      const runnable = items.some((item) => item.state === "queued" && this.blockersClear(item));
      if (!inflight && !runnable && items.some((item) => !terminal(item.state))) {
        this.stallEpic(epicId, items);
      }
      return;
    }
    const row = this.epicRow(epicId);
    if (row === null || row.state !== "running") return;
    const result = transitionEpic(row.state, "completed");
    if (!result.ok) return;
    this.db.run("UPDATE epic SET state = ?, version = version + 1 WHERE id = ? AND state = ?", [
      result.to,
      epicId,
      row.state,
    ]);
    if (items.every((item) => item.state === "completed")) return;
    const epicIssueId = this.epicIssueId(epicId);
    if (
      epicIssueId &&
      items.every((item) => item.state === "merged") &&
      this.taskAccess(items[0]!) &&
      items.every((item) => getLinearTaskDelegation(this.db, item.id, epicIssueId)?.humanActorId)
    )
      this.postStatus(items.at(-1)!, "completed", epicIssueId);
    const session =
      epicIssueId !== null && isGitHubIssue(epicIssueId) ? epicIssueId : this.epicSession(items);
    if (session === null) return;
    const identifiers = items.map((item) => item.linearIdentifier).join(", ");
    const results = items.flatMap((item) => {
      const finalText =
        item.currentRunId && getRun(this.db, item.currentRunId)?.checkpoint?.resultBody;
      return finalText ? [`${item.linearIdentifier}: ${finalText}`] : [];
    });
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "activity",
      orderingKey: session,
      idempotencyKey: `epic-done:${epicId}`,
      payload: {
        sessionId: session,
        kind: "response",
        body: [`Epic complete. Merged ${identifiers}.`, ...results].join("\n\n"),
      },
      now: this.now(),
    });
  }

  private stallEpic(epicId: string, items: readonly WorkItemRecord[]): void {
    const row = this.epicRow(epicId);
    if (row === null || row.state !== "running") return;
    const result = transitionEpic(row.state, "stalled");
    if (!result.ok) return;
    this.db.run("UPDATE epic SET state = ?, version = version + 1 WHERE id = ? AND state = ?", [
      result.to,
      epicId,
      row.state,
    ]);
    const session = this.epicSession(items);
    if (session === null) return;
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "activity",
      orderingKey: session,
      idempotencyKey: `epic-stalled:${epicId}`,
      payload: {
        sessionId: session,
        kind: "error",
        body: "The queue cannot make progress. A blocker did not merge.",
      },
      now: this.now(),
    });
  }

  private blockersClear(item: WorkItemRecord): boolean {
    const rows = this.db
      .query<{ blocker_linear_issue_id: string }, [string, string]>(
        `SELECT blocker_linear_issue_id FROM work_item_block
         WHERE epic_id = ? AND blocked_linear_issue_id = ?`,
      )
      .all(item.epicId, item.linearIssueId);
    for (const row of rows) {
      const blocker = this.db
        .query<{ state: string }, [string, string]>(
          `SELECT state FROM work_item WHERE epic_id = ? AND linear_issue_id = ?`,
        )
        .get(item.epicId, row.blocker_linear_issue_id);
      if (blocker?.state !== "merged" && blocker?.state !== "completed") return false;
    }
    return true;
  }

  private ensureRun(item: WorkItemRecord): { id: string } {
    if (item.currentRunId !== null) {
      const existing = getRun(this.db, item.currentRunId);
      if (existing && existing.status === "active") return existing;
    }
    const repository = this.repositoryForItem(item);
    const run = insertRun(this.db, {
      itemId: item.id,
      now: this.now(),
      status: "active",
      kind: "implement",
      agent: resolveAgentProfiles(
        loadConfigFile(join(this.options.pawsRoot, "config.toml")),
        repository ? `${repository.owner}/${repository.repo}` : undefined,
      ).implementer.agent,
      freshSession: true,
    });
    setCurrentRun(this.db, item.id, run.id);
    return run;
  }

  private fail(item: WorkItemRecord, reason: string, text: string): void {
    const current = getWorkItem(this.db, item.id) ?? item;
    if (
      current.state === "running" ||
      current.state === "verifying" ||
      current.state === "recovering" ||
      current.state === "merge_queue"
    ) {
      failWorkItem(this.db, current, reason, text, this.now());
    } else {
      this.post(current, "error", text, `fail:${current.id}:${reason}`);
    }
    this.pump();
  }

  private sessionProgress(item: WorkItemRecord, mode: "code" | "answer" | "artifact" = "code") {
    if (
      this.options.channel === "comments" ||
      isGitHubIssue(item.linearIssueId) ||
      !this.tracker?.updateSession
    )
      return null;
    const sessionId = this.activitySession(item);
    return sessionId === null
      ? null
      : createLinearSessionProgress(
          this.db,
          sessionId,
          item.linearIdentifier,
          () => this.now(),
          mode,
        );
  }

  private post(
    item: WorkItemRecord,
    kind: "thought" | "action" | "response" | "error",
    body: string,
    key: string,
    details: Pick<ProgressUpdate, "id" | "ephemeral" | "action"> = {},
  ): void {
    const current = getWorkItem(this.db, item.id);
    if (current === null || current.state === "cancelled") return;
    if ((kind === "thought" || kind === "action") && !this.canReportProgress(item.id)) return;
    const sessionId = this.activitySession(current);
    if (sessionId === null || body.trim() === "") return;
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "activity",
      orderingKey: sessionId,
      idempotencyKey: key,
      payload: { ...details, sessionId, itemId: item.id, issueId: item.linearIssueId, kind, body },
      now: this.now(),
    });
  }

  private canReportProgress(itemId: string): boolean {
    const item = getWorkItem(this.db, itemId);
    if (item === null || item.cancelRequested) return false;
    if (!["running", "verifying", "merge_queue"].includes(item.state)) return false;
    const sessionId = this.activitySession(item);
    return sessionId === null || findOpenQuestion(this.db, sessionId) === null;
  }

  private postStatus(
    item: WorkItemRecord,
    stateType: "started" | "completed" | "canceled",
    issueId = item.linearIssueId,
  ): void {
    if (this.taskAccess(item) && !getLinearTaskDelegation(this.db, item.id, issueId)?.humanActorId)
      return;
    const sessionId = this.activitySession(item) ?? item.id;
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "status",
      orderingKey: sessionId,
      idempotencyKey: `status:${item.id}:${issueId}:${stateType}`,
      payload: { itemId: item.id, linearIssueId: issueId, stateType },
      now: this.now(),
    });
  }

  private assignSession(epicId: string, sessionId: string): void {
    const items = this.epicItems(epicId);
    if (
      this.options.channel === "comments" ||
      isGitHubIssue(sessionId) ||
      items.some((item) => isGitHubIssue(item.linearIssueId))
    ) {
      for (const item of items) configureWorkItem(this.db, item.id, { sessionKey: sessionId });
      return;
    }
    const item =
      items.find((entry) => inFlight(entry.state)) ??
      items.find((entry) => entry.state === "queued");
    if (item) activateLinearItem(this.db, sessionId, item.id);
  }

  private async runOwnedJob(payload: unknown, operation: () => Promise<void>): Promise<void> {
    const itemId = readString(payload, "itemId");
    if (!itemId) return;
    if (this.shuttingDown) throw new Error("Paws is shutting down");
    const key = `operation:${itemId}`;
    const live = this.beginLive(itemId, key);
    try {
      this.conversations.set(itemId, await durableConversation(this.db, itemId));
      await operation();
    } catch (error) {
      if (!live.controller.signal.aborted) throw error;
    } finally {
      this.conversations.delete(itemId);
      this.live.delete(key);
      live.finish();
    }
  }

  private beginLive(itemId: string, key: string) {
    let finish!: () => void;
    const item = getWorkItem(this.db, itemId);
    const sessionId = item === null ? null : this.activitySession(item);
    const live = {
      itemId,
      sessionId,
      generation: sessionId === null ? 0 : getLinearSessionGeneration(this.db, sessionId),
      controller: new AbortController(),
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => finish(),
    };
    this.live.set(key, live);
    return live;
  }

  private taskAccess(item: WorkItemRecord): LinearTaskAccess | undefined {
    return this.options.linearTaskModes &&
      this.options.channel !== "comments" &&
      !isGitHubIssue(item.linearIssueId)
      ? this.options.linearAccess
      : undefined;
  }

  private repositoryGit(
    item: WorkItemRecord,
    repository: RepositoryBinding,
    signal: AbortSignal,
    access: "read" | "write",
  ) {
    if (!this.options.repositoryToken) return undefined;
    const generation = item.sessionKey ? getLinearSessionGeneration(this.db, item.sessionKey) : 0;
    return createRepositoryGit({
      remoteUrl: repository.remoteUrl,
      signal,
      token: (ownedSignal) => this.options.repositoryToken!(item, repository, ownedSignal, access),
      onCleanupFailure: () => this.blockConversation(item.id),
      assert: async () => {
        signal.throwIfAborted();
        if (
          this.stopped(item.id) ||
          (item.sessionKey && getLinearSessionGeneration(this.db, item.sessionKey) !== generation)
        )
          throw new Error("The repository read belongs to an obsolete task.");
        await this.taskAccess(item)?.assert(item, signal, {
          allowTerminalIssue: access === "read",
        });
        const auth = this.authorization(item);
        if (auth && !(await auth.ensure(item, "initial", signal)))
          throw new Error("GitHub sign-in is required before reading the repository.");
      },
    });
  }

  private authorization(item: WorkItemRecord): GitHubAuthQuestions | null {
    return this.options.channel !== "comments" &&
      !isGitHubIssue(item.linearIssueId) &&
      item.sessionKey !== null
      ? this.githubAuth
      : null;
  }

  private signalForItem(itemId: string): AbortSignal | undefined {
    return [...this.live.values()].find((live) => live.itemId === itemId)?.controller.signal;
  }

  private async resumeLinearSession(sessionId: string): Promise<void> {
    const active = [...this.live.values()].filter((live) =>
      this.itemsForSession(sessionId).some((item) => item.id === live.itemId),
    );
    await this.stopTaskPlanning(sessionId);
    await Promise.all(active.map((live) => live.done));
    if (this.shuttingDown) throw new Error("Paws is shutting down; user update remains pending");
    let turns = listPendingLinearTurns(this.db, sessionId);
    if (!turns.length) return;
    if (this.tracker === null)
      throw new Error("Linear is disconnected; user update remains pending");
    let session = getLinearSession(this.db, sessionId);
    if (!session?.issueId && this.tracker.getSession) {
      const recovered = await this.tracker.getSession(sessionId);
      session = ensureLinearSession(this.db, {
        sessionId,
        issueId: recovered.issue?.id,
        appUserId: recovered.appUserId,
        creatorId: recovered.creatorId,
        now: this.now(),
      });
    }
    if (!session?.issueId)
      throw new Error("Linear session has no issue; user update remains pending");
    let item = session.activeItemId ? getWorkItem(this.db, session.activeItemId) : null;
    if (
      !item ||
      item.state === "completed" ||
      item.state === "merged" ||
      item.state === "cancelled"
    ) {
      let conversation: string | undefined;
      if (item) {
        await durableConversation(this.db, item.id);
        conversation = getConversation(this.db, item.id).entries;
        turns = listPendingLinearTurns(this.db, sessionId);
        if (!turns.length) return;
      }
      const result = await this.intakeLinearTask(
        session.issueId,
        sessionId,
        `turn:${turns[0]!.eventKey}`,
        { followupBodies: turns.map((turn) => turn.body), conversation },
      );
      if (!result.ok) throw new Error("Follow-up task intake failed");
      bindLinearSessionTask(this.db, sessionId, result.epic.id, { actorId: turns[0]!.actorId });
      item = getWorkItem(this.db, result.items[0]!.id);
      if (item) activateLinearItem(this.db, sessionId, item.id);
    }
    if (!item) throw new Error("Linear user update has no routed task");
    if (getConversation(this.db, item.id).blocked)
      throw new Error(
        "Prior ACP process cleanup could not be verified; user update remains pending",
      );
    const jobKey = `linear-turn:${sessionId}:${getLinearSessionGeneration(this.db, sessionId)}`;
    immediate(this.db, () => {
      if (item!.currentRunId) markRun(this.db, item!.currentRunId!, "ended", this.now());
      if (item!.state === "failed" || item!.state === "exhausted")
        applyWorkItemEvent(this.db, item!.id, "requeue");
      else if (item!.state !== "queued") applyWorkItemEvent(this.db, item!.id, "restart");
      this.db.run(
        "UPDATE job SET status = 'cancelled', finished_at = ?, last_error = 'Superseded by Linear user update' WHERE status = 'pending' AND json_extract(payload,'$.itemId') = ? AND (job_key IS NULL OR job_key != ?)",
        [this.now(), item!.id, jobKey],
      );
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.resume,
        jobKey,
        payload: { itemId: item!.id, handoff: turns.map((turn) => turn.body).join("\n\n") },
        now: this.now(),
      });
    });
    await this.flush();
  }

  private abortItem(itemId: string): void {
    for (const live of this.live.values()) {
      if (live.itemId !== itemId) continue;
      live.controller.abort();
    }
  }

  private itemsForSession(sessionId: string): WorkItemRecord[] {
    return this.allItems().filter(
      (item) =>
        item.sessionKey === sessionId || linearSessionForEpic(this.db, item.epicId) === sessionId,
    );
  }

  private allItems(): WorkItemRecord[] {
    const rows = this.db.query<{ id: string }, []>("SELECT id FROM work_item").all();
    const items: WorkItemRecord[] = [];
    for (const row of rows) {
      const item = getWorkItem(this.db, row.id);
      if (item) items.push(item);
    }
    return items;
  }

  private epicItems(epicId: string): WorkItemRecord[] {
    return this.allItems()
      .filter((item) => item.epicId === epicId)
      .sort((left, right) => left.position - right.position);
  }

  private epicRow(epicId: string): { id: string; state: EpicState } | null {
    return this.db
      .query<{ id: string; state: EpicState }, [string]>("SELECT id, state FROM epic WHERE id = ?")
      .get(epicId);
  }

  private async flush(signal?: AbortSignal): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      signal?.throwIfAborted();
      const claimed = this.options.outbox.tick();
      const idle = this.options.outbox.idle();
      if (signal) {
        signal.throwIfAborted();
        let onAbort: () => void = () => {};
        try {
          await Promise.race([
            idle,
            new Promise<never>((_resolve, reject) => {
              onAbort = () => reject(signal.reason);
              signal.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
        } finally {
          signal.removeEventListener("abort", onAbort);
        }
      } else await idle;
      signal?.throwIfAborted();
      if (claimed.length === 0) return;
    }
  }

  private stopped(itemId: string): boolean {
    const current = getWorkItem(this.db, itemId);
    return (
      this.shuttingDown ||
      this.signalForItem(itemId)?.aborted === true ||
      current === null ||
      current.state === "cancelled" ||
      current.cancelRequested
    );
  }

  private async hydrateLinearContext(sessionId: string | null, signal: AbortSignal): Promise<void> {
    if (this.options.channel === "comments" || !sessionId || isGitHubIssue(sessionId)) return;
    if (!hasLinearSessionSnapshotContext(this.db, sessionId) && this.tracker?.getSession) {
      const session = await this.tracker.getSession(sessionId, { signal });
      signal.throwIfAborted();
      const durable = ensureLinearSession(this.db, {
        sessionId,
        issueId: session.issue?.id,
        appUserId: session.appUserId,
        creatorId: session.creatorId,
        now: this.now(),
      });
      if (durable.epicId) bindLinearSessionTask(this.db, sessionId, durable.epicId);
      saveLinearSessionSnapshotContext(
        this.db,
        sessionId,
        renderLinearSessionContext({
          promptContext: null,
          issue: session.issue,
          comment: session.sourceComment ?? session.comment,
          previousComments: [],
          guidance: [],
        }),
      );
    }
    if (!this.tracker?.listSessionActivities) return;
    const activities = await this.tracker.listSessionActivities(sessionId, { signal });
    signal.throwIfAborted();
    immediate(this.db, () => {
      for (const activity of activities)
        saveLinearActivitySnapshot(this.db, {
          id: activity.id,
          sessionId,
          createdAt: activity.createdAt,
          snapshot: JSON.stringify(activity),
        });
    });
  }

  private workContext(item: WorkItemRecord): string {
    const taskKey = this.db
      .query<{ task_key: string }, [string]>("SELECT task_key FROM epic WHERE id = ?")
      .get(item.epicId)?.task_key;
    const classification = taskKey ? getTaskClassification(this.db, taskKey) : null;
    const activities = item.sessionKey
      ? listLinearActivitySnapshots(this.db, item.sessionKey)
          .map((snapshot) => JSON.parse(snapshot) as LinearActivitySnapshot)
          .filter((activity) => activity.content.type !== "thought" && !activity.ephemeral)
      : [];
    return [
      renderWorkBrief(item.brief),
      ...listLinearTurnsForItem(this.db, item.id).map((turn) => `User update:\n${turn.body}`),
      classification?.mode !== "clarify" ? (classification?.context ?? "") : "",
      item.sessionKey ? getLinearSessionContext(this.db, item.sessionKey) : "",
      activities.length
        ? `Immutable Linear conversation history:\n${JSON.stringify(activities)}`
        : "",
    ]
      .filter(Boolean)
      .join("\n\n");
  }

  private artifactPublisher(item: WorkItemRecord) {
    const sessionId = this.activitySession(item);
    if (
      !sessionId ||
      !this.options.files ||
      !this.options.secretsDir ||
      isGitHubIssue(item.linearIssueId)
    )
      return undefined;
    return createLinearArtifactPublisher({
      db: this.db,
      files: this.options.files,
      secretsDir: this.options.secretsDir,
      itemId: item.id,
      issueId: item.linearIssueId,
      sessionId,
      now: () => this.now(),
    });
  }

  private prepareInputFiles(item: WorkItemRecord, turnId: string) {
    const loader = this.inputLoader;
    const sessionId = this.activitySession(item);
    if (!loader || !sessionId || isGitHubIssue(item.linearIssueId)) return undefined;
    return (input: { workspace: string; prompt: string; signal: AbortSignal }) =>
      loader({ ...input, sessionId, turnId });
  }

  private blockConversation(itemId: string): void {
    const stored = getConversation(this.db, itemId);
    saveConversation(
      this.db,
      itemId,
      stored.entries,
      stored.transcript,
      true,
      stored.transcriptOffset,
    );
  }

  private async prepareConversation(item: WorkItemRecord) {
    const taskKey = this.db
      .query<{ task_key: string }, [string]>("SELECT task_key FROM epic WHERE id = ?")
      .get(item.epicId)?.task_key;
    const classification = taskKey ? getTaskClassification(this.db, taskKey) : null;
    const sourceItemId = classification?.mode !== "clarify" ? classification?.sourceItemId : null;
    const stored = getConversation(this.db, item.id);
    if (sourceItemId && stored.entries === "[]" && !stored.transcript) {
      await durableConversation(this.db, sourceItemId);
      saveConversation(this.db, item.id, getConversation(this.db, sourceItemId).entries, null);
    }
    const runner = await durableConversation(this.db, item.id);
    this.conversations.set(item.id, runner);
    if (item.sessionKey && getLinearSession(this.db, item.sessionKey))
      applyLinearTurns(
        this.db,
        item.sessionKey,
        listPendingLinearTurns(this.db, item.sessionKey).map((turn) => turn.eventKey),
        item.id,
      );
    return runner;
  }

  private agentDeps(item: WorkItemRecord): AcpAgentDeps {
    const runId = item.currentRunId ?? item.id;
    return {
      pawsRoot: this.options.pawsRoot,
      profiles: this.profileSnapshot(runId),
      publishArtifact: this.artifactPublisher(item),
      prepareInputFiles: this.prepareInputFiles(item, runId),
      onCandidate: (identity) => {
        if (!this.signalForItem(item.id)?.aborted) this.saveCandidate(runId, identity);
      },
      onCleanupFailure: () => {
        const stored = getConversation(this.db, item.id);
        saveConversation(this.db, item.id, stored.entries, stored.transcript, true);
      },
      signal: this.signalForItem(item.id),
      promptRunner: this.conversations.get(item.id),
      ...(this.options.home ? { home: this.options.home } : {}),
      launch: this.launchAgent.bind(this),
      brief: this.workContext(item),
      ...(this.options.docker ? { docker: this.options.docker } : {}),
    };
  }

  private itemDocker(agent: "claude" | "codex" | "grok"):
    | {
        docker: {
          agent: "claude" | "codex";
          proxyUrl: string;
          image?: string;
          bin?: string;
        };
      }
    | Record<string, never> {
    const docker = this.options.docker;
    if (docker === undefined) return {};
    if (agent === "grok") throw new Error("Grok does not support the configured Docker sandbox");
    return {
      docker: {
        agent,
        proxyUrl: docker.proxyUrl,
        ...(docker.image ? { image: docker.image } : {}),
        ...(docker.bin ? { bin: docker.bin } : {}),
      },
    };
  }

  private gitHubCredentials(
    github: GitHubBinding,
  ):
    | { tokenProvider: GitHubTokenProvider }
    | { appId: string; installationId: string; privateKeyPem: string } {
    if (github.tokenProvider) return { tokenProvider: github.tokenProvider };
    return {
      appId: github.appId,
      installationId: github.installationId,
      privateKeyPem: github.privateKeyPem,
    };
  }

  private epicIssueId(epicId: string): string | null {
    const row = this.db
      .query<{ linear_issue_id: string }, [string]>("SELECT linear_issue_id FROM epic WHERE id = ?")
      .get(epicId);
    return row?.linear_issue_id ?? null;
  }

  private activitySession(item: WorkItemRecord): string | null {
    if (isGitHubIssue(item.linearIssueId)) return item.linearIssueId;
    if (this.options.channel === "comments") return item.linearIssueId;
    const session = item.sessionKey;
    if (session === null || session.length === 0) return null;
    return session;
  }

  private epicSession(items: readonly WorkItemRecord[]): string | null {
    for (const item of items) {
      const session = this.activitySession(item);
      if (session !== null) return session;
    }
    return null;
  }

  private async candidateForItem(item: WorkItemRecord): Promise<CandidateIdentity | null> {
    const runId = item.currentRunId ?? item.id;
    try {
      return this.candidateFor(runId);
    } catch (error) {
      const summary = error instanceof Error ? error.message : String(error);
      markRunEnded(this.db, runId, this.now());
      this.post(item, "thought", summary, `${runId}:missing-candidate-identity`);
      await this.askCloseoutHelp(item, undefined, summary);
      return null;
    }
  }

  private candidateFor(runId: string): CandidateIdentity {
    const saved = this.readProfileSnapshot(runId);
    if (!saved?.candidate)
      throw new Error("Candidate has no recorded ACP session model; restart implementation");
    return saved.candidate;
  }

  private readProfileSnapshot(runId: string): {
    profiles: { implementer: AgentProfile; reviewer: AgentProfile };
    candidate?: AgentIdentity;
  } | null {
    try {
      return JSON.parse(
        readFileSync(join(runDir(this.options.pawsRoot, runId), "agent-profile.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private profileSnapshot(runId: string): { implementer: AgentProfile; reviewer: AgentProfile } {
    const saved = this.readProfileSnapshot(runId);
    if (saved) return saved.profiles;
    const config = loadConfigFile(join(this.options.pawsRoot, "config.toml"));
    const run = getRun(this.db, runId);
    const item = run === null ? null : getWorkItem(this.db, run.itemId);
    const repository = item === null ? null : this.repositoryForItem(item);
    const profiles = resolveAgentProfiles(
      config,
      repository ? `${repository.owner}/${repository.repo}` : undefined,
    );
    mkdirSync(runDir(this.options.pawsRoot, runId), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(runDir(this.options.pawsRoot, runId), "agent-profile.json"),
      JSON.stringify({ profiles }),
      { mode: 0o600 },
    );
    return profiles;
  }

  private saveCandidate(runId: string, candidate: AgentIdentity): void {
    const profiles = this.profileSnapshot(runId);
    writeFileSync(
      join(runDir(this.options.pawsRoot, runId), "agent-profile.json"),
      JSON.stringify({ profiles, candidate }),
      { mode: 0o600 },
    );
  }

  private async preflight(
    item: WorkItemRecord,
    runId: string,
    profiles: { implementer: AgentProfile; reviewer: AgentProfile },
    signal: AbortSignal,
  ): Promise<void> {
    const repository = this.repositoryForItem(item);
    if (repository === null) throw new Error("The work item has no repository");
    await ensureBareMirror({
      ...repository,
      pawsRoot: this.options.pawsRoot,
      networkGit: this.repositoryGit(item, repository, signal, "write"),
    });
    const worktree = await createWorktree({
      ...repository,
      itemId: itemPathId(item),
      pawsRoot: this.options.pawsRoot,
    });
    const required = reviewRequirements(worktree.path, this.options.home);
    if (!required.ok) throw new Error(required.message);
    const requirements = required.items.filter((check) => check.gate === "beforePR");
    if (!requirements.length) return;
    const identities: AgentIdentity[] = [];
    for (const role of ["implementer", "reviewer"] as const) {
      const profile = profiles[role];
      const launched = this.launchAgent({
        role,
        profile,
        purpose: "prepare",
        itemId: itemPathId(item),
        worktree: worktree.path,
        prompt: "",
      });
      const result = await runAgent({
        ...launched,
        profile,
        role,
        itemId: itemPathId(item),
        runId: `${runId}-preflight-${role}`,
        worktreePath: worktree.path,
        pawsRoot: this.options.pawsRoot,
        ...(this.options.home ? { home: this.options.home } : {}),
        ...this.itemDocker(profile.agent),
        prepareOnly: true,
        readOnly: true,
        checkpoint: false,
        prompt: "",
        signal,
      });
      if (!result.identity || result.errorMessage)
        throw new Error(result.errorMessage ?? `${role} did not report a concrete session model`);
      identities.push(result.identity);
    }
    for (const check of requirements) {
      const [implementer, reviewer] = identities;
      if (check.independence.differentSession && implementer!.session === reviewer!.session)
        throw new Error(`Closeout ${check.id} requires a different reviewer session`);
      if (check.independence.differentModel && implementer!.model === reviewer!.model)
        throw new Error(
          `Closeout ${check.id} requires a different reviewer model; choose another reviewer profile`,
        );
    }
    profiles.implementer.model ??= identities[0]!.model;
    profiles.reviewer.model ??= identities[1]!.model;
    writeFileSync(
      join(runDir(this.options.pawsRoot, runId), "agent-profile.json"),
      JSON.stringify({ profiles }),
      { mode: 0o600 },
    );
  }

  private closeoutHome(): { home?: string; pawsHome: string } {
    return {
      ...(this.options.home !== undefined ? { home: this.options.home } : {}),
      pawsHome: this.options.pawsRoot,
    };
  }

  private repositoryForItem(item: WorkItemRecord): RepositoryBinding | null {
    return getWorkItemRepository(this.db, item.id) ?? this.options.repository ?? null;
  }

  private async selectRepository(
    item: WorkItemRecord,
    access: "read" | "write" = "write",
  ): Promise<boolean> {
    if (getConversation(this.db, item.id).blocked)
      throw new Error("Prior ACP process cleanup could not be verified");
    const bound = getWorkItemRepository(this.db, item.id);
    if (bound !== null && access === "write") return true;
    const liveKey = `repository:${item.id}`;
    const live = this.beginLive(item.id, liveKey);
    const controller = live.controller;
    const auth = this.authorization(item);
    const generation = item.sessionKey ? getLinearSessionGeneration(this.db, item.sessionKey) : 0;
    const current = () =>
      !this.stopped(item.id) &&
      (!item.sessionKey || getLinearSessionGeneration(this.db, item.sessionKey) === generation);
    try {
      if (bound !== null) {
        if (auth && !(await auth.ensure(item, "initial", controller.signal))) {
          await this.flush();
          return false;
        }
        const allowed =
          !this.options.repositoryAccess ||
          (await this.options.repositoryAccess(bound, controller.signal, access));
        controller.signal.throwIfAborted();
        if (this.stopped(item.id)) return false;
        if (!allowed) throw new Error("The selected repository is no longer accessible");
        return true;
      }
      const available =
        this.options.repositories ?? (this.options.repository ? [this.options.repository] : []);
      const source = /^github:([^/]+)\/([^#]+)#/.exec(item.linearIssueId);
      const configured = available.filter(
        (candidate, index) =>
          available.findIndex(
            (other) =>
              `${other.owner}/${other.repo}`.toLowerCase() ===
              `${candidate.owner}/${candidate.repo}`.toLowerCase(),
          ) === index &&
          (!source ||
            `${candidate.owner}/${candidate.repo}`.toLowerCase() ===
              `${source[1]}/${source[2]}`.toLowerCase()),
      );
      const candidates: RepositoryBinding[] = auth ? [...configured] : [];
      for (const candidate of auth ? [] : configured) {
        controller.signal.throwIfAborted();
        if (
          !this.options.repositoryAccess ||
          (await this.options.repositoryAccess(candidate, controller.signal, access))
        )
          candidates.push(candidate);
      }
      if (this.stopped(item.id)) return false;
      const savedAnswer = getWorkItemRepositoryAnswer(this.db, item.id);
      const remembered = getWorkItemRepositoryChoice(this.db, item.id);
      let selected =
        remembered && candidates.some((candidate) => sameRepository(candidate, remembered))
          ? remembered
          : savedAnswer
            ? repositoryAnswer(savedAnswer.answer, savedAnswer.candidates)
            : null;
      if (!selected && savedAnswer) {
        const offered = savedAnswer.candidates.filter((previous) =>
          candidates.some(
            (candidate) =>
              previous.owner === candidate.owner &&
              previous.repo === candidate.repo &&
              previous.remoteUrl === candidate.remoteUrl,
          ),
        );
        selected = await interpretRepositoryAnswer({
          answer: savedAnswer.answer,
          candidates: offered,
          offered: savedAnswer.candidates,
          itemId: item.id,
          pawsRoot: this.options.pawsRoot,
          home: this.options.home,
          profile: resolveAgentProfiles(loadConfigFile(join(this.options.pawsRoot, "config.toml")))
            .implementer,
          signal: controller.signal,
          launch: this.launchAgent,
          onCleanupFailure: () => this.blockConversation(item.id),
        });
        controller.signal.throwIfAborted();
        if (this.stopped(item.id)) return false;
      }
      const selectedIndex = selected
        ? candidates.findIndex(
            (candidate) =>
              candidate.owner === selected.owner &&
              candidate.repo === selected.repo &&
              candidate.remoteUrl === selected.remoteUrl,
          )
        : -1;
      if (selected && selectedIndex >= 0) {
        controller.signal.throwIfAborted();
        if (!current()) return false;
        if (
          savedAnswer &&
          !rememberWorkItemRepositoryChoice(this.db, item.id, savedAnswer.questionId, selected)
        )
          return false;
        if (auth && !(await auth.ensure(item, "initial", controller.signal))) {
          await this.flush();
          return false;
        }
        const accessible =
          !this.options.repositoryAccess ||
          (await this.options.repositoryAccess(selected, controller.signal, access));
        controller.signal.throwIfAborted();
        if (this.stopped(item.id)) return false;
        if (accessible) {
          bindWorkItemRepository(this.db, item.id, selected);
          return true;
        }
        candidates.splice(selectedIndex, 1);
      }
      if (candidates.length === 0) {
        this.fail(item, "no_repository", "No configured GitHub repository is accessible.");
        return false;
      }
      if (candidates.length === 1 && savedAnswer === null) {
        if (auth && !(await auth.ensure(item, "initial", controller.signal))) {
          await this.flush();
          return false;
        }
        const accessible =
          !auth ||
          !this.options.repositoryAccess ||
          (await this.options.repositoryAccess(candidates[0]!, controller.signal, access));
        controller.signal.throwIfAborted();
        if (!current()) return false;
        if (!accessible) {
          this.fail(item, "no_repository", "No configured GitHub repository is accessible.");
          return false;
        }
        bindWorkItemRepository(this.db, item.id, candidates[0]!);
        return true;
      }
      let ranked = candidates;
      if (!isGitHubIssue(item.linearIssueId) && this.tracker?.issueRepositorySuggestions) {
        try {
          const suggestions = await this.tracker.issueRepositorySuggestions(
            {
              issueId: item.linearIssueId,
              ...(this.options.channel !== "comments" && item.sessionKey
                ? { agentSessionId: item.sessionKey }
                : {}),
              candidateRepositories: candidates.map((candidate) => ({
                hostname: "github.com",
                repositoryFullName: `${candidate.owner}/${candidate.repo}`,
              })),
            },
            { signal: controller.signal },
          );
          ranked = rankRepositories(candidates, suggestions);
        } catch {
          controller.signal.throwIfAborted();
        }
      }
      if (this.stopped(item.id)) return false;
      const sessionId = this.activitySession(item);
      if (sessionId === null) throw new Error("Repository selection has no tracker session");
      immediate(this.db, () => {
        const question = openQuestion(this.db, {
          itemId: item.id,
          sessionId,
          body: "Which repository should I use? Choose one of the configured repositories or describe your choice.",
          options: ranked.map(
            (candidate) => `https://github.com/${candidate.owner}/${candidate.repo}`,
          ),
          now: this.now(),
        });
        saveWorkItemRepositoryQuestion(this.db, item.id, question.id, ranked);
        applyWorkItemEvent(this.db, item.id, "blocking_question");
        enqueueOutboxOnce(this.db, {
          target: "linear",
          op: "elicitation",
          orderingKey: sessionId,
          idempotencyKey: `repository:${question.id}`,
          payload: {
            sessionId,
            questionId: question.id,
            id: question.id,
            body: question.body,
            options: question.options,
          },
          now: this.now(),
        });
      });
      await this.flush();
      return false;
    } catch (error) {
      if (!controller.signal.aborted && getWorkItem(this.db, item.id)?.state === "running")
        applyWorkItemEvent(this.db, item.id, "restart");
      throw error;
    } finally {
      this.live.delete(liveKey);
      live.finish();
    }
  }

  private githubForRepository(repository: RepositoryBinding): GitHubBinding | null {
    if (this.options.githubForRepository) return this.options.githubForRepository(repository);
    const configured = this.options.repository;
    if (
      configured?.owner !== repository.owner ||
      configured.repo !== repository.repo ||
      configured.remoteUrl !== repository.remoteUrl
    ) {
      return null;
    }
    return this.options.github ?? null;
  }

  private launchAgent: AgentLaunch = (input) => {
    const launched = this.options.launch?.(input) ?? {};
    if (launched.command) return launched;
    try {
      const agents = loadConfigFile(join(this.options.pawsRoot, "config.toml")).agents;
      const adapter = resolveAdapter(
        input.role,
        process.env,
        undefined,
        undefined,
        agents,
        input.profile?.agent,
      );
      return { ...launched, command: adapter.command, args: launched.args ?? adapter.args };
    } catch {
      return launched;
    }
  };

  private now(): number {
    return (this.options.clock ?? systemClock).now();
  }
}

export function attachOrchestrator(options: OrchestratorOptions): Orchestrator {
  return new Orchestrator(options);
}

function markRunEnded(db: Database, runId: string, now: number): void {
  const run = getRun(db, runId);
  if (run && run.status === "active") markRun(db, runId, "ended", now);
}

function inFlight(state: WorkItemRecord["state"]): boolean {
  return (
    state === "running" ||
    state === "verifying" ||
    state === "recovering" ||
    state === "awaiting_input" ||
    state === "paused" ||
    state === "merge_queue"
  );
}

function terminal(state: WorkItemRecord["state"]): boolean {
  return (
    state === "completed" ||
    state === "merged" ||
    state === "cancelled" ||
    state === "failed" ||
    state === "exhausted"
  );
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function sameRepository(left: RepositoryBinding, right: RepositoryBinding): boolean {
  return (
    left.owner === right.owner && left.repo === right.repo && left.remoteUrl === right.remoteUrl
  );
}
