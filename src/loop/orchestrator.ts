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
  type EpicState,
  systemClock,
} from "../core";
import {
  getTaskMode,
  getTaskModeGeneration,
  getLinearSessionGeneration,
  getLinearSession,
  advanceLinearSessionGeneration,
  listPendingLinearTurns,
  saveTaskMode,
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
  enqueueJob,
  enqueueJobOnce,
  enqueueOutboxOnce,
  failWorkItem,
  getRun,
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
  submitCommand,
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
  TrackerAdapter,
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
import { renderWorkBrief } from "./brief";
import { recordLinearSessionEvent, sessionTaskKey } from "./linear-routing";
import { createLinearArtifactPublisher } from "./artifacts";
import { createLinearInputLoader } from "./input-files";
import { createTaskPlanner } from "./task-planner";
import { classifyTask } from "./task-classifier";

export type GitHubBinding = {
  appId: string;
  installationId: string;
  privateKeyPem: string;
  client: GitHubClient;
  /** `github.auth = "gh"`. When set, push and merge do not mint a GitHub App token. */
  tokenProvider?: GitHubTokenProvider;
};

export type RepositoryBinding = {
  owner: string;
  repo: string;
  remoteUrl: string;
};

export type OrchestratorOptions = {
  db: Database;
  jobs: JobLoop;
  outbox: OutboxDispatcher;
  pawsRoot: string;
  home?: string;
  tracker?: TrackerAdapter | null;
  linearTaskModes?: boolean;
  files?: LinearFileTransfer | null;
  secretsDir?: string;
  catchUp?: () => Promise<void>;
  repository?: RepositoryBinding | null;
  github?: GitHubBinding | null;
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
  private readonly live = new Map<string, { itemId: string; controller: AbortController }>();
  private activitySeq = 0;
  private readonly inputLoader: ReturnType<typeof createLinearInputLoader> | null;
  private readonly taskPlanner: ReturnType<typeof createTaskPlanner>;

  constructor(private readonly options: OrchestratorOptions) {
    this.tracker = options.tracker ?? null;
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
    if (event.signal === "stop") {
      if (event.sessionId) {
        advanceLinearSessionGeneration(this.db, event.sessionId, { stop: true, now: this.now() });
        await this.taskPlanner.stop(event.sessionId);
      }
      this.stopSession(event.sessionId, event.updatedAtMs);
      return;
    }
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
        recordLinearTurn(this.db, {
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
      await this.deliverPrompt(event);
      if (
        linearPrompt &&
        question &&
        findOpenQuestion(this.db, question.sessionId)?.id !== question.id &&
        event.sessionId
      )
        applyLinearTurns(this.db, event.sessionId, [event.dedupeKey], question.itemId);
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

  async intakeLinearTask(
    issueId: string,
    sessionId: string | null,
    taskKey?: string,
    options: { followupBodies?: readonly string[] } = {},
  ) {
    const tracker = this.tracker;
    if (!tracker) throw new Error("Linear is not connected");
    const initialSession = sessionId ? getLinearSession(this.db, sessionId) : null;
    const isCurrent = () => {
      if (initialSession === null || sessionId === null) return true;
      const current = getLinearSession(this.db, sessionId);
      return current?.generation === initialSession.generation && current.stoppedAt === null;
    };
    if (!isCurrent()) throw new Error("The Linear request changed before intake");
    const savedRequest = taskKey ? getTaskClassification(this.db, taskKey) : null;
    const redirect = savedRequest?.mode !== "clarify" ? savedRequest?.redirect : undefined;
    if (redirect) taskKey = redirect.taskKey;
    let intakeTracker = tracker;
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
              intakeTracker = { ...tracker, loadEpic: async () => snapshot };
              await this.hydrateLinearContext(sessionId, signal);
              const history = listLinearActivitySnapshots(this.db, sessionId)
                .map((raw) => JSON.parse(raw) as LinearActivitySnapshot)
                .filter((activity) => activity.content.type !== "thought" && !activity.ephemeral);
              return [
                JSON.stringify(snapshot),
                getLinearSessionContext(this.db, sessionId),
                JSON.stringify(history),
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
    jobs.register(JOB_KIND.reverify, (job) => this.reverify(job.payload));
    jobs.register(JOB_KIND.merge, async (job, context) => {
      const lease = setInterval(() => context.extendLease(60_000), 10_000);
      lease.unref?.();
      try {
        await this.merge(job.payload);
      } finally {
        clearInterval(lease);
      }
    });
    this.options.outbox.setHandler(async (message, context) => {
      if (message.target !== "linear") return;
      const tracker = this.tracker;
      if (tracker === null) throw new Error("Linear is not connected");
      await deliverLinearOutbox(message, tracker, () => this.catchUpFn(), context);
    });
  }

  private async executeQueued(
    payload: unknown,
    extendLease: (leaseMs?: number) => boolean,
  ): Promise<void> {
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
          await this.runResponse(item, mode, handoff);
          return;
        }
      }
      await this.runItem(item, handoff);
    } finally {
      clearInterval(lease);
    }
  }

  private async resolveTaskMode(item: WorkItemRecord, handoff?: string): Promise<boolean> {
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
    if (saved && (!handoff || getTaskModeGeneration(this.db, item.id) >= generation)) return true;
    if (!saved && (!classification || classification.mode !== "clarify")) {
      saveTaskMode(this.db, item.id, classification?.mode ?? "code", generation);
      return true;
    }
    const run = this.ensureRun(item);
    if (!handoff) {
      if (classification?.mode !== "clarify") throw new Error("Task clarification is missing");
      return this.requestTaskClarification(item, run.id, classification.question);
    }
    const controller = new AbortController();
    this.live.set(run.id, { itemId: item.id, controller });
    try {
      const resolved = await classifyTask({
        itemId: itemPathId(item),
        runId: run.id,
        request: [this.workContext(item), handoff].join("\n\n"),
        pawsRoot: this.options.pawsRoot,
        home: this.options.home,
        profile: this.profileSnapshot(run.id).implementer,
        signal: controller.signal,
        launch: (input) => this.launchAgent(input),
      });
      controller.signal.throwIfAborted();
      if (
        this.stopped(item.id) ||
        (item.sessionKey && getLinearSessionGeneration(this.db, item.sessionKey) !== generation)
      )
        return false;
      if (resolved.mode === "clarify")
        return this.requestTaskClarification(item, run.id, resolved.question);
      if (resolved.mode === "code" && classification?.mode === "clarify" && taskKey) {
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
      if (saved) selectTaskModeForTurn(this.db, item.id, resolved.mode, generation);
      else saveTaskMode(this.db, item.id, resolved.mode, generation);
      return true;
    } finally {
      this.live.delete(run.id);
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
    const controller = new AbortController();
    this.live.set(run.id, { itemId: item.id, controller });
    const workspace = join(this.options.pawsRoot, "tasks", item.id, mode);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const activity = createAcpActivityReporter((update) => {
      if (!controller.signal.aborted && update.kind !== "elicitation")
        this.post(item, update.kind, update.body, `${run.id}:answer:${++this.activitySeq}`);
    });
    const keepAlive = setInterval(() => {
      if (this.canReportProgress(item.id)) {
        this.post(
          item,
          "thought",
          "Preparing the requested answer.",
          `${run.id}:keep:${this.now()}`,
        );
        void this.flush();
      }
    }, KEEPALIVE_MS);
    keepAlive.unref?.();
    try {
      await this.hydrateLinearContext(item.sessionKey, controller.signal);
      const prompt = [
        mode === "answer"
          ? "Answer the user's request in this Linear conversation. Provide the complete answer in your final message."
          : "Create the requested deliverable files in this workspace, publish them using publish_artifact, and include the published file links in your complete final response.",
        "Use ask_team when a product decision is required.",
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
      const result = await runAgent({
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
      this.pump();
    } catch (error) {
      if (!this.stopped(item.id) && !controller.signal.aborted)
        this.fail(item, "answer_error", error instanceof Error ? error.message : String(error));
    } finally {
      clearInterval(keepAlive);
      this.live.delete(run.id);
      await this.flush();
    }
  }

  private async runItem(item: WorkItemRecord, handoff?: string): Promise<void> {
    const repository = this.options.repository;
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
    const controller = new AbortController();
    this.live.set(run.id, { itemId: item.id, controller });
    this.post(item, "action", `Working on ${item.linearIdentifier}.`, `${run.id}:working`);
    this.postStatus(item, "started");
    let posted = true;
    const first = setTimeout(() => {
      if (posted || !this.canReportProgress(item.id)) return;
      posted = true;
      this.post(item, "thought", `Working on ${item.linearIdentifier}.`, `${run.id}:first`);
      void this.flush();
    }, FIRST_ACTIVITY_MS);
    const keepAlive = setInterval(() => {
      if (!this.canReportProgress(item.id)) return;
      this.post(
        item,
        "thought",
        `Still working on ${item.linearIdentifier}.`,
        `${run.id}:keep:${this.now()}`,
      );
      void this.flush();
    }, KEEPALIVE_MS);
    first.unref?.();
    keepAlive.unref?.();
    const askTeam = this.askHook(item, run.id);
    const activity = createAcpActivityReporter((update) => {
      if (controller.signal.aborted || update.kind === "elicitation") return;
      posted = true;
      this.activitySeq += 1;
      this.post(item, update.kind, update.body, `${run.id}:acp:${this.activitySeq}`);
    });

    try {
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
        if (this.stopped(item.id)) return;
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
        pawsRoot: this.options.pawsRoot,
        home: this.options.home ?? homedir(),
        signal: controller.signal,
        askTeam,
        publishArtifact: this.artifactPublisher(item),
        prepareInputFiles: this.prepareInputFiles(item, run.id),
        onEvent: activity.onEvent,
        ...(launched.command ? { command: launched.command, args: launched.args ?? [] } : {}),
        ...(launched.env ? { env: launched.env } : {}),
        ...this.itemDocker(profiles.implementer.agent),
      });
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
      if (current && current.state !== "cancelled" && !current.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error);
        this.fail(current, "run_error", message);
      }
    } finally {
      activity.flush();
      clearTimeout(first);
      clearInterval(keepAlive);
      this.live.delete(run.id);
      await this.flush();
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
    const deps = this.agentDeps(item);
    const onCandidate = deps.onCandidate;
    deps.onCandidate = (identity) => {
      Object.assign(candidate, identity);
      onCandidate?.(identity);
    };
    const gate = createCloseoutGate({
      candidate,
      reviewer: createAcpCodexReviewer(deps),
      fixer: createAcpFixRunner(deps),
      recorder: {
        record: async (verdict) => {
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
    const repository = this.options.repository;
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
    const repository = this.options.repository;
    const github = this.options.github;
    if (
      repository === null ||
      repository === undefined ||
      github === null ||
      github === undefined
    ) {
      this.fail(item, "no_github", "GitHub App is not configured.");
      return;
    }
    if (item.state !== "merge_queue") return;
    const candidate = await this.candidateForItem(item);
    if (!candidate) return;
    const worktree = worktreePath(this.options.pawsRoot, itemPathId(item));
    const summary = readString(payload, "summary") ?? "Closeout accepted.";
    if (!artifactPublicationReady(this.db, item.id)) {
      this.fail(
        item,
        "artifact_upload",
        "A requested artifact has not been uploaded successfully.",
      );
      return;
    }
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
      remoteUrl: repository.remoteUrl,
      ...this.gitHubCredentials(github),
    });
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
    if (this.stopped(item.id)) return;
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
            body: request.question,
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

  private async deliverPrompt(event: AcceptedLinearEvent): Promise<void> {
    const sessionId = event.sessionId;
    const answer = event.body?.trim() ?? "";
    if (sessionId === null || answer === "") return;
    const open = findOpenQuestion(this.db, sessionId);
    if (open === null) return;
    const recovery = listCloseoutRecoveries(this.db, open.itemId).find(
      (entry) => entry.questionId === open.id,
    );
    let answeredBy = event.activityId ? `linear-activity:${event.activityId}` : "linear";
    try {
      const payload = JSON.parse(event.payload) as { answeredBy?: unknown; questionId?: unknown };
      if (typeof payload.questionId === "string" && payload.questionId !== open.id) return;
      if (typeof payload.answeredBy === "string" && payload.answeredBy.trim())
        answeredBy = payload.answeredBy;
    } catch {}
    if (recovery) {
      const parsed = parseRecoveryAnswer(answer, recovery.failedChecks);
      const identifiable = answeredBy !== "linear" && answeredBy !== "unknown";
      const item = getWorkItem(this.db, open.itemId);
      if (item === null || item.state !== "awaiting_input") return;
      immediate(this.db, () => {
        if (answerQuestion(this.db, open.id, { answer, answeredBy, now: this.now() }) === null)
          return;
        if (parsed === null || (parsed.kind === "bypass" && !identifiable)) {
          this.openCloseoutQuestion(
            item,
            sessionId,
            recovery,
            "Use /paws bypass check-id -- your reason from an identifiable trusted account, or reply with guidance.",
          );
          return;
        }
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
      });
      await this.flush();
      return;
    }
    const stored = answerQuestion(this.db, open.id, {
      answer,
      answeredBy,
      now: this.now(),
    });
    if (stored === null) return;
    const waiter = this.waiters.get(open.id);
    this.waiters.delete(open.id);
    immediate(this.db, () => {
      const item = getWorkItem(this.db, open.itemId);
      if (item?.state === "awaiting_input") {
        applyWorkItemEvent(this.db, item.id, "answer_received");
      }
      if (waiter !== undefined || item === null) return;
      enqueueJob(this.db, {
        queue: JOB_KIND.resume,
        jobKey: `resume:answer:${open.id}`,
        payload: {
          itemId: open.itemId,
          freshSession: true,
          handoff: handoffNote({ question: open.body, answer }),
          reason: "answer",
        },
        now: this.now(),
      });
    });
    waiter?.(answer);
  }

  private stopSession(sessionId: string | null, at: number): void {
    if (sessionId === null) return;
    const requestedAt = at > 0 ? at : this.now();
    for (const item of this.itemsForSession(sessionId)) {
      if (item.state === "completed" || item.state === "merged" || item.state === "cancelled")
        continue;
      submitCommand(this.db, this.bus, {
        type: "stop",
        itemId: item.id,
        source: "linear",
        requestedAt,
      });
    }
    void this.flush();
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
    const run = insertRun(this.db, {
      itemId: item.id,
      now: this.now(),
      status: "active",
      kind: "implement",
      agent: resolveAgentProfiles(
        loadConfigFile(join(this.options.pawsRoot, "config.toml")),
        this.options.repository
          ? `${this.options.repository.owner}/${this.options.repository.repo}`
          : undefined,
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

  private post(
    item: WorkItemRecord,
    kind: "thought" | "action" | "response" | "error",
    body: string,
    key: string,
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
      payload: { sessionId, kind, body },
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

  private postStatus(item: WorkItemRecord, stateType: "started" | "completed" | "canceled"): void {
    const sessionId = this.activitySession(item) ?? item.id;
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "status",
      orderingKey: sessionId,
      idempotencyKey: `status:${item.id}:${stateType}`,
      payload: { linearIssueId: item.linearIssueId, stateType },
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

  private abortItem(itemId: string): void {
    for (const [runId, live] of this.live) {
      if (live.itemId !== itemId) continue;
      live.controller.abort();
      this.live.delete(runId);
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

  private async flush(): Promise<void> {
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const claimed = this.options.outbox.tick();
      await this.options.outbox.idle();
      if (claimed.length === 0) return;
    }
  }

  private stopped(itemId: string): boolean {
    const current = getWorkItem(this.db, itemId);
    return current === null || current.state === "cancelled" || current.cancelRequested;
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

  private agentDeps(item: WorkItemRecord): AcpAgentDeps {
    const runId = item.currentRunId ?? item.id;
    return {
      pawsRoot: this.options.pawsRoot,
      profiles: this.profileSnapshot(runId),
      publishArtifact: this.artifactPublisher(item),
      prepareInputFiles: this.prepareInputFiles(item, runId),
      onCandidate: (identity) => this.saveCandidate(runId, identity),
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
    const repository = this.options.repository;
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
    const repository = this.options.repository!;
    await ensureBareMirror({ ...repository, pawsRoot: this.options.pawsRoot });
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
