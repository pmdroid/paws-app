import { confirmDecision, suggestDecisions } from "../decisions";
import { checkoutPatterns, exclusionPatterns } from "../worktree-checkout";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import type { Database } from "bun:sqlite";
import { join } from "node:path";
import type {
  AcpEvent,
  AskTeamHook,
  AgentIdentity,
  CloseoutProgressHook,
  PostUpdateHook,
  PullRequestHook,
  UpdatePlanHook,
} from "../acp";
import {
  executeItem,
  createUpdateLimiter,
  validateCandidateAttribution,
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
import {
  DEFAULT_QUEUE_START_TIMEOUT_HOURS,
  loadConfigFile,
  readMergeSettings,
  readQueueSettings,
  resolveAgentProfiles,
  repositoryPackages,
  resolveMergeSettings,
  type AgentProfile,
} from "../config";
import {
  approvalsAtHead,
  awaitsVisualReview,
  createCloseoutGate,
  reviewRequirements,
  trustedPolicyFiles,
  trustedRootFiles,
  visualReviewRequirements,
  bypassable,
  snapshotRetryBaseline,
  loggedSessionCloseout,
  readSessionCloseout,
  sessionCloseoutPath,
  sessionCloseoutResult,
  writeSessionCloseout,
  type GateResult,
  type CloseoutVerdict,
  type ResolvedEvidence,
  type CandidateIdentity,
} from "../closeout";
import {
  CommandBus,
  policyCoauthors,
  commitIdentityEnv,
  appBotCommitIdentity,
  policyPullRequestCredit,
  commitPolicyMessage,
  type GitCommitPolicy,
  JOB_KIND,
  OUTBOX_ACTIVITY,
  delegationIssueIdSql,
  isTerminalWorkItemState,
  parentTaskKeySql,
  type Clock,
  type LinearCommand,
  type RepositoryBinding,
  PawsShutdown,
  RunnerSlotsBusyError,
  queueLine,
  systemClock,
  parseLinearCommand,
  isTransientFailure,
  MAX_TRANSIENT_RETRIES,
  RUNNER_CAPACITY_WAIT_MS,
  RunnerCapacityWait,
  RunnerSetupRequired,
  type RunnerSetupNeed,
  placementWaitMs,
  retryNote,
  transientRetryDelayMs,
} from "../core";
import {
  getTaskMode,
  assertLinearSessionCleanup,
  cancelOpenJobs,
  getLinearSessionAccess,
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
  completeMergedItem,
  completeArtifactTask,
  artifactPublicationReady,
  listArtifacts,
  getTaskClassification,
  resolveTaskClassification,
  applyWorkItemEvent,
  configureWorkItem,
  enqueueJobOnce,
  recordRebaseReturn,
  enqueueOutboxOnce,
  attachSessionUpdates,
  getOutbox,
  failWorkItem,
  getQueuePosition,
  clearQueueWait,
  queueWaitSince,
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
  getPullRequestDraft,
  savePullRequestDraft,
  recordAgentCloseout,
  immediate,
  insertRun,
  listInFlightItems,
  listCloseoutRecoveries,
  listCloseoutRounds,
  runRunnerAvailability,
  setRunningCloseoutStepDetail,
  startCloseoutRound,
  markRun,
  releaseRunCapacity,
  saveCheckpoint,
  saveVisualReviewMarks,
  type VisualReviewMark,
  saveRunResult,
  saveRunCommitPolicy,
  getItemRunCommitPolicy,
  bindLinearSessionTask,
  ensureLinearSession,
  activateLinearItem,
  workItemForSession,
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
  listRepositoryCatalog,
  listRepositoryCandidates,
  type Job,
  type JobLoop,
  type JobContext,
  type OutboxDeliveryContext,
  type OutboxDispatcher,
  type OutboxRow,
  type WorkItemRecord,
  type RunnerCapacityWaitState,
  deferWorkItem,
  enqueueRunnerSetupCheck,
  holdForRunnerSetup,
  listRunnerSetupHolds,
  markRunnerSetupNotified,
  releaseRunnerSetupHold,
  takeRunnerSetupResume,
  runnerAgentName,
  runnerCapacityWait,
  runnerSlotFree,
  getTaskMergeSettings,
  getTaskLinearRead,
  keepTaskLinearRead,
  linearActivitiesListedAt,
  markLinearActivitiesListed,
  keepTaskMergeSettings,
  type TaskMergeSettings,
  delegatedLinearUserId,
  resetAwakeTime,
} from "../db";
import {
  publishAccepted,
  closeStoppedPull,
  fetchUpstreamMain,
  mergedPullHeads,
  UPSTREAM_MAIN_REF,
  type GitHubBinding,
  type GitHubTokenProvider,
  type ReverifyInput,
} from "../github";
import { intakeDelegatedIssue, stopAdoptedParent, type IntakeResult } from "../intake";
import {
  createAdmission,
  dispatch,
  projectLeadId,
  type ItemAdmission,
  type SchedulerOptions,
} from "../scheduler";
import type {
  AcceptedLinearEvent,
  DependencyEdge,
  EpicSnapshot,
  ProgressUpdate,
  SessionPlanStep,
  TrackerAdapter,
  TrackerRequestOptions,
  LinearActivitySnapshot,
  LinearFileTransfer,
  RepositoryHints,
  RepositorySuggestion,
  LinearMergeContext,
  IntakeDecision,
  ProjectOverview,
} from "../linear";
import {
  FIRST_ACTIVITY_BODY,
  LinearIntakePendingError,
  LinearIntakeRefusedError,
  LinearRateLimitError,
  currentLinearCaller,
  linearCaller,
  linearItem,
  isMergeConflictRequest,
  parseLinearSessionContext,
  renderLinearSessionContext,
} from "../linear";
import {
  answer as answerAsked,
  answerer,
  ask,
  canAnswer,
  cancelItemQuestions,
  cancelQuestion,
  findAskedQuestion,
  findOpenQuestion,
  handoffNote,
  acceptedVisualReviews,
  getQuestion,
  getVisualReview,
  parseVisualReviewAnswer,
  markVisualReviewStale,
  questionReplyConsumed,
  visualReviewStaleHandoff,
  VISUAL_REVIEW_ANSWERERS,
  VISUAL_REVIEW_DESCRIBE,
  type StoredQuestion,
  type StoredVisualReview,
} from "../questions";
import {
  askForVisualReview,
  carryVisualReview,
  dueVisualReview,
  planVisualReviewCarry,
  postNote,
  remindVisualReview,
  reviewable,
  visualReviewApprovals,
  visualReviewPullRequestNote,
  visualReviewHandoff,
} from "./visual-review";
import {
  acceptCloseout,
  applyCloseoutAcceptance,
  retryMergeLater,
  waitForMergeTurn,
  waitForRunnerSlot,
  type VerificationOwner,
} from "./merge-jobs";
import {
  REBASE_CONFLICT_INSTRUCTION,
  advanceMerge,
  ciWaitVerification,
  parkMerge,
  rebaseBudgetFor,
  wakeMergesBehind,
  type MergePublication,
  type MergeStep,
  type MergeVerdict,
  type MergeWait,
  type OrderCapabilities,
  type RebaseConflict,
} from "../merge";
import {
  createAcpActivityReporter,
  FIRST_ACTIVITY_MS,
  KEEPALIVE_MS,
  publicToolText,
} from "./activity";
import { parseRecoveryAnswer, recoveryOptions } from "./closeout-recovery";
import { askCloseoutHelp } from "./closeout-help";
import { createDbCloseoutProgress } from "./closeout-progress";
import { itemPathId, taskBranchKey, worktreeBranch } from "./sources";
import {
  createAcpCodexReviewer,
  createAcpFixRunner,
  closeoutChecksPrompt,
  implementPrompt,
  POST_UPDATE_PROMPT,
  type AgentLaunch,
  type AcpAgentDeps,
} from "./agents";
import { deliverLinearOutbox } from "./dispatch";
import { durableConversation } from "./conversation";
import { createLinearSessionProgress } from "./session-progress";
import { renderWorkBrief } from "./brief";
import { recordLinearSessionEvent, sessionTaskKey } from "./linear-routing";
import {
  createEvidenceArtifactPublisher,
  createLinearArtifactPublisher,
  publishedEvidence,
  type EvidenceSink,
} from "./artifacts";
import { createLinearInputLoader, createReviewMarkLoader } from "./input-files";
import { createTaskPlanner } from "./task-planner";
import { classifyTask } from "./task-classifier";
import type { LinearTaskAccess } from "./linear-task-access";
import { guardGitHubPublication } from "./publication";
import { sweepWorktrees } from "./worktree-sweep";
import {
  KEEP_WAITING,
  MOVE_TO_ANOTHER_RUNNER,
  waitForRunner,
  type RunnerWaitQuestion,
} from "./runner-wait";
import { createRepositoryGit } from "./repository-git";
import { RUNTIME_FILES, runtimeList, type RuntimeList } from "../runtimes";
import { questionEffects } from "./question-effects";
import { GitHubInstallationCheck, type GitHubIntegration } from "./github-integration";
import {
  interpretRepositoryAnswer,
  chooseRepository,
  hintedRepository,
  repositoryAnswer,
} from "./repository-selection";

export type { RepositoryBinding } from "../core";

export type OrchestratorOptions = {
  db: Database;
  jobs: JobLoop;
  outbox: OutboxDispatcher;
  pawsRoot: string;
  home?: string;
  closeoutPolicyRoot?: (repository: RepositoryBinding) => string | undefined;
  tracker?: TrackerAdapter | null;
  linearTaskModes?: boolean;
  linearAccess?: LinearTaskAccess;
  authorizeLinearEvent?: (event: AcceptedLinearEvent) => Promise<IntakeDecision>;
  recheckLinearEvent?: (event: AcceptedLinearEvent) => boolean | Promise<boolean>;
  remoteFollowUp?: (itemId: string, body: string) => boolean | Promise<boolean>;
  outboxWaitMs?: number;
  authorizeLinearIntake?: (sessionId: string, snapshot: EpicSnapshot) => boolean;
  linearIntakeScope?: (sessionId: string, snapshot: EpicSnapshot) => EpicSnapshot;
  linearIntakeActor?: (sessionId: string) => string | undefined;
  onLinearIntake?: (sessionId: string, result: IntakeResult) => void;
  adoptLinearParent?: (
    sessionId: string,
    snapshot: EpicSnapshot,
    edges: readonly DependencyEdge[],
  ) => boolean;
  /** The workspace GitHub App installation. Repository reads and pull requests wait for it. */
  githubInstallation?: GitHubIntegration;
  files?: LinearFileTransfer | null;
  secretsDir?: string;
  /**
   * Closeout videos and screenshots. Links are `<publicUrl>/evidence/<id>`. With `root` and
   * `files`, the files are also uploaded to Linear and shown inline.
   */
  evidence?: { store: EvidenceSink; publicUrl: string; root?: string } | null;
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
  commitPolicyForItem?: (item: WorkItemRecord) => Promise<GitCommitPolicy | undefined>;
  launch?: AgentLaunch;
  remoteExecution?: {
    cancelItem?(itemId: string): Promise<void>;
    slotFree?(): boolean;
    agentForSession(sessionId: string, purpose: "classify" | "select_repository"): typeof runAgent;
    agentForItem(itemId: string): (options: RunAgentOptions) => Promise<RunAgentResult>;
  };
  remoteCloseoutRetry?: { attempts: number; delayMs: number };
  /** How often Closeout rechecks an unavailable runner, and when it asks the team. */
  runnerWait?: { pollMs: number; askAfterMs: number };
  publicationReady?: (
    itemId: string,
    phase: "publish" | "merge",
    signal?: AbortSignal,
    candidate?: { sha: string; baseSha: string },
  ) => boolean | Promise<boolean>;
  admission?: ItemAdmission;
  journal?: (line: string) => void;
  scheduling?: () => Pick<SchedulerOptions, "defaultRepository" | "ownerCap">;
  /**
   * Whether the item's owner has a runner they may use for this agent. False keeps a queued
   * item out of the slot line and its start timeout. Null when it cannot tell. SQLite only.
   */
  ownerHasRunner?: (itemId: string, agent: string, now: number) => boolean | null;
  /**
   * Why the item's owner has no runner they may use for this agent, for the runner-setup hold
   * and its thought. Null when a runner is usable or only offline. SQLite only.
   */
  runnerSetupNeed?: (itemId: string, agent: string, now: number) => RunnerSetupNeed | null;
  /**
   * A runner the item's owner may use for this agent now, for the line that resumes a
   * runner-setup hold. Null when none is eligible. SQLite only.
   */
  eligibleRunner?: (
    itemId: string,
    agent: string,
    now: number,
  ) => { id: string; name: string } | null;
  clock?: Clock;
  caps?: { maxTurns: number; maxAwakeMs: number };
  retryBaseMs?: number;
  placementPollMs?: number;
  /**
   * The page where a delegator without a usable runner creates a VM, adds a host or signs an
   * agent in. Missing means the local Runners page.
   */
  runnersUrl?: string;
};

export type ExecutionChanges = {
  delegationId: string;
  sessionId: string;
  addedItemIds: readonly string[];
  removedItemIds: readonly string[];
  specChangedItemIds: readonly string[];
  canceledItemIds: readonly string[];
  parentCanceled: boolean;
};

class LinearReconciliationPendingError extends Error {}

type MergeRun = {
  payload: unknown;
  closeoutFailure: CloseoutVerdict | null;
  publicationCandidate?: { sha: string; baseSha: string };
  candidate?: CandidateIdentity;
  verifying?: WorkItemRecord;
  signal?: AbortSignal;
};

const LINEAR_ACCESS_CHANGED: IntakeDecision = {
  outcome: "refused",
  reason: "Access to this session changed while Paws waited to start it.",
};
/**
 * One process loop: intake, one item at a time, ACP, Closeout, pull request, serial merge.
 * Linear effects go through the outbox. State changes go through `transition()`.
 */
export class Orchestrator {
  readonly bus = new CommandBus();
  private tracker: TrackerAdapter | null;
  private catchUpFn: () => Promise<void>;
  private readonly askedRuns = new Set<string>();
  private readonly pullRequestReads = new Set<string>();
  private readonly live = new Map<
    string,
    {
      itemId: string;
      sessionId: string | null;
      generation: number;
      controller: AbortController;
      progress: string | null;
      done: Promise<void>;
      finish(): void;
    }
  >();
  private readonly stopEvents = new Map<string, Promise<void>>();
  private readonly sessionEvents = new Map<string, Promise<void | boolean>>();
  private readonly intakeReads = new Map<
    string,
    { snapshot: EpicSnapshot; edges: DependencyEdge[] }
  >();
  private readonly conversations = new Map<
    string,
    (options: RunAgentOptions) => Promise<RunAgentResult>
  >();
  private readonly jobContexts = new Map<string, JobContext>();
  private readonly runtimeLists = new Map<string, { runId: string; list: RuntimeList }>();
  private shuttingDown = false;
  private activitySeq = 0;
  private readonly activityRequests = new Map<number, AbortSignal>();
  private readonly updates = createUpdateLimiter(() => this.now());
  private readonly inputLoader: ReturnType<typeof createLinearInputLoader> | null;
  private readonly taskPlanner: ReturnType<typeof createTaskPlanner>;
  private readonly githubAuth: GitHubInstallationCheck | null;
  private readonly authRecoveryController = new AbortController();
  private authRecovery: Promise<void> | null = null;
  private readonly admission: ItemAdmission;

  constructor(private readonly options: OrchestratorOptions) {
    this.tracker = options.tracker ?? null;
    this.admission = options.admission ?? createAdmission({ db: options.db });
    this.githubAuth = options.githubInstallation
      ? new GitHubInstallationCheck(
          options.db,
          options.githubInstallation,
          () => this.now(),
          (item) =>
            !this.taskAccess() ||
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
      agentForSession: options.remoteExecution
        ? (sessionId) => options.remoteExecution!.agentForSession(sessionId, "classify")
        : undefined,
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

  takeIntakeReads(
    sessionId: string,
  ): { snapshot: EpicSnapshot; edges: DependencyEdge[] } | undefined {
    const reads = this.intakeReads.get(sessionId);
    this.intakeReads.delete(sessionId);
    return reads;
  }

  async onLinearEvent(event: AcceptedLinearEvent): Promise<void | boolean> {
    if (this.shuttingDown) throw new Error("Paws is shutting down");
    const decision = await this.options.authorizeLinearEvent?.(event);
    if (!this.admitLinearEvent(event, decision)) return false;
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
    await this.taskAccess()?.assertOpenIssue(event);
    let turnEventKey = event.dedupeKey;
    if (
      event.action === "prompted" &&
      event.sessionId &&
      event.body !== null &&
      (!findOpenQuestion(this.db, event.sessionId) || this.hasPublishedPullRequest(event.sessionId))
    ) {
      const turn = this.recordTurn(event);
      if (turn) turnEventKey = turn.eventKey;
      if (
        turn?.state === "pending" &&
        !this.hasPublishedPullRequest(event.sessionId) &&
        (await this.forwardFollowUp(event.sessionId, turn))
      )
        return;
      if (turn && announceLinearTurn(this.db, event.sessionId, turn.eventKey, this.now())) {
        for (const live of this.live.values())
          if (this.itemsForSession(event.sessionId).some((item) => item.id === live.itemId))
            live.controller.abort(FOLLOW_UP_INTERRUPTION);
        await this.stopTaskPlanning(event.sessionId);
      }
    }
    const key = event.sessionId ?? event.issueId ?? event.dedupeKey;
    const previous = this.sessionEvents.get(key) ?? Promise.resolve();
    const done = previous
      .catch(() => undefined)
      .then(async () => {
        const current =
          (await this.options.recheckLinearEvent?.(event)) === false
            ? LINEAR_ACCESS_CHANGED
            : decision;
        if (!this.admitLinearEvent(event, current, true)) {
          if (event.sessionId !== null)
            discardLinearTurns(this.db, event.sessionId, [turnEventKey]);
          return false;
        }
        const open = event.sessionId ? findOpenQuestion(this.db, event.sessionId) : null;
        const questionDelegationId = open ? getWorkItem(this.db, open.itemId)?.delegationId : null;
        await this.handleLinearEvent(event);
        if (event.action === "prompted" && event.sessionId) {
          const delegationId =
            workItemForSession(this.db, event.sessionId)?.delegationId ?? questionDelegationId;
          if (delegationId) this.reconcileExecution();
        }
      });
    this.sessionEvents.set(key, done);
    try {
      return await done;
    } finally {
      if (this.sessionEvents.get(key) === done) this.sessionEvents.delete(key);
    }
  }

  private admitLinearEvent(
    event: AcceptedLinearEvent,
    decision: IntakeDecision | undefined,
    last = false,
  ): boolean {
    if (decision === undefined) return true;
    const created = event.action === "created" && event.signal !== "stop";
    if (created && (last || decision.outcome !== "accepted")) {
      const reason = decision.outcome === "accepted" ? "" : `: ${decision.reason}`;
      console.error(
        `linear intake ${event.issueId ?? "-"} session ${event.sessionId ?? "-"} ${decision.outcome}${reason}`,
      );
    }
    if (decision.outcome === "accepted") return true;
    if (decision.outcome === "retry") throw new LinearIntakePendingError(decision.reason);
    if (created)
      throw new LinearIntakeRefusedError(decision.reason, { quiet: decision.quiet === true });
    return false;
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
      ...items
        .filter((item) => item.state !== "merged" && item.state !== "completed")
        .map((item) => this.options.remoteExecution?.cancelItem?.(item.id)),
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
    for (const live of owned) live.controller.abort(new PawsShutdown());
    const joined = await Promise.allSettled([
      this.authRecovery,
      this.stopTaskPlanning(),
      ...owned.map((live) => live.done),
    ]);
    await Promise.allSettled([...this.sessionEvents.values(), ...this.stopEvents.values()]);
    if (this.allItems(true).some((item) => getConversation(this.db, item.id).blocked))
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
      if (event.sessionId && event.body) {
        const session = recordLinearSessionEvent(this.db, event, this.now());
        if (questionItem && session && !workItemForSession(this.db, event.sessionId)) {
          bindLinearSessionTask(this.db, event.sessionId, questionItem.delegationId);
          activateLinearItem(this.db, event.sessionId, questionItem.id);
        }
        const turn = this.recordTurn(event);
        if (turn?.state !== "pending") return;
        event = { ...event, dedupeKey: turn.eventKey, body: turn.body, payload: turn.payload };
      }
      if (!question && event.sessionId) {
        await this.resumeLinearSession(event.sessionId);
        return;
      }
      const outcome = await this.deliverPrompt(
        event,
        Boolean(
          event.sessionId &&
          questionItem &&
          question &&
          !isWorkItemRepositoryQuestion(this.db, questionItem.id, question.id) &&
          ["answer", "artifact"].includes(getTaskMode(this.db, questionItem.id) ?? ""),
        ),
      );
      if (event.sessionId) {
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
    const session = recordLinearSessionEvent(this.db, event, this.now());
    const taskKey = session ? sessionTaskKey(this.db, session) : null;
    if (session?.stoppedAt !== null && session?.stoppedAt !== undefined) return;
    let result: IntakeResult;
    try {
      result = await this.intakeLinearTask(event.issueId, event.sessionId, taskKey ?? undefined, {
        acknowledged: session !== null,
      });
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
      this.dispatch();
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
        `ack:${event.dedupeKey}:${update.kind}${update.kind === "thought" && update.body !== FIRST_ACTIVITY_BODY ? ":pending" : ""}`,
        (event.sessionId
          ? getLinearTurnGeneration(this.db, event.sessionId, event.dedupeKey, event.activityId)
          : null) ?? generation,
        request,
        event.action === "created" &&
          update.kind === "thought" &&
          update.body === FIRST_ACTIVITY_BODY,
      );
  }

  private startPost(id: number): void {
    const row = getOutbox(this.db, id);
    if (row?.orderingKey == null) return;
    attachSessionUpdates(this.db, id, this.now());
    this.db.run(
      `UPDATE outbox SET status = 'dropped', error = ? WHERE target = 'linear' AND ordering_key = ?
        AND op = 'activity' AND status = 'pending' AND attempts = 0
        AND (locked_until IS NULL OR locked_until <= ?) AND json_extract(payload, '$.body') = ?`,
      [`Sent as outbox ${id}.`, row.orderingKey, this.now(), FIRST_ACTIVITY_BODY],
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
    const linearIdentifier = currentLinearCaller().item;
    const id = enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "activity",
      orderingKey: update.sessionId,
      idempotencyKey,
      payload: {
        ...update,
        id: update.id ?? crypto.randomUUID(),
        // Delivered later from the outbox, so it keeps the issue it counts toward.
        ...(linearIdentifier === undefined ? {} : { linearIdentifier }),
      },
      ...(initialActivity
        ? { delivery: "critical", notBefore: this.now() + FIRST_ACTIVITY_HOLD_MS }
        : {}),
      ...(generation === undefined ? {} : { generation }),
      now: this.now(),
    });
    if (request?.signal) this.activityRequests.set(id, request.signal);
    if (initialActivity) {
      const forget = () => {
        if (this.activityRequests.get(id) === request?.signal) this.activityRequests.delete(id);
      };
      request?.signal?.addEventListener("abort", forget, { once: true });
      const held = setTimeout(() => {
        if (!this.shuttingDown)
          void this.flush(request?.signal, update.sessionId)
            .catch(() => undefined)
            .finally(forget);
      }, FIRST_ACTIVITY_HOLD_MS);
      held.unref?.();
      return;
    }
    try {
      await this.flush(request?.signal, update.sessionId);
      request?.signal?.throwIfAborted();
    } finally {
      if (this.activityRequests.get(id) === request?.signal) this.activityRequests.delete(id);
    }
  }

  async intakeLinearTask(
    issueId: string,
    sessionId: string | null,
    taskKey?: string,
    options: {
      followupBodies?: readonly string[];
      conversation?: string;
      acknowledged?: boolean;
    } = {},
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
    const progressTracker = sessionId
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
    let authorizedSnapshot: EpicSnapshot | null = null;
    let loadedSnapshot: EpicSnapshot | null = null;
    const edges: DependencyEdge[] = [];
    const listDeps = async (id: string) => {
      const found = await progressTracker.listDeps(id);
      edges.push(...found);
      return found;
    };
    const authorizeSnapshot = (snapshot: EpicSnapshot) => {
      loadedSnapshot = snapshot;
      if (sessionId && this.options.authorizeLinearIntake?.(sessionId, snapshot) === false)
        throw new Error("The Linear assignment changed before intake.");
      authorizedSnapshot = snapshot;
      return sessionId
        ? (this.options.linearIntakeScope?.(sessionId, snapshot) ?? snapshot)
        : snapshot;
    };
    let intakeTracker = {
      ...progressTracker,
      listDeps,
      loadEpic: async (id: string) => authorizeSnapshot(await progressTracker.loadEpic(id)),
    };
    const deferred = !savedRequest && this.options.remoteExecution?.slotFree?.() === false;
    const snapshot =
      this.options.linearTaskModes && sessionId && taskKey && !deferred
        ? authorizeSnapshot(await tracker.loadEpic(issueId))
        : null;
    if (snapshot) intakeTracker = { ...progressTracker, listDeps, loadEpic: async () => snapshot };
    const openSubIssues = snapshot?.subIssues.some(
      (issue) => !["completed", "canceled"].includes(issue.stateType ?? ""),
    );
    const classification =
      sessionId && taskKey && snapshot && (savedRequest || openSubIssues)
        ? await this.taskPlanner
            .plan({
              taskKey,
              sessionId,
              request: (signal) => this.classificationRequest(sessionId, snapshot, signal, options),
            })
            .catch((error: unknown) => {
              if (error instanceof RunnerSlotsBusyError && !savedRequest) return null;
              throw error;
            })
        : null;
    if (!isCurrent()) throw new Error("The Linear request changed before intake");
    const retireRedirectedItem = () => {
      if (!redirect) return;
      const previous = getWorkItem(this.db, redirect.itemId);
      if (!previous || previous.state === "cancelled") return;
      applyWorkItemEvent(this.db, previous.id, "cancel");
      if (previous.currentRunId) markRun(this.db, previous.currentRunId, "ended", this.now());
      this.db.run(
        "UPDATE job SET status = 'cancelled', finished_at = ? WHERE status = 'pending' AND json_extract(payload,'$.itemId') = ?",
        [this.now(), previous.id],
      );
    };
    const assignUnownedItems = (actorId: string | null, items: readonly { id: string }[]) => {
      if (items.length === 0 || !actorId) return;
      const ownerId = this.db
        .query<{ id: string }, [string]>("SELECT id FROM workspace_user WHERE linear_user_id=?")
        .get(actorId)?.id;
      if (!ownerId) return;
      for (const item of items)
        this.db.run("UPDATE work_item SET owner_user_id=? WHERE id=? AND owner_user_id IS NULL", [
          ownerId,
          item.id,
        ]);
    };
    const intakeCurrent = () =>
      isCurrent() &&
      (!sessionId ||
        authorizedSnapshot === null ||
        this.options.authorizeLinearIntake?.(sessionId, authorizedSnapshot) !== false);
    const result = await intakeDelegatedIssue(this.db, intakeTracker, {
      linearIssueId: issueId,
      sessionId,
      acknowledged: options.acknowledged,
      isCurrent: intakeCurrent,
      reconcileSessions: sessionId
        ? (issueIds) => this.reconcilePreviousSessions(issueIds, sessionId, intakeCurrent)
        : undefined,
      beforeAdmit: retireRedirectedItem,
      onAccepted: (accepted) => {
        immediate(this.db, () => {
          retireRedirectedItem();
          if (accepted.ok && options.conversation)
            for (const child of accepted.items) {
              const stored = getConversation(this.db, child.id);
              if (stored.entries === "[]" && !stored.transcript)
                saveConversation(this.db, child.id, options.conversation, null);
            }
          if (sessionId !== null) {
            const actorId =
              this.options.linearIntakeActor?.(sessionId) ??
              getLinearSession(this.db, sessionId)?.creatorId ??
              null;
            if (initialSession)
              bindLinearSessionTask(this.db, sessionId, accepted.delegation.id, { actorId });
            this.assignSession(accepted.delegation.id, sessionId);
            this.options.onLinearIntake?.(sessionId, accepted);
            if (accepted.ok) assignUnownedItems(actorId, accepted.items);
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
      adoptParent: this.options.adoptLinearParent,
    });
    if (!isCurrent()) throw new Error("The Linear request changed during intake");
    if (sessionId && loadedSnapshot && !result.alreadyExisted)
      this.intakeReads.set(sessionId, { snapshot: loadedSnapshot, edges });
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

  private async classificationRequest(
    sessionId: string,
    snapshot: EpicSnapshot,
    signal: AbortSignal,
    options: { followupBodies?: readonly string[]; conversation?: string } = {},
  ): Promise<string> {
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
  }

  private async reconcilePreviousSessions(
    issueIds: readonly string[],
    incomingSessionId: string,
    isCurrent: () => boolean,
  ): Promise<void> {
    if (!this.tracker?.getSession) return;
    const candidates = (issueId: string) =>
      this.db
        .query<{ session_id: string }, [string, string]>(
          `SELECT DISTINCT previous.session_id FROM work_item item
       JOIN linear_session previous ON previous.session_id = item.session_key
       JOIN linear_session incoming ON incoming.session_id = ?
         AND incoming.organization_id = previous.organization_id
         AND incoming.oauth_client_id = previous.oauth_client_id
         AND incoming.app_user_id = previous.app_user_id
         AND incoming.team_id = previous.team_id
       WHERE item.linear_issue_id = ? AND item.session_key != incoming.session_id
         AND item.state NOT IN ('completed', 'merged')`,
        )
        .all(incomingSessionId, issueId);
    try {
      for (const issueId of issueIds) {
        for (const { session_id: sessionId } of candidates(issueId)) {
          const previous = getLinearSession(this.db, sessionId)!;
          const unfinished = this.itemsForSession(sessionId).some(
            (item) => !isTerminalWorkItemState(item.state),
          );
          if (previous.stoppedAt === null && unfinished) {
            const snapshot = await this.tracker.getSession(sessionId, {
              signal: AbortSignal.any([
                this.authRecoveryController.signal,
                AbortSignal.timeout(10_000),
              ]),
            });
            if (
              !isCurrent() ||
              getLinearSession(this.db, sessionId)?.generation !== previous.generation ||
              !candidates(issueId).some((candidate) => candidate.session_id === sessionId)
            )
              throw new Error("Linear session ownership changed");
            if (
              snapshot.id !== sessionId ||
              snapshot.appUserId !== previous.appUserId ||
              snapshot.issue?.id !== previous.issueId
            )
              throw new Error("Linear session identity changed");
            if (
              !snapshot.endedAt &&
              !snapshot.dismissedAt &&
              !["complete", "error", "stopping"].includes(snapshot.status)
            )
              continue;
            await this.stopSession(
              sessionId,
              `reconcile:${sessionId}:${previous.generation}`,
              this.now(),
            );
          } else {
            await this.interruptLinearSession(sessionId);
          }
          if (!isCurrent()) throw new Error("Linear intake changed during cleanup");
          assertLinearSessionCleanup(this.db, sessionId);
        }
      }
    } catch (cause) {
      throw new LinearIntakePendingError(
        "Paws is checking the previous session and waiting for its work to stop safely. This request will retry automatically.",
        { cause },
      );
    }
  }

  stopTaskPlanning = (sessionId?: string): Promise<void> => this.taskPlanner.stop(sessionId);

  private get db(): Database {
    return this.options.db;
  }

  private forItem<T>(payload: unknown, run: () => T): T {
    const itemId = readString(payload, "itemId");
    const item = itemId ? getWorkItem(this.db, itemId) : null;
    if (item) return linearItem(item.linearIdentifier, run, item.id);
    // A write for a session that has no item yet, such as a first delegation's sign-in action.
    const identifier = readString(payload, "linearIdentifier");
    return identifier ? linearItem(identifier, run) : run();
  }

  private register(): void {
    const loop = this.options.jobs;
    const jobs: Pick<typeof loop, "register"> = {
      register: (queue, handler) =>
        loop.register(queue, (job, context) =>
          this.forItem(job.payload, () => handler(job, context)),
        ),
    };
    jobs.register(JOB_KIND.command, async (job, context) => {
      if (!context.isCurrent()) return;
      const command = parseLinearCommand(job.payload);
      if (!command || !applyLinearCommand(this.db, command, this.now()).applied) return;
      try {
        this.bus.emit(command);
      } finally {
        await this.interruptItem(command.itemId);
      }
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
    jobs.register(JOB_KIND.visualReviewReminder, async (job, context) => {
      const questionId = readString(job.payload, "questionId");
      if (!context.isCurrent() || questionId === null) return;
      if (remindVisualReview(this.db, questionId, this.now())) await this.flush();
    });
    jobs.register(JOB_KIND.runnerSetupCheck, (job) => {
      const owner = readString(job.payload, "ownerUserId");
      if (owner !== null) this.checkRunnerSetup(owner);
    });
    jobs.register(JOB_KIND.start, (job, context) =>
      this.runLeasedJob(job.payload, context, () => this.executeRetried(job, context)),
    );
    jobs.register(JOB_KIND.resume, async (job, context) => {
      if (this.waitingForRunnerSlot(job)) return;
      await this.runLeasedJob(job.payload, context, () => this.executeRetried(job, context));
    });
    jobs.register(JOB_KIND.reverify, async (job, context) => {
      if (this.waitingForRunnerSlot(job)) return;
      await this.failOnLastAttempt(job, context, "reverify", async () => {
        try {
          await this.runLeasedJob(job.payload, context, () =>
            this.runOwnedJob(job.payload, () => this.reverify(job.payload, job.id)),
          );
        } catch (error) {
          const wait = this.nextRunnerWait(job, error);
          if (!wait || !context.isCurrent()) throw error;
          waitForRunnerSlot(this.db, job, this.now(), this.runnerWaitMs(wait), wait);
        }
      });
    });
    jobs.register(JOB_KIND.merge, async (job, context) => {
      const ownerId = readString(job.payload, "itemId");
      if (ownerId !== null && this.jobContexts.has(ownerId)) {
        if (context.isCurrent()) waitForMergeTurn(this.db, job, this.now());
        return;
      }
      let waiting: MergeWait | undefined;
      try {
        await this.mergeAttempt(job, context, (wait) => {
          waiting = wait;
        });
      } catch (error) {
        if (this.shuttingDown || job.attempts >= job.maxAttempts || !context.isCurrent())
          throw error;
        const delayMs = transientRetryDelayMs(job.attempts, error, this.options.retryBaseMs);
        const message = error instanceof Error ? error.message : String(error);
        console.error(
          `merge job ${job.id} attempt ${job.attempts} of ${job.maxAttempts} failed, retrying in ${delayMs} ms: ${message}`,
        );
        if (!retryMergeLater(this.db, job, this.now(), delayMs, error)) throw error;
        return;
      }
      if (waiting === undefined) return;
      if (parkMerge(this.db, job, this.now(), waiting) !== "expired") return;
      const itemId = readString(job.payload, "itemId");
      const item = itemId ? getWorkItem(this.db, itemId) : null;
      if (item)
        this.fail(
          item,
          "merge",
          withAcceptedBranch(`merge timed out waiting for GitHub: ${waiting.message}`, item),
        );
    });
    jobs.register(JOB_KIND.closeStoppedPull, async (job, context) => {
      const itemId = readString(job.payload, "itemId");
      const item = itemId ? getWorkItem(this.db, itemId) : null;
      if (!item || item.state !== "cancelled" || getConfirmedRemoteMerge(this.db, item.id)) return;
      await this.joinChangedItems([item.id]);
      const repository = this.repositoryForItem(item);
      const github = repository ? this.githubForRepository(repository) : null;
      if (!repository || !github) return;
      context.signal.throwIfAborted();
      await closeStoppedPull({
        client: github.client,
        owner: repository.owner,
        repo: repository.repo,
        branch: worktreeBranch(item),
        ...this.gitHubCredentials(github),
        signal: context.signal,
      });
    });
    this.options.outbox.setHandler((message, context) =>
      linearCaller(
        "outbox",
        () => this.forItem(message.payload, () => this.deliverLinearMessage(message, context)),
        message.op === "elicitation" ||
          message.delivery === "critical" ||
          message.delivery === "stop" ||
          message.delivery === "terminal"
          ? "critical"
          : "normal",
      ),
    );
  }

  private async mergeAttempt(
    job: Job,
    context: JobContext,
    onWait: (wait: MergeWait | undefined) => void,
  ): Promise<void> {
    await this.failOnLastAttempt(job, context, "merge", () =>
      this.runLeasedJob(job.payload, context, async () => {
        try {
          await this.runOwnedJob(job.payload, async () => {
            const step = await this.merge(job.payload, job.id);
            if (step.kind === "wait") onWait(step);
            else await this.settleMerge(job.payload, step);
          });
        } catch (error) {
          if (!(error instanceof LinearReconciliationPendingError)) throw error;
          immediate(this.db, () => {
            if (!context.isCurrent()) throw context.signal.reason;
            enqueueJobOnce(this.db, {
              queue:
                getWorkItem(this.db, readString(job.payload, "itemId")!)?.state === "verifying"
                  ? JOB_KIND.reverify
                  : job.queue,
              lane: job.lane,
              priority: job.priority,
              payload: job.payload,
              jobKey: `merge-reconciliation:${job.id}`,
              now: this.now(),
              runAt: this.now() + 30000,
            });
          });
        }
      }),
    );
  }

  private async deliverLinearMessage(
    message: OutboxRow,
    context: OutboxDeliveryContext,
  ): Promise<void> {
    if (message.target !== "linear") return;
    const requestSignal = this.activityRequests.get(message.id);
    if (requestSignal)
      context = { ...context, signal: AbortSignal.any([context.signal, requestSignal]) };
    context.signal.throwIfAborted();
    const tracker = this.tracker;
    if (tracker === null) throw new Error("Linear is not connected");
    if (
      this.options.linearAccess &&
      message.orderingKey &&
      message.op !== "catchup" &&
      message.op !== "linear.catchup"
    ) {
      const itemId =
        readString(message.payload, "itemId") ??
        (message.orderingKey ? workItemForSession(this.db, message.orderingKey)?.id : undefined);
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
        fresh: message.op === "status" || message.delivery === "terminal",
        isCurrent: context.isCurrent,
      });
    }
    const files = this.options.files;
    const root = this.options.evidence?.root;
    await deliverLinearOutbox(
      message,
      tracker,
      () => this.catchUpFn(),
      context,
      this.db,
      files && root ? { files, root } : undefined,
    );
  }

  private async executeRetried(job: Job, context: JobContext): Promise<void> {
    try {
      await this.executeQueued(job.payload);
    } catch (error) {
      const itemId = readString(job.payload, "itemId");
      const item = itemId === null ? null : getWorkItem(this.db, itemId);
      if (
        this.shuttingDown ||
        !item ||
        !context.isCurrent() ||
        item.cancelRequested ||
        (item.state !== "running" && item.state !== "verifying" && item.state !== "recovering")
      )
        throw error;
      if (error instanceof RunnerSetupRequired && this.holdForRunnerSetup(item, error.need)) return;
      const wait = this.nextRunnerWait(job, error);
      if (wait) {
        deferWorkItem(this.db, item, {
          retry: retryCount(job.payload),
          delayMs: this.runnerWaitMs(wait),
          handoff: readString(job.payload, "handoff"),
          message: null,
          capacityWait: wait,
          now: this.now(),
        });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isTransientFailure(error)) {
        const retry = retryCount(job.payload) + 1;
        if (retry > MAX_TRANSIENT_RETRIES) {
          this.fail(
            item,
            "run_error",
            `Stopped after ${MAX_TRANSIENT_RETRIES} retries. ${message}`,
            error,
          );
          return;
        }
        const delayMs = transientRetryDelayMs(retry, error, this.options.retryBaseMs);
        console.error(
          `${item.linearIdentifier} retry ${retry} of ${MAX_TRANSIENT_RETRIES} in ${delayMs} ms: ${message}`,
          error,
        );
        deferWorkItem(this.db, item, {
          retry,
          delayMs,
          handoff: readString(job.payload, "handoff"),
          message: retryNote(message, delayMs),
          now: this.now(),
        });
        return;
      }
      if (job.attempts >= job.maxAttempts)
        this.fail(item, "run_error", `Stopped after ${job.attempts} attempts. ${message}`, error);
      throw error;
    }
  }

  /**
   * Put the item back in the queue under a runner-setup hold and say once what is missing. The
   * scheduler skips held items, so nothing retries, times out or writes to Linear until the hold
   * ends. False when the item can no longer be held, so the caller retries as before.
   */
  private holdForRunnerSetup(item: WorkItemRecord, need: RunnerSetupNeed): boolean {
    const now = this.now();
    return immediate(this.db, () => {
      const current = getWorkItem(this.db, item.id);
      if (
        !current ||
        current.cancelRequested ||
        (current.state !== "running" && current.state !== "recovering")
      )
        return false;
      if (current.currentRunId !== null) {
        const run = getRun(this.db, current.currentRunId);
        if (run && (run.status === "active" || run.status === "provisioning"))
          markRun(this.db, run.id, "lost", now);
      }
      applyWorkItemEvent(this.db, current.id, "restart");
      this.recordRunnerSetupHold(current, need, now, current.currentRunId);
      return true;
    });
  }

  /**
   * Write the runner-setup hold of a queued item and post its thought, once per hold. Runs in
   * the caller's transaction.
   */
  private recordRunnerSetupHold(
    current: WorkItemRecord,
    need: RunnerSetupNeed,
    now: number,
    runId: string | null = null,
  ) {
    const hold = holdForRunnerSetup(this.db, {
      itemId: current.id,
      ownerUserId:
        this.db
          .query<{ owner: string | null }, [string]>(
            "SELECT owner_user_id AS owner FROM work_item WHERE id=?",
          )
          .get(current.id)?.owner ?? null,
      reason: need.reason,
      ...(need.reason === "agent-not-signed-in"
        ? { runnerId: need.runnerId, agent: need.agent }
        : {}),
      runId,
      now,
    });
    // A runner may have become usable while placement decided to hold. Check once now, so the
    // hold does not wait for a later write.
    if (hold.ownerUserId !== null) enqueueRunnerSetupCheck(this.db, hold.ownerUserId, now);
    this.options.journal?.(`item ${current.linearIdentifier} held: runner setup (${need.reason})`);
    if (hold.notifiedAt !== null) return;
    const sessionId = this.activitySession(current);
    if (sessionId !== null)
      enqueueOutboxOnce(this.db, {
        target: OUTBOX_ACTIVITY.target,
        op: OUTBOX_ACTIVITY.op,
        orderingKey: sessionId,
        idempotencyKey: `runner-setup:${current.id}:${need.reason}:${need.reason === "agent-not-signed-in" ? `${need.runnerId}:${need.agent}` : ""}`,
        payload: { sessionId, kind: "thought", body: this.runnerSetupLine(need) },
        now,
      });
    markRunnerSetupNotified(this.db, current.id, now);
  }

  /**
   * The `runner_setup.check` job: resume each hold of `ownerUserId` whose owner now has a runner
   * they may use. A resume ends the hold, posts one thought and lets the scheduler start the
   * item, which places it by its normal checks. Reads SQLite only, never Linear.
   */
  private checkRunnerSetup(ownerUserId: string): void {
    const eligibleRunner = this.options.eligibleRunner;
    if (!eligibleRunner) return;
    const holds = listRunnerSetupHolds(this.db, ownerUserId);
    if (holds.length === 0) return;
    const config = loadConfigFile(join(this.options.pawsRoot, "config.toml"));
    const now = this.now();
    let resumed = false;
    for (const hold of holds) {
      const item = getWorkItem(this.db, hold.itemId);
      if (!item || item.state !== "queued" || item.cancelRequested) continue;
      const runner = eligibleRunner(item.id, this.implementerAgent(item, config), now);
      if (!runner) continue;
      resumed =
        immediate(this.db, () => {
          const current = getWorkItem(this.db, item.id);
          if (!current || current.state !== "queued" || current.cancelRequested) return false;
          if (!releaseRunnerSetupHold(this.db, current.id, now)) return false;
          this.options.journal?.(
            `item ${current.linearIdentifier} resumed: runner setup (${runner.name})`,
          );
          const sessionId = this.activitySession(current);
          if (sessionId !== null)
            enqueueOutboxOnce(this.db, {
              target: OUTBOX_ACTIVITY.target,
              op: OUTBOX_ACTIVITY.op,
              orderingKey: sessionId,
              idempotencyKey: `runner-setup-resume:${current.id}:${hold.since}`,
              payload: {
                sessionId,
                itemId: current.id,
                kind: "thought",
                body: `Starting ${current.linearIdentifier ?? "this issue"} on ${runner.name}.`,
              },
              now,
            });
          return true;
        }) || resumed;
    }
    if (resumed) this.dispatch();
  }

  private runnerSetupLine(need: RunnerSetupNeed): string {
    const url = this.options.runnersUrl ?? "http://127.0.0.1:8787/status/runners";
    return need.reason === "no-runner"
      ? `You don't have a runner Paws can use yet. Create a VM or add a host here: ${url}. I'll start on my own once it's ready.`
      : `Your runner ${need.runnerName} needs ${runnerAgentName(need.agent)} signed in. Sign in on the [Runners page](${url}); I'll start right after.`;
  }

  private nextRunnerWait(job: Job, error: unknown): RunnerCapacityWaitState | null {
    if (!(error instanceof RunnerCapacityWait)) return null;
    const waited = runnerCapacityWait(job.payload);
    if (waited && this.now() - waited.since >= RUNNER_CAPACITY_WAIT_MS) return null;
    return {
      since: waited?.since ?? this.now(),
      attempt: waited ? waited.attempt + 1 : 0,
      runnerIds: error.runnerIds,
      ...(error.holdMs === undefined ? {} : { holdMs: error.holdMs }),
    };
  }

  private runnerWaitMs(wait: RunnerCapacityWaitState): number {
    return placementWaitMs(wait.attempt, this.options.placementPollMs);
  }

  private waitingForRunnerSlot(job: Job): boolean {
    const waited = runnerCapacityWait(job.payload);
    const itemId = readString(job.payload, "itemId");
    const item = itemId === null ? null : getWorkItem(this.db, itemId);
    if (
      !waited ||
      !item ||
      item.cancelRequested ||
      !["recovering", "verifying", "merge_queue"].includes(item.state) ||
      this.shuttingDown ||
      this.now() - waited.since >= RUNNER_CAPACITY_WAIT_MS ||
      this.now() - waited.since >= (waited.holdMs ?? Infinity) ||
      runnerSlotFree(this.db, waited.runnerIds, this.now())
    )
      return false;
    const next = { ...waited, attempt: waited.attempt + 1 };
    waitForRunnerSlot(this.db, job, this.now(), this.runnerWaitMs(next), next);
    return true;
  }

  private async failOnLastAttempt(
    job: Job,
    context: JobContext,
    reason: string,
    operation: () => Promise<void>,
  ): Promise<void> {
    try {
      await operation();
    } catch (error) {
      const itemId = readString(job.payload, "itemId");
      const item = itemId === null ? null : getWorkItem(this.db, itemId);
      if (
        job.attempts >= job.maxAttempts &&
        item &&
        !this.shuttingDown &&
        context.isCurrent() &&
        !this.jobContexts.has(item.id) &&
        !item.cancelRequested &&
        (item.state === "verifying" || item.state === "merge_queue")
      ) {
        const message = error instanceof Error ? error.message : String(error);
        const accepted = item.state === "merge_queue" || item.checkpoint?.phase === "merge_queue";
        const text = `Stopped after ${job.attempts} attempts. ${message}`;
        this.fail(item, reason, accepted ? withAcceptedBranch(text, item) : text, error);
      }
      throw error;
    }
  }

  private async executeQueued(payload: unknown): Promise<void> {
    if (this.shuttingDown) throw new Error("Paws is shutting down");
    const itemId = readString(payload, "itemId");
    if (itemId === null) return;
    const loaded = getWorkItem(this.db, itemId);
    if (loaded === null) return;
    if (loaded.cancelRequested || loaded.state === "cancelled") return;
    if (loaded.state === "queued" && !this.admission.canStart(loaded.id).ok) return;
    if (loaded.state === "awaiting_input" || loaded.state === "paused") return;
    const sessionId = loaded.sessionKey;
    if (sessionId && getLinearSession(this.db, sessionId))
      activateLinearItem(this.db, sessionId, loaded.id);
    if (loaded.state === "queued") applyWorkItemEvent(this.db, loaded.id, "dispatched");
    if (loaded.state === "recovering") applyWorkItemEvent(this.db, loaded.id, "recovered");
    let item = getWorkItem(this.db, loaded.id);
    if (item === null || item.state !== "running") return;

    {
      const handoff = readString(payload, "handoff") ?? undefined;
      if (this.options.linearTaskModes && item.sessionKey) {
        if (!(await this.resolveTaskMode(item, handoff))) return;
        item = getWorkItem(this.db, loaded.id);
        if (!item || item.state !== "running" || item.cancelRequested) return;
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
      // A rule matches the issue's labels as they are when the task starts.
      await this.mergeSettingsFor(item, this.signalForItem(item.id)).catch(() => undefined);
      await this.runItem(item, handoff);
    }
  }

  private helperRunner(
    sessionId: string | null,
    purpose: "classify" | "select_repository",
  ): typeof runAgent | undefined {
    if (!this.options.remoteExecution) return undefined;
    if (!sessionId) throw new Error("Remote helper requires a Linear session");
    return this.options.remoteExecution.agentForSession(sessionId, purpose);
  }

  private async resolveTaskMode(item: WorkItemRecord, handoff?: string): Promise<boolean> {
    if (getConversation(this.db, item.id).blocked)
      throw new Error("ACP process cleanup could not be verified");
    const saved = getTaskMode(this.db, item.id);
    const generation = item.sessionKey ? getLinearSessionGeneration(this.db, item.sessionKey) : 0;
    const taskKey = this.parentTaskKey(item);
    let classification = taskKey ? getTaskClassification(this.db, taskKey) : null;
    const sessionKey = item.sessionKey;
    const delegatedIssueId = this.delegationIssueId(item);
    if (!saved && !classification && taskKey && sessionKey && delegatedIssueId)
      classification = await this.taskPlanner.plan({
        taskKey,
        sessionId: sessionKey,
        request: async (signal) =>
          this.classificationRequest(
            sessionKey,
            item.brief && !item.brief.epic && item.brief.issue.issueId === delegatedIssueId
              ? {
                  linearIssueId: item.brief.issue.issueId,
                  identifier: item.brief.issue.identifier,
                  title: item.brief.issue.title,
                  description: item.brief.issue.description,
                  acceptanceCriteria: item.brief.issue.acceptanceCriteria,
                  subIssues: [],
                }
              : await this.tracker!.loadEpic(delegatedIssueId),
            signal,
          ),
      });
    if (taskKey && classification?.mode === "code" && classification.redirect) {
      await this.intakeLinearTask(this.delegationIssueId(item)!, item.sessionKey, taskKey);
      this.dispatch();
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
        agentRunner: this.helperRunner(item.sessionKey, "classify"),
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
        const issueId = this.delegationIssueId(item)!;
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
          this.dispatch();
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
      ask(this.db, { itemId: item.id, runId, sessionId }, "clarification", body, {
        now: this.now(),
      });
      applyWorkItemEvent(this.db, item.id, "blocking_question");
      closeActiveRun(this.db, runId, this.now());
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
    item = getWorkItem(this.db, item.id)!;
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
          "critical",
        );
        void this.flush();
      }
    }, KEEPALIVE_MS);
    keepAlive.unref?.();
    try {
      await this.taskAccess()?.assert(item, controller.signal, { allowTerminalIssue: true });
      const promptRunner = await this.prepareConversation(item);
      let repositoryContext = "";
      if (taskRequiresRepository(this.db, item.id)) {
        const repository = getWorkItemRepository(this.db, item.id);
        if (repository === null) throw new Error("The requested repository has not been selected");
        const auth = this.authorization(item);
        if (auth && !(await auth.ensure(item, "initial", controller.signal))) return;
        const source = await prepareRepositorySnapshot({
          ...repository,
          checkoutExclusions: loadConfigFile(join(this.options.pawsRoot, "config.toml"))
            .checkoutProjects?.[`${repository.owner}/${repository.repo}`.toLowerCase()]?.exclude,
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
        "Call update_plan with the full working checklist whenever the steps or their statuses change. Statuses are pending, inProgress, completed, and canceled.",
        POST_UPDATE_PROMPT,
        repositoryContext,
        this.workContext(item),
        handoff ?? "",
      ]
        .filter(Boolean)
        .join("\n\n");
      const launched = this.options.remoteExecution
        ? {}
        : this.launchAgent({
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
        updatePlan: this.planHook(item, sessionProgress),
        postUpdate: this.updateHook(item),
        prepareInputFiles: this.prepareInputFiles(item, run.id),
        onEvent: activity.onEvent,
      });
      controller.signal.throwIfAborted();
      if (this.stopped(item.id) || this.askedRuns.has(run.id)) return;
      if (
        result.stopReason !== "end_turn" ||
        result.authRequired ||
        !result.agentExited ||
        result.errorMessage
      )
        throw new Error(result.errorMessage ?? `Answer stopped (${result.stopReason})`);
      activity.flush();
      const finish = { runId: run.id, announce: () => sessionProgress?.phase("completed") };
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
          finish,
        );
      } else completeAnswerTask(this.db, item.id, activity.resultBody(), this.now(), finish);
      this.dispatch();
    } catch (error) {
      if (
        !this.askedRuns.has(run.id) &&
        !this.stopped(item.id) &&
        !controller.signal.aborted &&
        getWorkItem(this.db, item.id)?.state !== "awaiting_input"
      ) {
        if (isTransientFailure(error)) throw error;
        this.fail(
          item,
          "answer_error",
          error instanceof Error ? error.message : String(error),
          error,
        );
      }
    } finally {
      clearInterval(keepAlive);
      this.releaseAskedRun(run.id);
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
    item = getWorkItem(this.db, item.id)!;
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
        live.progress ?? `Working on ${item.linearIdentifier}.`,
        `${run.id}:keep:${this.now()}`,
        { ephemeral: true },
        "critical",
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
    let deferred = false;

    try {
      await this.taskAccess()?.assert(item, controller.signal);
      const auth = this.authorization(item);
      if (auth && !(await auth.ensure(item, "initial", controller.signal))) return;
      await this.taskAccess()?.prepare(item, controller.signal);
      const working = this.post(
        item,
        "action",
        `Working on ${item.linearIdentifier}.`,
        `${run.id}:working`,
        { ephemeral: true },
      );
      sessionProgress?.phase("implementing");
      if (working !== undefined) this.startPost(working);
      if (!this.taskAccess()) this.postStatus(item, "started");
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
        await this.preflight(item, run.id, profiles, controller.signal, activity.onEvent);
      } catch (error) {
        if (this.stopped(item.id) || getWorkItem(this.db, item.id)?.state === "awaiting_input")
          return;
        if (isTransientFailure(error)) throw error;
        closeActiveRun(this.db, run.id, this.now());
        const summary = `Closeout: blocked\n${error instanceof Error ? error.message : String(error)}`;
        this.post(item, "thought", summary, `${run.id}:profile-preflight`);
        await this.askCloseoutHelp(item, undefined, summary);
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
        updatePlan: this.planHook(item, sessionProgress),
        pullRequest: this.pullRequestHook(item),
        postUpdate: this.updateHook(item),
        publishArtifact: this.artifactPublisher(item),
        closeoutProgress: this.agentCloseoutHook(item, run.id),
        prepareInputFiles: this.prepareInputFiles(item, run.id),
        onEvent: activity.onEvent,
        ...(launched.command ? { command: launched.command, args: launched.args ?? [] } : {}),
        ...(launched.env ? { env: launched.env } : {}),
        ...(launched.cancelGraceMs !== undefined ? { cancelGraceMs: launched.cancelGraceMs } : {}),
      });
      this.assertJobCurrent(item.id);
      controller.signal.throwIfAborted();
      const finished = getWorkItem(this.db, item.id);
      if (finished === null || finished.state === "cancelled" || finished.cancelRequested) return;
      if (executed.run.authRequired) {
        this.fail(finished, "auth", executed.run.errorMessage ?? "Claude login is missing.");
        return;
      }
      if (executed.run.cancelled || executed.run.stopReason === "cancelled") return;
      if (this.askedRuns.has(run.id)) {
        await this.keepAskedWork(finished.id, run.id, executed.worktreePath);
        return;
      }
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
      if (this.options.remoteExecution)
        writeSessionCloseout(
          sessionCloseoutPath(this.options.pawsRoot, pathId),
          head,
          executed.run.closeoutReport,
        );
      else closeActiveRun(this.db, run.id, this.now());
      await this.verify(finished, executed.worktreePath, base, head, this.candidateFor(run.id));
    } catch (error) {
      const current = getWorkItem(this.db, item.id);
      if (
        !this.askedRuns.has(run.id) &&
        !controller.signal.aborted &&
        current &&
        current.state !== "cancelled" &&
        current.state !== "awaiting_input" &&
        !current.cancelRequested
      ) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          (error instanceof LinearRateLimitError || LINEAR_RATE_LIMITED.test(message)) &&
          (current.state === "running" || current.state === "verifying")
        )
          this.continueAfterRateLimit(
            current,
            error instanceof LinearRateLimitError ? error.retryAfterMs : 0,
          );
        else if (isTransientFailure(error)) {
          deferred = true;
          throw error;
        } else this.fail(current, "run_error", message, error);
      }
    } finally {
      activity.flush();
      clearTimeout(first);
      clearInterval(keepAlive);
      this.releaseAskedRun(run.id);
      if (
        this.options.remoteExecution &&
        !this.shuttingDown &&
        (this.jobContexts.get(item.id)?.isCurrent() ?? true)
      )
        closeActiveRun(this.db, run.id, this.now(), deferred ? "lost" : "ended");
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
    if (await this.visualReviewOutdated(current, worktree, base, head)) return;
    if (await this.askVisualReview(current, worktree, base, head)) return;
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
      acceptCloseout(this.db, {
        itemId: item.id,
        expected: verdict.owner,
        base,
        head: acceptedHead,
        summary: verdict.summary,
        now: this.now(),
      });
      return;
    }
    if (await this.askVisualReviewAfter(after, verdict, worktree, base, head)) return;
    await this.askCloseoutHelp(after, verdict.result, verdict.summary);
  }

  private async askVisualReviewAfter(
    item: WorkItemRecord,
    verdict: CloseoutVerdict,
    worktree: string,
    base: string,
    head: string,
  ): Promise<boolean> {
    return (
      awaitsVisualReview(verdict.result) &&
      this.askVisualReview(item, worktree, base, verdict.result?.head ?? head)
    );
  }

  private async runVerification(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
    candidate: CandidateIdentity,
  ): Promise<CloseoutVerdict & { owner: VerificationOwner }> {
    if (!this.options.remoteExecution) {
      this.assertJobCurrent(item.id);
      const owner = getWorkItem(this.db, item.id) ?? item;
      const verdict = await this.verifyCandidate(item, worktree, base, head, candidate, () =>
        this.assertJobCurrent(item.id),
      );
      this.assertJobCurrent(item.id);
      return { ...verdict, owner: { version: owner.version, runId: owner.currentRunId } };
    }
    const priorRunId = item.currentRunId;
    let ownedRunId: string | null = null;
    try {
      item = immediate(this.db, () => {
        const current = getWorkItem(this.db, item.id);
        if (
          !current ||
          current.currentRunId !== item.currentRunId ||
          current.cancelRequested ||
          !["verifying", "merge_queue"].includes(current.state)
        )
          throw new Error("Verification belongs to an obsolete task");
        const prior = current.currentRunId ? getRun(this.db, current.currentRunId) : null;
        if (!prior || prior.itemId !== current.id) throw new Error("Verification run is missing");
        if (prior.status === "active") {
          if (current.state !== "verifying" || this.live.get(prior.id)?.itemId !== current.id)
            throw new Error("Verification run is not owned by this operation");
          return current;
        }
        if (prior.status !== "ended" && prior.status !== "lost")
          throw new Error("Prior verification run is still provisioning");
        const snapshot = this.readProfileSnapshot(prior.id);
        if (
          !snapshot?.candidate ||
          JSON.stringify(snapshot.candidate) !== JSON.stringify(candidate)
        )
          throw new Error("Verification candidate identity changed");
        if (current.state === "merge_queue")
          applyWorkItemEvent(this.db, current.id, "reverify_requested");
        const run = insertRun(this.db, {
          itemId: current.id,
          kind: "recheck",
          agent: prior.agent,
          status: "active",
          freshSession: true,
          now: this.now(),
        });
        ownedRunId = run.id;
        setCurrentRun(this.db, current.id, run.id);
        return getWorkItem(this.db, current.id)!;
      });
      if (ownedRunId) {
        mkdirSync(runDir(this.options.pawsRoot, ownedRunId), { recursive: true, mode: 0o700 });
        writeFileSync(
          join(runDir(this.options.pawsRoot, ownedRunId), "agent-profile.json"),
          readFileSync(join(runDir(this.options.pawsRoot, priorRunId!), "agent-profile.json")),
          { mode: 0o600 },
        );
      }
      const runId = item.currentRunId!;
      const assertCurrent = () => {
        this.signalForItem(item.id)?.throwIfAborted();
        const current = getWorkItem(this.db, item.id);
        const identity = this.readProfileSnapshot(runId)?.candidate;
        if (
          !current ||
          current.currentRunId !== runId ||
          current.cancelRequested ||
          !["verifying", "running"].includes(current.state) ||
          getRun(this.db, runId)?.status !== "active" ||
          JSON.stringify(identity) !== JSON.stringify(candidate)
        )
          throw new Error("Verification belongs to an obsolete candidate or run");
      };
      assertCurrent();
      const verdict = await this.verifyCandidate(
        item,
        worktree,
        base,
        head,
        candidate,
        assertCurrent,
      );
      assertCurrent();
      return { ...verdict, owner: { version: item.version, runId } };
    } finally {
      if (ownedRunId) closeActiveRun(this.db, ownedRunId, this.now());
    }
  }

  private async verifyCandidate(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
    candidate: CandidateIdentity,
    assertCurrent: () => void = () => {},
  ): Promise<CloseoutVerdict> {
    const policy = await this.commitPolicy(item);
    if (policy)
      await validateCandidateAttribution(
        worktree,
        base,
        head,
        policy,
        undefined,
        this.signalForItem(item.id),
      );
    const sessionProgress = this.sessionProgress(item);
    sessionProgress?.phase("verifying");
    const repository = this.repositoryForItem(item);
    const checkoutExclusions = repository
      ? (loadConfigFile(join(this.options.pawsRoot, "config.toml")).checkoutProjects?.[
          `${repository.owner}/${repository.repo}`.toLowerCase()
        ]?.exclude ?? [])
      : [];
    const deps = this.agentDeps(item);
    const networkGit =
      repository && deps.signal
        ? this.repositoryGit(item, repository, deps.signal, "write")
        : undefined;
    for (const key of ["agentRunner", "promptRunner"] as const) {
      const runner = deps[key];
      if (runner)
        deps[key] = async (options) => {
          assertCurrent();
          const result = await runner({
            ...options,
            checkoutExclusions,
            ...(networkGit && options.role === "implementer" ? { networkGit } : {}),
          });
          assertCurrent();
          return result;
        };
    }
    const sessionPath = sessionCloseoutPath(this.options.pawsRoot, itemPathId(item));
    const savedReport = (commit: string) => {
      const saved = readSessionCloseout(sessionPath);
      return saved?.head === commit ? saved.report : undefined;
    };
    const runnerChecks = new Map<string, Promise<void>>();
    const commands = this.options.remoteExecution
      ? {
          runLogged: async (request: Parameters<typeof loggedSessionCloseout>[1]) => {
            assertCurrent();
            const commit = request.expectedHead;
            if (!sessionCloseoutResult(savedReport(commit), request)) {
              let checks = runnerChecks.get(commit);
              if (!checks) {
                checks = this.runRunnerCloseout(item, deps, {
                  worktree,
                  base,
                  head: commit,
                  stepId: request.itemId,
                  sessionPath,
                  policy,
                  assertCurrent,
                  report: (body) => report(body),
                });
                runnerChecks.set(commit, checks);
              }
              await checks;
            }
            assertCurrent();
            const result = loggedSessionCloseout(savedReport(commit), request);
            assertCurrent();
            return result;
          },
        }
      : undefined;
    const live = [...this.live.values()].find((entry) => entry.itemId === item.id);
    const key = `${item.currentRunId ?? item.id}:closeout:${crypto.randomUUID()}`;
    const report = (body: string) => {
      if (deps.signal?.aborted || !this.canReportProgress(item.id)) return;
      if (live) live.progress = body;
      this.post(item, "thought", body, `${key}:${++this.activitySeq}`);
    };
    const activity = createAcpActivityReporter(
      (update) => {
        if (
          deps.signal?.aborted ||
          !this.canReportProgress(item.id) ||
          update.kind === "elicitation"
        )
          return;
        this.post(item, update.kind, update.body, `${key}:acp:${++this.activitySeq}`, update);
      },
      (steps) => {
        if (!deps.signal?.aborted && this.canReportProgress(item.id)) sessionProgress?.plan(steps);
      },
    );
    const onCandidate = deps.onCandidate;
    deps.onCandidate = (identity) => {
      if (deps.signal?.aborted) return;
      Object.assign(candidate, identity);
      onCandidate?.(identity);
    };
    const fixer = createAcpFixRunner({
      ...deps,
      onEvent: activity.onEvent,
      updatePlan: this.planHook(item, sessionProgress),
      pullRequest: this.pullRequestHook(item),
      postUpdate: this.updateHook(item),
    });
    const reviewer = createAcpCodexReviewer({ ...deps, postUpdate: this.updateHook(item) });
    const gate = createCloseoutGate({
      checkoutExclusions,
      candidate,
      published: () => publishedEvidence(this.db, item.id),
      approvals: () => visualReviewApprovals(this.db, item.id, itemPathId(item)),
      ...(commands ? { commandRunner: commands } : {}),
      reviewer: {
        async review(request) {
          await checkoutPatterns(request.worktree, exclusionPatterns(checkoutExclusions));
          return reviewer.review(request);
        },
      },
      fixer: {
        applyFix: async (request) => {
          if (this.stopped(item.id)) return { ok: false, reason: "fix cancelled" };
          sessionProgress?.phase("fixing");
          const failed = request.items.filter((check) => check.state === "failed");
          report(
            `Fixing Closeout findings for ${item.linearIdentifier}, fix attempt ${request.fixAttempt} of ${request.maxFixAttempts}. Failed checks: ${failed.map((check) => check.id).join(", ")}.`,
          );
          await this.flush();
          let result;
          try {
            result = await fixer.applyFix(request);
          } finally {
            activity.flush();
          }
          if (result.ok && policy)
            await validateCandidateAttribution(
              worktree,
              base,
              result.head,
              policy,
              undefined,
              deps.signal,
            );
          if (result.ok && this.options.remoteExecution)
            writeSessionCloseout(sessionPath, result.head, result.closeoutReport);
          if (result.ok && !this.stopped(item.id)) {
            sessionProgress?.phase("verifying");
            report(
              `Rechecking ${item.linearIdentifier} with Closeout after fix attempt ${request.fixAttempt}.`,
            );
            await this.flush();
          }
          return result;
        },
      },
      recorder: {
        record: async (verdict) => {
          if (deps.signal?.aborted || verdict.outcome === "accepted" || awaitsVisualReview(verdict))
            return;
          this.post(
            item,
            "thought",
            verdict.summary,
            `${item.id}:verdict:${listCloseoutRecoveries(this.db, item.id).length}:${verdict.head}:${verdict.outcome}:${verdict.evaluations}:${verdict.fixAttempts}`,
          );
        },
      },
      reportDir: `${this.options.pawsRoot}/runs/${itemPathId(item)}`,
      ...this.closeoutHome(item),
      ...recoveryOptions(this.db, item.id),
      progress: createDbCloseoutProgress(this.db, item.id, () => this.now()),
    });
    try {
      return await gate.run({
        taskId: itemPathId(item),
        taskLabel: item.linearIdentifier,
        worktree,
        baseSha: base,
        headSha: head,
        attempt: 1,
      });
    } finally {
      activity.flush();
      if (live) live.progress = null;
    }
  }

  private async runRunnerCloseout(
    item: WorkItemRecord,
    deps: AcpAgentDeps,
    input: {
      worktree: string;
      base: string;
      head: string;
      stepId: string | undefined;
      sessionPath: string;
      policy: GitCommitPolicy | undefined;
      assertCurrent: () => void;
      report: (body: string) => void;
    },
  ): Promise<void> {
    const { worktree, head, assertCurrent } = input;
    const short = head.slice(0, 7);
    const { attempts, delayMs } = this.options.remoteCloseoutRetry ?? {
      attempts: 3,
      delayMs: 30_000,
    };
    const runner = deps.agentRunner;
    let reason = "remote execution is unavailable";
    const rateLimitDeadline = this.now() + CHECKS_RATE_LIMIT_WAIT_MS;
    for (let attempt = 1; attempt <= (runner ? attempts : 0); attempt++) {
      assertCurrent();
      await this.waitForTaskRunner(item, head, input.stepId, deps.signal, assertCurrent);
      if (attempt > 1) {
        input.report(
          `Closeout could not run the checks for ${item.linearIdentifier} on its runner (${reason}). Retrying in ${Math.round(delayMs / 1000)} s.`,
        );
        await delay(delayMs, undefined, deps.signal ? { signal: deps.signal } : {});
        assertCurrent();
      } else
        input.report(
          `Running the Closeout checks for ${item.linearIdentifier} on its runner at ${short}.`,
        );
      try {
        const options: RunAgentOptions = {
          repository: deps.repository,
          role: "implementer",
          profile: deps.profiles?.implementer,
          itemId: itemPathId(item),
          runId: `checks-${itemPathId(item)}-${short}-${attempt}`,
          prompt: closeoutChecksPrompt(head),
          worktreePath: worktree,
          pawsRoot: this.options.pawsRoot,
          checkpoint: false,
          mainSha: input.base,
          ...(input.policy ? { commitPolicy: input.policy } : {}),
          ...(deps.home ? { home: deps.home } : {}),
          ...(deps.signal ? { signal: deps.signal } : {}),
        };
        const result = await runner!({ ...options, ...this.trustedRunInputs(item, options) });
        assertCurrent();
        if ((await git(["-C", worktree, "rev-parse", "HEAD"])).trim() !== head) {
          await git(["-C", worktree, "reset", "--hard", head]);
          reason = "the checks run changed the commit";
        } else if (result.cancelled) reason = "the run was cancelled";
        else if (result.stopReason !== "end_turn" || result.errorMessage)
          reason = result.errorMessage ?? `the run stopped (${result.stopReason})`;
        else if (!result.closeoutReport) reason = "the runner returned no Closeout report";
        else if (!listsChecks(result.closeoutReport))
          reason = "the runner's Closeout listed no checks";
        else {
          writeSessionCloseout(input.sessionPath, head, result.closeoutReport);
          return;
        }
      } catch (error) {
        assertCurrent();
        if (deps.signal?.aborted || error instanceof RunnerCapacityWait) throw error;
        reason = error instanceof Error ? error.message : String(error);
        if (
          (error instanceof LinearRateLimitError || LINEAR_RATE_LIMITED.test(reason)) &&
          this.now() < rateLimitDeadline
        ) {
          await delay(
            error instanceof LinearRateLimitError
              ? Math.min(error.retryAfterMs, CHECKS_RATE_LIMIT_WAIT_MS)
              : CHECKS_RATE_LIMIT_RETRY_MS,
            undefined,
            deps.signal ? { signal: deps.signal } : {},
          );
          assertCurrent();
          attempt -= 1;
        }
      }
    }
    throw new Error(
      `The Closeout checks could not run on the runner for commit ${short}: ${reason}. No check failed; they have no result for this commit. Reply once the runner is back to try again.`,
    );
  }

  /**
   * Holds the Closeout checks while the task's runner is paused, revoked or
   * offline. The waiting step shows why, Linear gets one thought, and no
   * attempt is used. A long wait asks the team whether to move the task.
   */
  private async waitForTaskRunner(
    item: WorkItemRecord,
    head: string,
    stepId: string | undefined,
    signal: AbortSignal | undefined,
    assertCurrent: () => void,
  ): Promise<void> {
    const runId = item.currentRunId;
    if (runId === null) return;
    const { pollMs, askAfterMs } = this.options.runnerWait ?? {};
    let runnerName = "";
    const outcome = await waitForRunner({
      runner: () => {
        assertCurrent();
        const runner = runRunnerAvailability(this.db, runId);
        if (runner) runnerName = runner.name;
        return runner;
      },
      now: () => this.now(),
      sleep: (ms) => delay(ms, undefined, signal ? { signal } : {}),
      waiting: (reason) => {
        if (stepId)
          setRunningCloseoutStepDetail(this.db, item.id, head, stepId, reason, this.now());
      },
      notify: (reason) => {
        this.post(item, "thought", reason, `${runId}:closeout-runner-wait:${head}:${reason}`);
        void this.flush().catch(() => {});
      },
      ask: (runner, reason) => this.askRunnerWait(item, runId, runner.name, reason),
      asked: () => {
        const asked = findAskedQuestion(this.db, runId, "runner-wait");
        return asked === null ? null : this.runnerWaitQuestion(asked.id);
      },
      ...(pollMs === undefined ? {} : { pollMs }),
      ...(askAfterMs === undefined ? {} : { askAfterMs }),
    });
    if (outcome === "move")
      throw new Error(
        `The team asked to move ${item.linearIdentifier} off runner ${runnerName}, so Closeout stopped waiting. No check failed. Paws cannot move a task to another runner yet; reply once a runner is available to run Closeout again.`,
      );
  }

  private askRunnerWait(
    item: WorkItemRecord,
    runId: string,
    runnerName: string,
    reason: string,
  ): RunnerWaitQuestion {
    const sessionId = this.activitySession(item);
    if (sessionId === null) return { answer: () => null, cancel() {} };
    const minutes = Math.round((this.options.runnerWait?.askAfterMs ?? 30 * 60_000) / 60_000);
    const body = `Runner ${runnerName} has been unavailable for ${minutes} minutes, so Closeout for ${item.linearIdentifier} has not started. Move the task to another runner, or keep waiting?`;
    const { question } = ask(this.db, { itemId: item.id, runId, sessionId }, "runner-wait", body, {
      options: [MOVE_TO_ANOTHER_RUNNER, KEEP_WAITING],
      context: reason,
      now: this.now(),
    });
    void this.flush().catch(() => {});
    return this.runnerWaitQuestion(question.id);
  }

  private runnerWaitQuestion(id: string): RunnerWaitQuestion {
    return {
      answer: () => {
        const question = getQuestion(this.db, id);
        return question?.status === "answered" ? question.answer : null;
      },
      cancel: () => cancelQuestion(this.db, id, this.now()),
    };
  }

  /**
   * A re-check of a rebased head starts with a fresh retry budget. Earlier
   * evidence stays on disk; its attempt keys become the round's baseline.
   */
  private async startCloseoutRound(item: WorkItemRecord, head: string): Promise<void> {
    if (head === "" || head === item.checkpoint?.wipCommit) return;
    if (listCloseoutRounds(this.db, item.id).some((round) => round.head === head)) return;
    let retryBaseline: string[];
    try {
      retryBaseline = await snapshotRetryBaseline(itemPathId(item), this.options.pawsRoot);
    } catch {
      return;
    }
    startCloseoutRound(this.db, {
      itemId: item.id,
      head,
      retryBaseline,
      startedAt: this.now(),
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
    askCloseoutHelp(this.db, sessionId, context, { now: this.now() });
    await this.flush();
  }

  private async reverify(payload: unknown, jobId: number): Promise<void> {
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
      if (base === "" || item.checkpoint?.wipCommit !== head) {
        const upstream = await git([
          "-C",
          worktree,
          "rev-parse",
          "--verify",
          "--quiet",
          UPSTREAM_MAIN_REF,
        ])
          .then(() => UPSTREAM_MAIN_REF)
          .catch(() => "origin/main");
        base = (await git(["-C", worktree, "merge-base", "HEAD", upstream])).trim();
      }
    } catch (error) {
      if (isTransientFailure(error)) throw error;
      const message = error instanceof Error ? error.message : String(error);
      this.fail(item, "reverify", message, error);
      return;
    }
    if (item.state !== "verifying" && item.state !== "merge_queue") return;
    const candidate = await this.candidateForItem(item);
    if (!candidate) return;
    if (item.state === "merge_queue") await this.startCloseoutRound(item, head);
    const verdict = await this.runVerification(item, worktree, base, head, candidate);
    if (this.stopped(item.id)) return;
    if (verdict.decision !== "accepted") {
      if (await this.askVisualReviewAfter(item, verdict, worktree, base, head)) return;
      await this.askCloseoutHelp(item, verdict.result, verdict.summary);
      return;
    }
    head = (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();
    acceptCloseout(this.db, {
      itemId: item.id,
      expected: verdict.owner,
      base,
      head,
      summary: verdict.summary,
      now: this.now(),
      reverifyJobId: jobId,
    });
  }

  private async merge(payload: unknown, jobId: number): Promise<MergeStep> {
    const itemId = readString(payload, "itemId");
    if (itemId === null) return { kind: "obsolete" };
    const run: MergeRun = { payload, closeoutFailure: null };
    return advanceMerge(
      this.db,
      { itemId, payload, jobId },
      {
        ...this.orderCapabilities(itemId),
        publish: (item) => this.publishForMerge(item, run),
        settings: (item, signal) => this.mergeSettingsFor(item, signal),
        accept: (candidate) => {
          run.publicationCandidate = candidate;
        },
        verify: (input) => this.verifyForMerge(run, input),
        assertReady: (item) =>
          this.assertPublicationReady(item, "merge", run.signal!, run.publicationCandidate),
        askCloseoutHelp: async (item) => {
          if (run.closeoutFailure)
            await this.askCloseoutHelp(
              item,
              run.closeoutFailure.result,
              run.closeoutFailure.summary,
            );
        },
        packages: (repository) => this.repositoryPackages(repository),
        completed: () => this.dispatch(),
      },
    );
  }

  private async publishForMerge(
    item: WorkItemRecord,
    run: MergeRun,
  ): Promise<MergePublication | MergeStep> {
    this.assertReconciled(item);
    const repository = this.repositoryForItem(item);
    const configuredGitHub = repository === null ? null : this.githubForRepository(repository);
    if (
      repository === null ||
      repository === undefined ||
      configuredGitHub === null ||
      configuredGitHub === undefined
    ) {
      return { kind: "failed", reason: "no_github", message: "GitHub App is not configured." };
    }
    if (item.state !== "merge_queue") return { kind: "obsolete" };
    immediate(this.db, () => {
      if (!this.admission.canMerge(item.id).ok)
        throw new LinearReconciliationPendingError("Linear dependencies are still running");
      const sessionId = item.sessionKey;
      const session = sessionId ? getLinearSession(this.db, sessionId) : null;
      if (!sessionId || !session) return;
      const activeId = session.activeItemId;
      if (
        activeId &&
        activeId !== item.id &&
        listInFlightItems(this.db).some((entry) => entry.id === activeId)
      )
        throw new LinearReconciliationPendingError("Another Linear task owns this session");
      activateLinearItem(this.db, sessionId, item.id);
    });
    const live = this.live.get(`operation:${item.id}`);
    if (!live) throw new Error("GitHub publication has no owned operation.");
    const priorVerification = ciWaitVerification(run.payload);
    run.publicationCandidate = priorVerification
      ? { sha: priorVerification.head, baseSha: priorVerification.base }
      : item.checkpoint?.wipCommit && item.checkpoint.baseSha
        ? { sha: item.checkpoint.wipCommit, baseSha: item.checkpoint.baseSha }
        : undefined;
    const freshReads = new Set<string>();
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
      assert: async (purpose, merging) => {
        const current = getWorkItem(this.db, item.id);
        if (!current) throw new Error("The published task no longer exists.");
        await this.assertPublicationReady(
          current,
          purpose === "merge" ? "merge" : "publish",
          live.controller.signal,
          run.publicationCandidate,
        );
        const fresh = (purpose === "pr" || purpose === "merge") && !freshReads.has(purpose);
        const firstPullRequest = purpose === "pr" && !this.pullRequestReads.has(item.id);
        await this.taskAccess()?.assert(current, live.controller.signal, {
          fresh: merging === true || firstPullRequest,
        });
        if (firstPullRequest) this.pullRequestReads.add(item.id);
        if (fresh) freshReads.add(purpose);
        const auth = this.authorization(current);
        if (auth && !(await auth.ensure(current, "publication", live.controller.signal, { fresh })))
          throw new Error(
            "The GitHub App installation must cover the repository before publication.",
          );
      },
    });
    const candidate = await this.candidateForItem(item);
    if (!candidate) return { kind: "obsolete" };
    const worktree = worktreePath(this.options.pawsRoot, itemPathId(item));
    const summary = readString(run.payload, "summary") ?? "Closeout accepted.";
    const policy = await this.commitPolicy(item);
    if (this.stopped(item.id)) return { kind: "obsolete" };
    if (!artifactPublicationReady(this.db, item.id))
      return {
        kind: "failed",
        reason: "artifact_upload",
        message: "A requested artifact has not been uploaded successfully.",
      };
    this.sessionProgress(item)?.phase("publishing");
    const draft = getPullRequestDraft(this.db, item.id);
    const published = await publishAccepted({
      accepted: true,
      evidence: [
        summary,
        visualReviewPullRequestNote(
          this.db,
          item,
          this.options.evidence?.publicUrl ?? null,
          this.now(),
        ),
        policy ? policyPullRequestCredit(policy) : "",
      ]
        .filter(Boolean)
        .join("\n\n"),
      worktree,
      issue: item.linearIdentifier,
      branchKey: taskBranchKey(item),
      owner: repository.owner,
      repo: repository.repo,
      title: draft?.title ?? item.title,
      ...(draft ? { description: draft.body } : {}),
      client: github.client,
      gitExec: github.gitExec,
      remoteUrl: repository.remoteUrl,
      ...this.gitHubCredentials(github),
    });
    await this.assertPublicationReady(
      item,
      "publish",
      live.controller.signal,
      run.publicationCandidate,
    );
    if (this.stopped(item.id)) return { kind: "obsolete" };
    if (getWorkItem(this.db, item.id)?.state === "awaiting_input") return { kind: "obsolete" };
    if (!published.published)
      return { kind: "failed", reason: "publish", message: published.reason };
    this.post(
      item,
      "response",
      `Opened ${published.pull.url ?? `pull request #${published.pull.number}`}. CI checks and merging will continue in the background. Reply here to request changes.`,
      `pull-request-ready:${item.id}:${item.sessionKey ? getLinearSessionGeneration(this.db, item.sessionKey) : 0}`,
      {},
      "ordered",
    );
    const sessionProgress = this.sessionProgress(item);
    if (published.pull.url) sessionProgress?.link("Pull request", published.pull.url);
    sessionProgress?.phase("merging");
    await this.flush(live.controller.signal);
    run.candidate = candidate;
    run.verifying = item;
    run.signal = live.controller.signal;
    return {
      github,
      repository,
      pull: published.pull,
      head: published.head,
      worktree,
      branchKey: taskBranchKey(item),
      summary,
      commit: {
        title: `${draft?.title ?? item.title} (#${published.pull.number})`,
        ...(policy
          ? {
              message: commitPolicyMessage(summary, policy),
              env: commitIdentityEnv(appBotCommitIdentity(policy.bot)),
            }
          : {}),
      },
      signal: live.controller.signal,
    };
  }

  private async verifyForMerge(run: MergeRun, input: ReverifyInput): Promise<MergeVerdict> {
    const verifying = run.verifying!;
    await this.startCloseoutRound(verifying, input.head);
    const verdict = await this.runVerification(
      verifying,
      input.worktree,
      input.base,
      input.head,
      run.candidate!,
    );
    if (verdict.decision === "accepted" && !verdict.exhausted)
      applyCloseoutAcceptance(this.db, verifying.id, verdict.owner);
    run.verifying = getWorkItem(this.db, verifying.id) ?? verifying;
    if (verdict.decision === "accepted")
      run.publicationCandidate = { sha: input.head, baseSha: input.base };
    if (verdict.decision !== "accepted") run.closeoutFailure = verdict;
    const filesReady = artifactPublicationReady(this.db, verifying.id);
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
      rejected: verdict.decision !== "accepted",
    };
  }

  private async settleMerge(payload: unknown, step: MergeStep): Promise<void> {
    if (step.kind !== "failed" && step.kind !== "merged") return;
    const item = getWorkItem(this.db, readString(payload, "itemId") ?? "");
    if (!item) return;
    if (step.kind === "failed") {
      this.fail(item, step.reason, step.message);
      return;
    }
    const repository = this.repositoryForItem(item);
    if (repository) await this.completeMerge(item, repository);
  }

  private async completeMerge(item: WorkItemRecord, repository: RepositoryBinding): Promise<void> {
    const merged = completeMergedItem(this.db, {
      itemId: item.id,
      now: this.now(),
      announce: (current) => {
        this.post(
          current,
          "thought",
          `Merged ${current.linearIdentifier}.`,
          `${current.id}:merged`,
        );
        this.sessionProgress(current)?.phase("completed");
        this.postStatus(current, "completed");
      },
    });
    if (!merged) return;
    wakeMergesBehind(this.db, this.now());
    await removeWorktree({
      owner: repository.owner,
      repo: repository.repo,
      itemId: itemPathId(item),
      pawsRoot: this.options.pawsRoot,
    }).catch(() => undefined);
    this.dispatch();
    await this.flush();
  }

  private orderCapabilities(itemId: string): OrderCapabilities {
    return {
      now: () => this.now(),
      stopped: () => this.stopped(itemId),
      session: (item) => this.activitySession(item),
      fetchMain: (item) => this.fetchUpstreamMain(item),
      ciFixAttempts: () => this.ciFixAttempts(),
      voice: {
        thought: (item, body, key) => this.post(item, "thought", body, key),
        status: (item, body) => this.statusAfterPullRequest(item, body),
        afterPullRequest: (item, body, key) => this.postAfterPullRequest(item, body, key),
        flush: () => this.flush(),
      },
    };
  }

  private statusAfterPullRequest(item: WorkItemRecord, body: string): void {
    if (!(this.jobContexts.get(item.id)?.isCurrent() ?? true)) return;
    if (getWorkItem(this.db, item.id)?.state === "cancelled") return;
    this.sessionProgress(item)?.status(body);
    void this.flush().catch(() => {});
  }

  /** Progress is quiet once the pull request is open, so this posts like the pull request note. */
  private postAfterPullRequest(item: WorkItemRecord, body: string, key: string): void {
    this.post(item, "response", body, key, {}, "ordered");
  }

  /** `[queue] start_timeout_hours`, read on every dispatch. Missing or unreadable means 24. */
  private queueStartTimeoutHours(): number {
    try {
      return readQueueSettings(loadConfigFile(join(this.options.pawsRoot, "config.toml")))
        .startTimeoutHours;
    } catch {
      return DEFAULT_QUEUE_START_TIMEOUT_HOURS;
    }
  }

  private repositoryPackages(repository: string): string[] {
    try {
      return repositoryPackages(
        readMergeSettings(loadConfigFile(join(this.options.pawsRoot, "config.toml"))),
        repository,
      );
    } catch {
      return [];
    }
  }

  /** `[merge] ci_fix_attempts`, read for every CI round. Missing means 3. */
  private ciFixAttempts(): number {
    return readMergeSettings(loadConfigFile(join(this.options.pawsRoot, "config.toml")))
      .ciFixAttempts;
  }

  /**
   * Settings → Merging for this task: an issue rule, then the Linear project, then the workspace
   * default. Resolved from the issue's project and labels once, then kept with the task. A failed
   * Linear read uses the workspace default for now and tries again next time.
   */
  private async mergeSettingsFor(
    item: WorkItemRecord,
    signal?: AbortSignal,
  ): Promise<TaskMergeSettings> {
    const kept = getTaskMergeSettings(this.db, item.id);
    if (kept) return kept;
    const policy = readMergeSettings(loadConfigFile(join(this.options.pawsRoot, "config.toml")));
    let context: LinearMergeContext | null = { projectId: null, labels: [] };
    if (this.tracker?.issueMergeContext) {
      try {
        context = await this.tracker.issueMergeContext(
          item.linearIssueId,
          signal ? { signal } : undefined,
        );
      } catch (error) {
        signal?.throwIfAborted();
        context = null;
        console.error(
          `merge settings for ${item.linearIdentifier} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    }
    if (context?.overview !== undefined)
      keepTaskLinearRead(
        this.db,
        item.id,
        "project_overview",
        projectOverviewText(context.overview),
        this.now(),
      );
    const resolved = resolveMergeSettings(context ?? { projectId: null, labels: [] }, policy);
    const settings: TaskMergeSettings = {
      order: resolved.order,
      mainMoved: resolved.mainMoved,
      resolved: {
        sources: resolved.sources,
        ...(resolved.rule ? { rule: resolved.rule } : {}),
        ...(context ? { projectId: context.projectId, labels: context.labels } : {}),
      },
    };
    if (context !== null) keepTaskMergeSettings(this.db, item.id, settings, this.now());
    return settings;
  }

  private askHook(item: WorkItemRecord, runId: string): AskTeamHook {
    return {
      ask: async (request, context) => {
        const sessionId = this.activitySession(item);
        if (sessionId === null) {
          throw new Error("ask_team has no Linear session");
        }
        if (context.signal.aborted) throw new Error("cancelled");
        immediate(this.db, () => {
          ask(
            this.db,
            { itemId: item.id, runId, sessionId },
            "agent",
            [request.question.trim(), request.context?.trim()].filter(Boolean).join("\n\n"),
            {
              options: request.options ?? [],
              now: this.now(),
              amend: (question) => {
                const suggestions = suggestDecisions(this.db, question.id, question.body);
                if (suggestions.length === 0) return null;
                return {
                  context: suggestions
                    .map(
                      (decision) =>
                        `Saved decision: ${decision.statement}\nSource: ${decision.sourceUrl}\nConfirm: ${decision.value}`,
                    )
                    .join("\n\n"),
                  options: [
                    ...question.options,
                    ...suggestions.map((decision) => ({
                      label: `Use saved decision: ${decision.statement.slice(0, 80)}`,
                      value: decision.value,
                    })),
                  ],
                };
              },
            },
          );
          const current = getWorkItem(this.db, item.id);
          if (current?.state === "running") {
            applyWorkItemEvent(this.db, item.id, "blocking_question");
            saveCheckpoint(this.db, item.id, {
              phase: "awaiting_input",
              ...(current.checkpoint?.wipCommit ? { wipCommit: current.checkpoint.wipCommit } : {}),
              ...(current.checkpoint?.baseSha ? { baseSha: current.checkpoint.baseSha } : {}),
            });
          }
        });
        this.askedRuns.add(runId);
        await this.flush();
        return {
          answer:
            "Question posted to the team. End your turn now without further changes; you will be resumed with the answer as your next message.",
        };
      },
    };
  }

  private releaseAskedRun(runId: string): void {
    if (!this.askedRuns.delete(runId)) return;
    releaseRunCapacity(this.db, runId, this.now());
    const answered = this.db
      .query<
        { id: string; itemId: string; body: string; options: string | null; answer: string },
        [string]
      >(
        `SELECT q.id, q.item_id AS itemId, q.body, q.options, q.answer FROM question q
         JOIN work_item i ON i.id = q.item_id
         WHERE q.run_id = ? AND q.status = 'answered' AND q.cancelled_at IS NULL
         AND q.answer IS NOT NULL AND i.state = 'running'
         ORDER BY q.answered_at DESC, q.id DESC LIMIT 1`,
      )
      .get(runId);
    if (!answered) return;
    enqueueJobOnce(this.db, {
      queue: JOB_KIND.resume,
      jobKey: `resume:answer:${answered.id}`,
      payload: {
        itemId: answered.itemId,
        freshSession: true,
        handoff:
          visualReviewHandoff(this.db, answered.id) ??
          handoffNote({
            question: answered.body,
            options:
              answered.options === null
                ? []
                : (JSON.parse(answered.options) as (string | { label?: string; value: string })[]),
            answer: answered.answer,
          }),
        reason: "answer",
      },
      now: this.now(),
    });
  }

  private async keepAskedWork(itemId: string, runId: string, worktree: string): Promise<void> {
    let current = getWorkItem(this.db, itemId);
    if (!current || current.state === "cancelled" || current.cancelRequested) return;
    const sessionId = this.activitySession(current);
    if (
      current.state === "running" &&
      sessionId !== null &&
      findOpenQuestion(this.db, sessionId)?.runId === runId
    ) {
      applyWorkItemEvent(this.db, itemId, "blocking_question");
      current = getWorkItem(this.db, itemId);
      if (!current) return;
    }
    const phase =
      current.state === "awaiting_input" ||
      current.state === "verifying" ||
      current.state === "merge_queue" ||
      current.state === "running"
        ? current.state
        : null;
    if (phase === null) return;
    let head = "";
    let base = current.checkpoint?.baseSha ?? "";
    try {
      head = (await git(["-C", worktree, "rev-parse", "HEAD"])).trim();
    } catch {
      return;
    }
    if (base === "")
      base = await git(["-C", worktree, "merge-base", "HEAD", "origin/main"]).then(
        (out) => out.trim(),
        () => "",
      );
    saveCheckpoint(this.db, itemId, {
      phase,
      ...(head === "" ? {} : { wipCommit: head }),
      ...(base === "" ? {} : { baseSha: base }),
    });
  }

  private async deliverPrompt(
    event: AcceptedLinearEvent,
    redirect = false,
  ): Promise<"answered" | "redirect" | "rejected"> {
    const sessionId = event.sessionId;
    let answer = event.body?.trim() ?? "";
    if (sessionId === null || answer === "") return "rejected";
    if (questionReplyConsumed(this.db, sessionId, event.dedupeKey)) return "rejected";
    const open = findOpenQuestion(this.db, sessionId);
    if (open === null) return "rejected";
    const createdAt =
      event.activityCreatedAtMs === undefined ? event.updatedAtMs : event.activityCreatedAtMs;
    if (createdAt === null || createdAt <= open.createdAt) return "rejected";
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
    const user = answerer(answeredBy);
    if (user === null) return "rejected";
    if (open.kind === "visual-review") {
      const review = getVisualReview(this.db, open.id);
      const item = getWorkItem(this.db, open.itemId);
      if (review === null || item === null) return "rejected";
      if (!this.canAnswerVisualReview(item, answeredBy)) {
        postNote(
          this.db,
          sessionId,
          item,
          VISUAL_REVIEW_ANSWERERS,
          `visual-review-refused:${event.dedupeKey}`,
          this.now(),
        );
        await this.flush();
        return "rejected";
      }
      return this.answerVisualReview(open, review, event.dedupeKey, answer, answeredBy);
    }
    // The installation check answers its own waiting question when the App returns.
    if (open.kind === "github-auth") return "rejected";
    if (!canAnswer({ kind: open.kind === "closeout-help" ? "closeout-bypass" : open.kind }, user))
      return "rejected";
    if (open.kind === "runner-wait" || open.kind === "closeout-help") {
      const recovery = listCloseoutRecoveries(this.db, open.itemId).find(
        (entry) => entry.questionId === open.id,
      );
      if (recovery && getWorkItem(this.db, open.itemId)?.state !== "awaiting_input")
        return "rejected";
      const outcome = answerAsked(
        this.db,
        { sessionId, deliveryId: event.dedupeKey, body: answer, answeredBy, now: this.now() },
        questionEffects(this.db, { now: this.now() }),
      );
      await this.flush();
      if (recovery && parseRecoveryAnswer(answer, recovery.failedChecks) === null)
        return "rejected";
      return outcome.status === "answered" ? "answered" : "rejected";
    }
    const outcome = immediate(this.db, () => {
      const item = getWorkItem(this.db, open.itemId);
      if (item?.state !== "awaiting_input") return "rejected" as const;
      if (answer.startsWith("/paws decision")) {
        try {
          const confirmed = confirmDecision(this.db, open.id, answer, answeredBy, this.now());
          if (confirmed === null)
            throw new Error("This suggestion is invalid. Answer this question in your own words.");
          answer = confirmed;
          this.db.run(
            "UPDATE linear_turn SET body=? WHERE session_id=? AND event_key=? AND state='pending'",
            [answer, sessionId, event.dedupeKey],
          );
        } catch (error) {
          this.post(
            item,
            "error",
            error instanceof Error ? error.message : "Answer this question in your own words.",
            `decision-rejected:${event.dedupeKey}`,
          );
          return "rejected" as const;
        }
      }
      const answered = answerAsked(
        this.db,
        { sessionId, deliveryId: event.dedupeKey, body: answer, answeredBy, now: this.now() },
        questionEffects(this.db, {
          now: this.now(),
          asking: (runId) => this.askedRuns.has(runId),
          redirect,
        }),
      );
      if (answered.status !== "answered") return "rejected" as const;
      return redirect ? ("redirect" as const) : ("answered" as const);
    });
    if (outcome === "redirect")
      for (const live of this.live.values())
        if (live.itemId === open.itemId) live.controller.abort(FOLLOW_UP_INTERRUPTION);
    await this.flush();
    return outcome;
  }

  private async stopSession(sessionId: string | null, eventKey: string, at: number): Promise<void> {
    if (sessionId === null) return;
    this.taskAccess()?.invalidate({ sessionId });
    this.githubAuth?.invalidate({ sessionId });
    const requestedAt = at > 0 ? at : this.now();
    const commands: LinearCommand[] = [];
    const accepted = immediate(this.db, () => {
      if (acceptLinearStop(this.db, sessionId, eventKey, requestedAt) === null) return false;
      const items = this.itemsForSession(sessionId);
      if (items.length === 0) stopAdoptedParent(this.db, sessionId, requestedAt);
      if (items.length === 0)
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
        if (isTerminalWorkItemState(item.state)) continue;
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

  private assertReconciled(item: WorkItemRecord): void {
    if (!this.admission.canDispatchDelegation(item.delegationId))
      throw new LinearReconciliationPendingError(
        "Linear execution changes are still being reconciled",
      );
  }

  private async assertPublicationReady(
    item: WorkItemRecord,
    phase: "publish" | "merge",
    signal: AbortSignal,
    candidate?: { sha: string; baseSha: string },
  ): Promise<void> {
    signal.throwIfAborted();
    const ready = await this.options.publicationReady?.(item.id, phase, signal, candidate);
    signal.throwIfAborted();
    if (ready === false)
      throw new LinearReconciliationPendingError("Linear publication freshness is pending");
    this.assertReconciled(item);
  }

  applyDelegationChanges(changes: ExecutionChanges): void {
    immediate(this.db, () => {
      for (const itemId of changes.addedItemIds) {
        const item = getWorkItem(this.db, itemId);
        if (
          !item ||
          item.delegationId !== changes.delegationId ||
          item.sessionKey !== changes.sessionId
        )
          throw new Error("Changed task ownership does not match the delegation");
        saveTaskMode(
          this.db,
          itemId,
          "code",
          getLinearSessionGeneration(this.db, changes.sessionId),
          true,
        );
      }
      const canceled = new Set([
        ...changes.removedItemIds,
        ...changes.canceledItemIds,
        ...(changes.parentCanceled
          ? this.delegationItems(changes.delegationId).map((item) => item.id)
          : []),
      ]);
      for (const itemId of new Set([...canceled, ...changes.specChangedItemIds])) {
        const item = getWorkItem(this.db, itemId);
        if (
          !item ||
          item.delegationId !== changes.delegationId ||
          item.sessionKey !== changes.sessionId
        )
          throw new Error("Changed task ownership does not match the delegation");
        if (isTerminalWorkItemState(item.state)) continue;
        if (canceled.has(itemId)) {
          applyLinearCommand(this.db, {
            type: "cancel",
            itemId,
            source: "linear",
            requestedAt: this.now(),
          });
          const dependents = this.db
            .query<{ id: string; identifier: string }, [string, string]>(
              `SELECT i.id,i.linear_identifier AS identifier FROM task_block b JOIN work_item i ON i.linear_issue_id=b.blocked_linear_issue_id AND i.delegation_id=? WHERE b.blocker_linear_issue_id=? AND i.state NOT IN ('merged','completed','cancelled')`,
            )
            .all(changes.delegationId, item.linearIssueId);
          if (dependents.length)
            enqueueOutboxOnce(this.db, {
              target: "linear",
              op: "activity",
              orderingKey: changes.sessionId,
              idempotencyKey: `cancelled-blocker:${item.id}:${item.version}`,
              payload: {
                sessionId: changes.sessionId,
                kind: "error",
                body: `${item.linearIdentifier} was cancelled. Its dependents remain held until their dependencies change in Linear: ${dependents.map((dependent) => dependent.identifier).join(", ")}.`,
              },
              now: this.now(),
            });
          continue;
        }
        cancelOpenJobs(this.db, { itemId, reason: "Linear criteria changed", now: this.now() });
        this.db.run(
          "UPDATE run SET status='lost',updated_at=? WHERE item_id=? AND status IN ('active','provisioning')",
          [this.now(), itemId],
        );
        cancelItemQuestions(this.db, itemId, this.now());

        saveCheckpoint(
          this.db,
          itemId,
          item.state === "paused" && item.checkpoint
            ? {
                phase: "running",
                ...(item.checkpoint.wipCommit ? { wipCommit: item.checkpoint.wipCommit } : {}),
                ...(item.checkpoint.baseSha ? { baseSha: item.checkpoint.baseSha } : {}),
              }
            : null,
        );
        setCurrentRun(this.db, itemId, null);
        if (item.state === "failed" || item.state === "exhausted") {
          this.db.run(
            "UPDATE work_item SET cancel_requested=0,turn_count=0,recovery_attempts=0 WHERE id=?",
            [itemId],
          );
          resetAwakeTime(this.db, itemId);
          applyWorkItemEvent(this.db, itemId, "requeue");
        } else if (
          [
            "running",
            "verifying",
            "recovering",
            "awaiting_input",
            "awaiting_signoff",
            "merge_queue",
          ].includes(item.state)
        )
          applyWorkItemEvent(this.db, itemId, "restart");
        else this.db.run("UPDATE work_item SET version=version+1 WHERE id=?", [itemId]);
        enqueueOutboxOnce(this.db, {
          target: "linear",
          op: "activity",
          orderingKey: changes.sessionId,
          idempotencyKey: `criteria-changed:${item.id}:${getWorkItem(this.db, item.id)!.version}`,
          payload: {
            sessionId: changes.sessionId,
            kind: "thought",
            body: `${item.linearIdentifier} changed in Linear. Its previous verification is invalidated and the updated criteria will be checked before publication.`,
          },
          now: this.now(),
        });
      }
    });
  }

  async finishDelegationChanges(changes: ExecutionChanges): Promise<void> {
    const affected = new Set([
      ...changes.removedItemIds,
      ...changes.canceledItemIds,
      ...changes.specChangedItemIds,
      ...(changes.parentCanceled
        ? this.delegationItems(changes.delegationId).map((item) => item.id)
        : []),
    ]);
    await this.joinChangedItems([...affected]);
    if (changes.parentCanceled) await this.stopTaskPlanning(changes.sessionId);
  }

  async pauseItem(
    itemId: string,
    canAct: () => boolean = () => true,
    onCommitted?: () => void,
  ): Promise<boolean> {
    const paused = immediate(this.db, () => {
      const item = getWorkItem(this.db, itemId);
      if (!canAct() || item?.state !== "running" || item.cancelRequested) return false;
      applyWorkItemEvent(this.db, itemId, "pause");
      cancelOpenJobs(this.db, { itemId, reason: "Paused by a workspace member", now: this.now() });
      this.db.run(
        "UPDATE run SET status='lost',updated_at=? WHERE item_id=? AND status IN ('active','provisioning')",
        [this.now(), itemId],
      );
      onCommitted?.();
      return true;
    });
    if (!paused) return false;
    await this.joinChangedItems([itemId]);
    return true;
  }

  async resumeItem(
    itemId: string,
    canAct: () => boolean = () => true,
    onCommitted?: () => void,
  ): Promise<boolean> {
    if (getWorkItem(this.db, itemId)?.state !== "paused") return false;
    await this.joinChangedItems([itemId]);
    const resumed = immediate(this.db, () => {
      const item = getWorkItem(this.db, itemId);
      if (!canAct() || item?.state !== "paused" || item.cancelRequested) return false;
      applyWorkItemEvent(this.db, itemId, "restart");
      onCommitted?.();
      return true;
    });
    if (resumed) this.reconcileExecution();
    return resumed;
  }

  async interruptItem(itemId: string): Promise<void> {
    await this.joinChangedItems([itemId]);
  }

  /**
   * Stops the item's live agent and its runner work, and nothing else. Its GitHub
   * authorization and merge work stay, so accepted work keeps publishing and merging.
   */
  async stopAgent(itemId: string): Promise<void> {
    // Like ask_team: an answer to the time-limit question does not enqueue the
    // resume itself. The stopped run enqueues it when its operation finishes.
    for (const [runId, live] of this.live) if (live.itemId === itemId) this.askedRuns.add(runId);
    this.abortItem(itemId);
    await this.options.remoteExecution?.cancelItem?.(itemId);
  }

  private async joinChangedItems(itemIds: readonly string[]): Promise<void> {
    const affected = new Set(itemIds);
    const owned = [...this.live.values()].filter((live) => affected.has(live.itemId));
    for (const itemId of affected) {
      this.githubAuth?.revoke(itemId);
      this.abortItem(itemId);
    }
    const joined = await Promise.allSettled([
      ...owned.map((live) => live.done),
      ...[...affected].map((itemId) => this.options.remoteExecution?.cancelItem?.(itemId)),
    ]);
    if ([...affected].some((itemId) => getConversation(this.db, itemId).blocked))
      throw new Error("ACP process cleanup could not be verified");
    const failure = joined.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  invalidateGitHubAuthorization(scope: { sessionId?: string; issueId?: string } = {}): void {
    this.githubAuth?.invalidate(scope);
  }

  reconcileExecution(): void {
    this.dispatch();
  }

  sweepWorktrees(signal: AbortSignal): Promise<void> {
    const busy = (itemId: string) =>
      this.jobContexts.has(itemId) ||
      [...this.live.values()].some((live) => live.itemId === itemId);
    return sweepWorktrees({
      db: this.db,
      pawsRoot: this.options.pawsRoot,
      now: this.now(),
      signal,
      repositoryForItem: (item) => this.repositoryForItem(item),
      busy,
      hold: async (itemIds, operation) => {
        if (itemIds.some(busy)) return;
        const held: JobContext = {
          signal,
          isCurrent: () => !signal.aborted,
          extendLease: () => true,
        };
        for (const itemId of itemIds) this.jobContexts.set(itemId, held);
        try {
          await operation();
        } finally {
          for (const itemId of itemIds)
            if (this.jobContexts.get(itemId) === held) this.jobContexts.delete(itemId);
        }
      },
      mergedHeads: async (item, repository) => {
        const github = this.githubForRepository(repository);
        if (!github) return [];
        return mergedPullHeads({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          branch: worktreeBranch(item),
          ...this.gitHubCredentials(github),
          signal,
        });
      },
    });
  }

  dependencyHandoff(itemId: string): string | undefined {
    const item = getWorkItem(this.db, itemId);
    if (!item) return undefined;
    const blockers = this.db
      .query<{ id: string; identifier: string; checkpoint: string | null }, [string, string]>(
        `SELECT i.id,i.linear_identifier AS identifier,r.checkpoint FROM task_block b
         JOIN work_item i ON i.id=(
           SELECT candidate.id FROM work_item candidate
           WHERE candidate.linear_issue_id=b.blocker_linear_issue_id AND candidate.delegation_id=?
           AND candidate.state<>'cancelled'
           AND NOT EXISTS(SELECT 1 FROM work_item_specification spec WHERE spec.item_id=candidate.id AND spec.present=0)
           ORDER BY candidate.created_at DESC, candidate.id DESC LIMIT 1)
         LEFT JOIN run r ON r.id=i.current_run_id
         WHERE b.blocked_linear_issue_id=? AND i.state IN ('merged','completed')
         ORDER BY i.position,i.id`,
      )
      .all(item.delegationId, item.linearIssueId);
    const active = new Set(this.delegationItems(item.delegationId).map((entry) => entry.id));
    const results = blockers
      .filter((blocker) => active.has(blocker.id))
      .map((blocker) => {
        const result = blocker.checkpoint ? JSON.parse(blocker.checkpoint)?.resultBody : null;
        return `${blocker.identifier}: ${typeof result === "string" && result.trim() ? result : "Completed."}`;
      });
    const resume = item.checkpoint
      ? `Resume the existing branch ${item.branchName}. Preserve its previous work${item.checkpoint.wipCommit ? ` at commit ${item.checkpoint.wipCommit}` : ""} and continue the original conversation.`
      : undefined;
    const dependencies = results.length
      ? `Completed dependencies:\n${results.join("\n\n")}`
      : undefined;
    return [resume, dependencies].filter(Boolean).join("\n\n") || undefined;
  }

  private dispatch(): void {
    const ownerHasRunner = this.options.ownerHasRunner;
    let config: ReturnType<typeof loadConfigFile> | null = null;
    try {
      if (ownerHasRunner) config = loadConfigFile(join(this.options.pawsRoot, "config.toml"));
    } catch {
      config = null;
    }
    dispatch(this.db, {
      now: this.now(),
      admission: this.admission,
      ...(this.options.journal ? { log: this.options.journal } : {}),
      handoffForItem: (itemId) => this.dependencyHandoff(itemId),
      sessionFor: (itemId) => {
        const item = getWorkItem(this.db, itemId);
        return item && this.activitySession(item);
      },
      ...this.options.scheduling?.(),
      onWaiting: (itemIds) => this.noteQueued(itemIds),
      ...(ownerHasRunner && config
        ? {
            ownerHasRunner: (itemId: string) => {
              const item = getWorkItem(this.db, itemId);
              if (!item) return null;
              return ownerHasRunner(itemId, this.implementerAgent(item, config), this.now());
            },
            onRunnerSetup: (itemIds: readonly string[]) =>
              this.noteRunnerSetup(itemIds, (item) => this.implementerAgent(item, config)),
          }
        : {}),
    });
  }

  private implementerAgent(item: WorkItemRecord, config: ReturnType<typeof loadConfigFile>) {
    const repository = this.repositoryForItem(item);
    return resolveAgentProfiles(
      config,
      repository ? `${repository.owner}/${repository.repo}` : undefined,
    ).implementer.agent;
  }

  /**
   * A queued item whose owner has no runner they may use is not in the slot line. It gets no
   * queue notice and no start timeout. When Paws can tell what is missing, the item gets a
   * runner-setup hold and its session hears it once; the scheduler starts it on its own once the
   * owner has a usable runner. A runner that is only offline gets the general line.
   */
  private noteRunnerSetup(
    itemIds: readonly string[],
    agentFor: (item: WorkItemRecord) => string,
  ): void {
    const now = this.now();
    for (const id of itemIds) {
      const item = getWorkItem(this.db, id);
      if (!item || item.state !== "queued" || item.cancelRequested) continue;
      clearQueueWait(this.db, item.id);
      const need = this.options.runnerSetupNeed?.(item.id, agentFor(item), now) ?? null;
      if (need) {
        immediate(this.db, () => {
          const current = getWorkItem(this.db, item.id);
          if (current?.state === "queued" && !current.cancelRequested)
            this.recordRunnerSetupHold(current, need, now);
        });
        continue;
      }
      const sessionId = this.activitySession(item);
      if (sessionId === null) continue;
      const name = item.linearIdentifier ?? "this issue";
      enqueueOutboxOnce(this.db, {
        target: OUTBOX_ACTIVITY.target,
        op: OUTBOX_ACTIVITY.op,
        orderingKey: sessionId,
        idempotencyKey: `runner-setup:${item.id}:${item.version}`,
        payload: {
          sessionId,
          kind: "thought",
          body: `${name} waits for a runner you can use. Add one on the Runners page and sign in to its agent, or ask your project lead to share theirs. Paws starts ${name} on its own once a runner is ready.`,
        },
        now,
      });
    }
  }

  private noteQueued(itemIds: readonly string[]): void {
    const now = this.now();
    const hours = this.queueStartTimeoutHours();
    for (const id of itemIds) {
      const item = getWorkItem(this.db, id);
      if (!item || item.state !== "queued" || item.cancelRequested) continue;
      if (
        this.db
          .query(
            "SELECT 1 FROM job WHERE queue=? AND status IN ('pending','running') AND json_extract(payload,'$.itemId')=? LIMIT 1",
          )
          .get(JOB_KIND.start, item.id)
      )
        continue;
      const name = item.linearIdentifier ?? "this issue";
      if (now - queueWaitSince(this.db, item.id, item.version, now) >= hours * 3_600_000) {
        failWorkItem(
          this.db,
          item,
          "start_timeout",
          `Paws couldn't start ${name} within ${hours === 1 ? "1 hour" : `${hours} hours`} because every runner slot stayed busy. Delegate it again to retry.`,
          now,
        );
        continue;
      }
      const sessionId = this.activitySession(item);
      if (sessionId === null) continue;
      const position = getQueuePosition(this.db, item.id);
      enqueueOutboxOnce(this.db, {
        target: OUTBOX_ACTIVITY.target,
        op: OUTBOX_ACTIVITY.op,
        orderingKey: sessionId,
        idempotencyKey: `queued:${item.id}:${item.version}`,
        payload: {
          sessionId,
          kind: "thought",
          body: `${position ? queueLine(position) : "Queued: every runner slot is busy."} Paws starts ${name} when a slot frees.`,
        },
        now,
      });
    }
  }

  private ensureRun(item: WorkItemRecord): { id: string } {
    if (item.currentRunId !== null) {
      const existing = getRun(this.db, item.currentRunId);
      if (existing && existing.status === "active") return existing;
      // A runner-setup hold stopped this run before any work. The resume continues it, so the
      // task keeps one run.
      if (existing?.status === "lost" && takeRunnerSetupResume(this.db, item.id, existing.id)) {
        markRun(this.db, existing.id, "active", this.now());
        return existing;
      }
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

  private continueAfterRateLimit(item: WorkItemRecord, retryAfterMs: number): void {
    const key = `linear-rate-limit:${item.id}:${item.version}`;
    enqueueJobOnce(this.db, {
      queue: item.state === "running" ? JOB_KIND.resume : JOB_KIND.reverify,
      jobKey: key,
      payload: { itemId: item.id, reason: "linear-rate-limit" },
      runAt: this.now() + Math.max(retryAfterMs, RATE_LIMIT_RETRY_MS),
      now: this.now(),
    });
  }

  private fail(item: WorkItemRecord, reason: string, text: string, cause?: unknown): void {
    if (!(this.jobContexts.get(item.id)?.isCurrent() ?? true)) return;
    const current = getWorkItem(this.db, item.id) ?? item;
    console.error(
      `${current.linearIdentifier} failed (${reason}): ${text}`,
      ...(cause === undefined ? [] : [cause]),
    );
    if (
      current.state === "running" ||
      current.state === "verifying" ||
      current.state === "recovering" ||
      current.state === "merge_queue"
    ) {
      failWorkItem(this.db, current, reason, text, this.now());
    } else {
      this.post(current, "error", text, `fail:${current.id}:${current.version}:${reason}`);
    }
    this.dispatch();
  }

  private planHook(
    item: WorkItemRecord,
    progress: { plan(steps: readonly SessionPlanStep[]): void } | null,
  ): UpdatePlanHook | undefined {
    if (!progress) return undefined;
    return {
      update: async (steps) => {
        if (!this.canReportProgress(item.id))
          throw new Error("Plan updates are closed for this run");
        progress.plan(steps);
        await this.flush();
      },
    };
  }

  private agentCloseoutHook(item: WorkItemRecord, runId: string): CloseoutProgressHook {
    return {
      record: (progress) => {
        if (this.stopped(item.id)) return;
        recordAgentCloseout(this.db, runId, item.id, progress, this.now());
      },
    };
  }

  private pullRequestHook(item: WorkItemRecord): PullRequestHook {
    return {
      update: async (description) => {
        if (this.stopped(item.id)) throw new Error("Pull request updates are closed for this run");
        savePullRequestDraft(this.db, item.id, description, this.now());
      },
    };
  }

  private updateHook(item: WorkItemRecord): PostUpdateHook {
    return {
      post: async (text) => {
        if (!this.canReportProgress(item.id))
          throw new Error("Progress updates are closed for this run");
        const allowed = this.updates.take(item.id);
        if (allowed.posted) {
          this.post(item, "thought", publicToolText(text), `update:${item.id}:${this.now()}`);
          await this.flush();
        }
        return allowed;
      },
    };
  }

  private sessionProgress(item: WorkItemRecord, mode: "code" | "answer" | "artifact" = "code") {
    if (!this.tracker?.updateSession) return null;
    const sessionId = this.activitySession(item);
    return sessionId === null
      ? null
      : createLinearSessionProgress(
          this.db,
          sessionId,
          item.linearIdentifier,
          () => this.now(),
          mode,
          item.id,
        );
  }

  private post(
    item: WorkItemRecord,
    kind: "thought" | "action" | "response" | "error",
    body: string,
    key: string,
    details: Pick<ProgressUpdate, "id" | "ephemeral" | "action"> = {},
    delivery?: "critical" | "ordered",
  ): number | undefined {
    if (!(this.jobContexts.get(item.id)?.isCurrent() ?? true)) return;
    const current = getWorkItem(this.db, item.id);
    if (current === null || current.state === "cancelled") return;
    if ((kind === "thought" || kind === "action") && !this.canReportProgress(item.id)) return;
    const sessionId = this.activitySession(current);
    if (sessionId === null || body.trim() === "") return;
    return enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "activity",
      orderingKey: sessionId,
      idempotencyKey: key,
      delivery,
      payload: { ...details, sessionId, itemId: item.id, issueId: item.linearIssueId, kind, body },
      now: this.now(),
    });
  }

  private canReportProgress(itemId: string): boolean {
    if (!(this.jobContexts.get(itemId)?.isCurrent() ?? true)) return false;
    const item = getWorkItem(this.db, itemId);
    if (item === null || item.cancelRequested) return false;
    if (!["running", "verifying", "merge_queue"].includes(item.state)) return false;
    const sessionId = this.activitySession(item);
    return (
      sessionId === null ||
      (findOpenQuestion(this.db, sessionId) === null && !this.hasPublishedPullRequest(sessionId))
    );
  }

  private hasPublishedPullRequest(sessionId: string): boolean {
    return Boolean(
      this.db
        .query(
          `SELECT 1 FROM outbox WHERE target='linear' AND ordering_key=?
           AND delivery_generation=? AND idempotency_key LIKE 'pull-request-ready:%'
           AND status!='dropped' LIMIT 1`,
        )
        .get(sessionId, getLinearSessionGeneration(this.db, sessionId)),
    );
  }

  /** The item opened a pull request in some generation of its session. A new turn starts a new generation. */
  private hasOpenedPullRequest(itemId: string): boolean {
    const prefix = `pull-request-ready:${itemId}:`;
    return Boolean(
      this.db
        .query(
          `SELECT 1 FROM outbox WHERE target='linear' AND substr(idempotency_key, 1, length(?)) = ?
           AND status!='dropped' LIMIT 1`,
        )
        .get(prefix, prefix),
    );
  }

  private postStatus(
    item: WorkItemRecord,
    stateType: "started" | "completed" | "canceled",
    issueId = item.linearIssueId,
  ): void {
    if (this.taskAccess() && !getLinearTaskDelegation(this.db, item.id, issueId)?.humanActorId)
      return;
    const sessionId = this.activitySession(item) ?? item.id;
    enqueueOutboxOnce(this.db, {
      target: "linear",
      op: "status",
      orderingKey: sessionId,
      idempotencyKey: `status:${item.id}:${issueId}:${stateType}:${item.version}`,
      payload: { itemId: item.id, linearIssueId: issueId, stateType },
      now: this.now(),
    });
  }

  private assignSession(delegationId: string, sessionId: string): void {
    const items = this.delegationItems(delegationId);
    const item =
      items.find((entry) => inFlight(entry.state)) ??
      items.find((entry) => entry.state === "queued");
    if (item) activateLinearItem(this.db, sessionId, item.id);
  }

  private assertJobCurrent(itemId: string): void {
    const context = this.jobContexts.get(itemId);
    if (context && !context.isCurrent()) throw context.signal.reason;
  }

  private remoteAgentForItem(itemId: string) {
    const runner = this.options.remoteExecution?.agentForItem(itemId);
    if (!runner) return undefined;
    return async (options: RunAgentOptions) => {
      this.assertJobCurrent(itemId);
      const result = await runner(options);
      this.assertJobCurrent(itemId);
      return result;
    };
  }

  private async runLeasedJob(
    payload: unknown,
    context: JobContext,
    operation: () => Promise<void>,
  ): Promise<void> {
    const itemId = readString(payload, "itemId");
    if (!itemId) return;
    if (this.jobContexts.has(itemId)) throw new Error("Task already has an owned job operation");
    if (!context.isCurrent()) throw context.signal.reason;
    this.jobContexts.set(itemId, context);
    try {
      await this.loadProjectOverview(itemId, context.signal);
      await operation();
      if (!context.isCurrent()) throw context.signal.reason;
    } finally {
      if (this.jobContexts.get(itemId) === context) this.jobContexts.delete(itemId);
    }
  }

  private async runOwnedJob(payload: unknown, operation: () => Promise<void>): Promise<void> {
    const itemId = readString(payload, "itemId");
    if (!itemId) return;
    if (this.shuttingDown) throw new Error("Paws is shutting down");
    const key = `operation:${itemId}`;
    const live = this.beginLive(itemId, key);
    try {
      this.conversations.set(
        itemId,
        await durableConversation(this.db, itemId, this.remoteAgentForItem(itemId)),
      );
      this.assertJobCurrent(itemId);
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
    if (this.live.has(key)) throw new Error("Run already has an owned live operation");
    const authority = this.jobContexts.get(itemId);
    const controller = new AbortController();
    const abort = () => controller.abort(authority?.signal.reason);
    authority?.signal.addEventListener("abort", abort, { once: true });
    if (authority && !authority.isCurrent()) abort();
    let finish!: () => void;
    const item = getWorkItem(this.db, itemId);
    const sessionId = item === null ? null : this.activitySession(item);
    const live = {
      itemId,
      sessionId,
      generation: sessionId === null ? 0 : getLinearSessionGeneration(this.db, sessionId),
      controller,
      progress: null as string | null,
      done: new Promise<void>((resolve) => {
        finish = resolve;
      }),
      finish: () => {
        authority?.signal.removeEventListener("abort", abort);
        finish();
      },
    };
    this.live.set(key, live);
    return live;
  }

  private taskAccess(): LinearTaskAccess | undefined {
    return this.options.linearTaskModes ? this.options.linearAccess : undefined;
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
        const current = getWorkItem(this.db, item.id);
        if (
          !current ||
          this.stopped(item.id) ||
          current.currentRunId !== item.currentRunId ||
          (item.sessionKey && getLinearSessionGeneration(this.db, item.sessionKey) !== generation)
        )
          throw new Error("The repository read belongs to an obsolete task.");
        await this.taskAccess()?.assert(current, signal, {
          allowTerminalIssue: access === "read",
        });
        const auth = this.authorization(current);
        if (auth && !(await auth.ensure(current, "initial", signal)))
          throw new Error(
            "The GitHub App installation must cover the repository before reading it.",
          );
      },
    });
  }

  private authorization(item: WorkItemRecord): GitHubInstallationCheck | null {
    return item.sessionKey !== null ? this.githubAuth : null;
  }

  private signalForItem(itemId: string): AbortSignal | undefined {
    const authority = this.jobContexts.get(itemId);
    authority?.isCurrent();
    return (
      [...this.live.values()].find((live) => live.itemId === itemId)?.controller.signal ??
      authority?.signal
    );
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
    const routed = workItemForSession(this.db, sessionId);
    let item = routed ? getWorkItem(this.db, routed.id) : null;
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
      if (result.items.length === 0) {
        const keys = turns.map((turn) => turn.eventKey);
        immediate(this.db, () => {
          discardLinearTurns(this.db, sessionId, keys);
          enqueueOutboxOnce(this.db, {
            target: "linear",
            op: "activity",
            orderingKey: sessionId,
            idempotencyKey: `parent-turn:${sessionId}:${keys[0]}`,
            payload: {
              sessionId,
              kind: "response",
              body: "Each sub-issue runs in its own session. Reply in a sub-issue's session to change its work, or stop this session to stop them all.",
              id: crypto.randomUUID(),
            },
            now: this.now(),
          });
        });
        await this.flush();
        return;
      }
      bindLinearSessionTask(this.db, sessionId, result.delegation.id, {
        actorId: turns[0]!.actorId,
      });
      item = getWorkItem(this.db, result.items[0]!.id);
      if (item) activateLinearItem(this.db, sessionId, item.id);
    }
    if (!item) throw new Error("Linear user update has no routed task");
    if (getConversation(this.db, item.id).blocked)
      throw new Error(
        "Prior ACP process cleanup could not be verified; user update remains pending",
      );
    // Linear's "Fix merge conflicts" on the open pull request is a rebase-conflict return.
    const upstream =
      item.id === routed?.id &&
      this.hasOpenedPullRequest(item.id) &&
      turns.some((turn) => isMergeConflictRequest(turn.body))
        ? await this.fetchUpstreamMain(item)
        : null;
    const conflict: RebaseConflict = { base: upstream, files: null };
    const rebase =
      upstream !== null && rebaseBudgetFor(this.db, item.id, conflict, this.now()).allowed;
    const handoff = turns.map((turn) => turn.body).join("\n\n");
    const jobKey = `linear-turn:${sessionId}:${getLinearSessionGeneration(this.db, sessionId)}`;
    immediate(this.db, () => {
      if (item!.cancelRequested || item!.state === "failed" || item!.state === "exhausted") {
        this.db.run(
          "UPDATE work_item SET cancel_requested = 0, turn_count = 0, recovery_attempts = 0 WHERE id = ?",
          [item!.id],
        );
        resetAwakeTime(this.db, item!.id);
        if (this.options.caps) configureWorkItem(this.db, item!.id, this.options.caps);
      }
      if (item!.currentRunId) markRun(this.db, item!.currentRunId!, "ended", this.now());
      if (item!.state === "failed" || item!.state === "exhausted")
        applyWorkItemEvent(this.db, item!.id, "requeue");
      else if (item!.state !== "queued") applyWorkItemEvent(this.db, item!.id, "restart");
      this.db.run(
        "UPDATE job SET status = 'cancelled', finished_at = ?, last_error = 'Superseded by Linear user update' WHERE status = 'pending' AND json_extract(payload,'$.itemId') = ? AND (job_key IS NULL OR job_key != ?)",
        [this.now(), item!.id, jobKey],
      );
      const jobId = enqueueJobOnce(this.db, {
        queue: JOB_KIND.resume,
        jobKey,
        payload: rebase
          ? {
              itemId: item!.id,
              handoff: `${REBASE_CONFLICT_INSTRUCTION}\n\n${handoff}`,
              reason: "rebase-conflict",
            }
          : { itemId: item!.id, handoff },
        now: this.now(),
      });
      if (rebase)
        recordRebaseReturn(this.db, {
          itemId: item!.id,
          jobId,
          candidate: null,
          reason: "linear",
          ...conflict,
          recordedAt: this.now(),
        });
    });
    await this.flush();
  }

  /**
   * Fetch main into the item's worktree, as a merge pass does before a
   * rebase-conflict return. Returns main's commit, or null without a worktree.
   */
  private async fetchUpstreamMain(item: WorkItemRecord): Promise<string | null> {
    const repository = this.repositoryForItem(item);
    const github = repository ? this.githubForRepository(repository) : null;
    const worktree = worktreePath(this.options.pawsRoot, itemPathId(item));
    if (!repository || !github || !existsSync(worktree)) return null;
    return fetchUpstreamMain({
      worktree,
      owner: repository.owner,
      repo: repository.repo,
      client: github.client,
      remoteUrl: repository.remoteUrl,
      ...this.gitHubCredentials(github),
    });
  }

  private async forwardFollowUp(
    sessionId: string,
    turn: { eventKey: string; body: string },
  ): Promise<boolean> {
    if (!this.options.remoteFollowUp) return false;
    const live = [...this.live.values()].filter((entry) =>
      this.itemsForSession(sessionId).some((item) => item.id === entry.itemId),
    );
    if (live.length !== 1) return false;
    const item = getWorkItem(this.db, live[0]!.itemId);
    if (item?.state !== "running" || !(await this.options.remoteFollowUp(item.id, turn.body)))
      return false;
    immediate(this.db, () => {
      applyLinearTurns(this.db, sessionId, [turn.eventKey], item.id);
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "activity",
        orderingKey: sessionId,
        idempotencyKey: `turn:ack:${turn.eventKey}`,
        payload: {
          sessionId,
          kind: "thought",
          body: "Sent your update to the running agent.",
          id: crypto.randomUUID(),
        },
        now: this.now(),
      });
    });
    await this.flush();
    return true;
  }

  private abortItem(itemId: string): void {
    for (const live of this.live.values()) {
      if (live.itemId !== itemId) continue;
      live.controller.abort();
    }
  }

  private itemsForSession(sessionId: string): WorkItemRecord[] {
    return this.allItems().filter((item) => item.sessionKey === sessionId);
  }

  private allItems(includeArchived = false): WorkItemRecord[] {
    const specification =
      !includeArchived &&
      this.db
        .query("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_item_specification'")
        .get();
    const rows = this.db
      .query<{ id: string }, []>(
        specification
          ? "SELECT id FROM work_item i WHERE NOT EXISTS(SELECT 1 FROM work_item_specification s WHERE s.item_id=i.id AND s.present=0)"
          : "SELECT id FROM work_item",
      )
      .all();
    const items: WorkItemRecord[] = [];
    for (const row of rows) {
      const item = getWorkItem(this.db, row.id);
      if (item) items.push(item);
    }
    return items;
  }

  private delegationItems(delegationId: string): WorkItemRecord[] {
    return this.allItems()
      .filter((item) => item.delegationId === delegationId)
      .sort((left, right) => left.position - right.position);
  }

  private parentTaskKey(item: WorkItemRecord): string | null {
    return (
      this.db
        .query<{ task_key: string | null }, [string]>(
          `SELECT ${parentTaskKeySql("work_item")} AS task_key FROM work_item WHERE id = ?`,
        )
        .get(item.id)?.task_key ?? null
    );
  }

  private delegationIssueId(item: WorkItemRecord): string | null {
    return (
      this.db
        .query<{ issue_id: string | null }, [string]>(
          `SELECT ${delegationIssueIdSql("work_item")} AS issue_id FROM work_item WHERE id = ?`,
        )
        .get(item.id)?.issue_id ?? null
    );
  }

  private async flush(signal?: AbortSignal, session?: string | null): Promise<void> {
    const claimed = new Set<number>();
    const needed = (row: OutboxRow) =>
      session ? row.orderingKey === session : claimed.has(row.id);
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), this.options.outboxWaitMs ?? OUTBOX_WAIT_MS);
    const stop = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    try {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        signal?.throwIfAborted();
        const ticked = this.options.outbox.tick();
        for (const row of ticked) claimed.add(row.id);
        if (stop.aborted) break;
        let onAbort: () => void = () => {};
        try {
          await Promise.race([
            this.options.outbox.idle(needed),
            new Promise<void>((resolve) => {
              onAbort = resolve;
              stop.addEventListener("abort", onAbort, { once: true });
            }),
          ]);
        } finally {
          stop.removeEventListener("abort", onAbort);
        }
        if (stop.aborted || !ticked.some(needed)) break;
      }
      signal?.throwIfAborted();
    } finally {
      clearTimeout(timer);
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
    if (!sessionId) return;
    if (!hasLinearSessionSnapshotContext(this.db, sessionId) && this.tracker?.getSession) {
      const session = await this.tracker.getSession(sessionId, { signal });
      signal.throwIfAborted();
      ensureLinearSession(this.db, {
        sessionId,
        issueId: session.issue?.id,
        appUserId: session.appUserId,
        creatorId: session.creatorId,
        now: this.now(),
      });
      const linked = workItemForSession(this.db, sessionId);
      if (linked) bindLinearSessionTask(this.db, sessionId, linked.delegationId);
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
    const tracker = this.tracker;
    if (!tracker?.listSessionActivities) return;
    const generation = getLinearSessionGeneration(this.db, sessionId);
    if (linearActivitiesListedAt(this.db, sessionId) === generation) return;
    let activities;
    try {
      activities = await linearCaller("context", () =>
        tracker.listSessionActivities!(sessionId, { signal }),
      );
    } catch (error) {
      signal.throwIfAborted();
      if (
        error instanceof LinearRateLimitError &&
        listLinearActivitySnapshots(this.db, sessionId).length > 0
      )
        return;
      throw error;
    }
    signal.throwIfAborted();
    immediate(this.db, () => {
      for (const activity of activities)
        saveLinearActivitySnapshot(this.db, {
          id: activity.id,
          sessionId,
          createdAt: activity.createdAt,
          snapshot: JSON.stringify(activity),
        });
      markLinearActivitiesListed(this.db, sessionId, generation);
    });
  }

  private async loadProjectOverview(itemId: string, signal: AbortSignal): Promise<void> {
    const item = getWorkItem(this.db, itemId);
    const tracker = this.options.tracker;
    if (!item || getTaskLinearRead(this.db, itemId, "project_overview") !== undefined) return;
    if (tracker?.issueMergeContext && !getTaskMergeSettings(this.db, itemId)) {
      await this.mergeSettingsFor(item, signal);
      return;
    }
    if (!tracker?.projectOverview) return;
    try {
      const overview = await tracker.projectOverview(item.linearIssueId, { signal });
      keepTaskLinearRead(
        this.db,
        itemId,
        "project_overview",
        projectOverviewText(overview),
        this.now(),
      );
    } catch {
      signal.throwIfAborted();
    }
  }

  private workContext(item: WorkItemRecord): string {
    const taskKey = this.parentTaskKey(item);
    const classification = taskKey ? getTaskClassification(this.db, taskKey) : null;
    const activities = item.sessionKey
      ? listLinearActivitySnapshots(this.db, item.sessionKey)
          .map((snapshot) => JSON.parse(snapshot) as LinearActivitySnapshot)
          .filter((activity) => activity.content.type !== "thought" && !activity.ephemeral)
      : [];
    return [
      renderWorkBrief(item.brief),
      (getTaskLinearRead(this.db, item.id, "project_overview") as string | undefined) ?? "",
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
    if (!sessionId) return undefined;
    const linear =
      this.options.files && this.options.secretsDir
        ? createLinearArtifactPublisher({
            db: this.db,
            files: this.options.files,
            secretsDir: this.options.secretsDir,
            itemId: item.id,
            issueId: item.linearIssueId,
            sessionId,
            now: () => this.now(),
          })
        : undefined;
    const evidence = this.options.evidence;
    if (!evidence) return linear;
    return createEvidenceArtifactPublisher({
      db: this.db,
      evidence: evidence.store,
      publicUrl: evidence.publicUrl,
      itemId: item.id,
      sessionId,
      uploads: Boolean(this.options.files && evidence.root),
      reviewed: (checkId) =>
        this.visualReviewRequirements(
          item,
          worktreePath(this.options.pawsRoot, itemPathId(item)),
        ).some((requirement) => requirement.id === checkId),
      ...(linear ? { linear } : {}),
      now: () => this.now(),
    });
  }

  private visualReviewRequirements(item: WorkItemRecord, worktree: string): ResolvedEvidence[] {
    const repository = this.repositoryForItem(item);
    if (!repository) return [];
    const required = visualReviewRequirements(
      worktree,
      this.options.home,
      this.options.closeoutPolicyRoot?.(repository),
    );
    return required.ok ? required.items : [];
  }

  private async askVisualReview(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
  ): Promise<boolean> {
    const evidence = this.options.evidence;
    const sessionId = this.activitySession(item);
    if (!evidence || sessionId === null) return false;
    const requirements = this.visualReviewRequirements(item, worktree);
    if (requirements.length === 0) return false;
    const approvals = await approvalsAtHead(
      worktree,
      head,
      visualReviewApprovals(this.db, item.id, itemPathId(item)),
      requirements,
      undefined,
      base,
    );
    let carriedOver = false;
    // A check whose screens all carried an approval over passes; the next check may still be due.
    for (let pass = 0; pass <= requirements.length; pass++) {
      const due = dueVisualReview(this.db, item.id, requirements, approvals);
      if (due === null) break;
      const plan = await planVisualReviewCarry(
        this.db,
        item.id,
        due.requirement.id,
        due.evidenceIds,
        evidence.root,
      );
      const outcome = immediate(this.db, () => {
        const now = dueVisualReview(this.db, item.id, requirements, approvals);
        if (now === null) return "none" as const;
        if (now.requirement.id !== due.requirement.id) return "again" as const;
        const current = getWorkItem(this.db, item.id);
        if (!reviewable(current)) return "none" as const;
        const carried = plan.carried.filter((entry) => now.evidenceIds.includes(entry.evidenceId));
        if (carried.length === now.evidenceIds.length) {
          const review = carryVisualReview(this.db, {
            item: current,
            sessionId,
            checkId: now.requirement.id,
            evidenceIds: now.evidenceIds,
            carried,
            head,
            now: this.now(),
          });
          approvals.push(
            ...visualReviewApprovals(this.db, item.id, itemPathId(item)).filter(
              (approval) =>
                approval.checkId === review.checkId &&
                approval.commit === head &&
                review.evidenceIds.every((id) => approval.evidenceIds.includes(id)),
            ),
          );
          return "carried" as const;
        }
        const runId = current.currentRunId ?? null;
        if (
          !askForVisualReview(this.db, {
            item,
            runId,
            sessionId,
            checkId: now.requirement.id,
            evidenceIds: now.evidenceIds,
            carried,
            approved: plan.approved,
            base,
            head,
            publicUrl: evidence.publicUrl,
            now: this.now(),
          })
        )
          return "none" as const;
        if (runId) releaseRunCapacity(this.db, runId, this.now());
        return "asked" as const;
      });
      if (outcome === "carried") carriedOver = true;
      else if (outcome === "asked") {
        await this.flush();
        return true;
      } else if (outcome === "none") break;
    }
    if (carriedOver) await this.flush();
    return false;
  }

  async requestVisualReviewChanges(input: {
    questionId: string;
    answeredBy: string;
    note: string;
    marks: readonly VisualReviewMark[];
  }): Promise<"answered" | "forbidden" | "rejected"> {
    const open = getQuestion(this.db, input.questionId);
    const review = open ? getVisualReview(this.db, open.id) : null;
    if (open?.status !== "open" || review?.kind !== "review") return "rejected";
    const item = getWorkItem(this.db, open.itemId);
    if (item === null) return "rejected";
    if (!this.canAnswerVisualReview(item, input.answeredBy)) return "forbidden";
    return this.answerVisualReview(
      open,
      review,
      `dashboard:${crypto.randomUUID()}`,
      `Request changes: ${input.note}`,
      input.answeredBy,
      input.marks,
    );
  }

  private async answerVisualReview(
    open: StoredQuestion,
    review: StoredVisualReview,
    eventKey: string,
    answer: string,
    answeredBy: string,
    marks?: readonly VisualReviewMark[],
  ): Promise<"answered" | "rejected"> {
    const sessionId = open.sessionId;
    const outcome = immediate(this.db, () => {
      const item = getWorkItem(this.db, open.itemId);
      if (
        item === null ||
        item.state !== "awaiting_input" ||
        item.cancelRequested ||
        getQuestion(this.db, open.id)?.status !== "open"
      )
        return "rejected" as const;
      if (review.kind === "review" && parseVisualReviewAnswer(answer).kind === "describe") {
        if (marks) saveVisualReviewMarks(this.db, marks);
        postNote(
          this.db,
          sessionId,
          item,
          VISUAL_REVIEW_DESCRIBE,
          `visual-review-describe:${eventKey}`,
          this.now(),
        );
        return "rejected" as const;
      }
      const answered = answerAsked(
        this.db,
        { sessionId, deliveryId: eventKey, body: answer, answeredBy, now: this.now() },
        questionEffects(this.db, {
          now: this.now(),
          asking: (runId) => this.askedRuns.has(runId),
          ...(marks ? { marks } : {}),
        }),
      );
      return answered.status === "answered" ? ("answered" as const) : ("rejected" as const);
    });
    await this.flush();
    return outcome;
  }

  private async visualReviewOutdated(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
  ): Promise<boolean> {
    const reviews = acceptedVisualReviews(this.db, item.id);
    if (reviews.length === 0) return false;
    const requirements = this.visualReviewRequirements(item, worktree);
    if (requirements.length === 0) return false;
    const checks = new Set(requirements.map((entry) => entry.id));
    const approvals = visualReviewApprovals(this.db, item.id, itemPathId(item));
    const valid = new Set(
      await approvalsAtHead(worktree, head, approvals, requirements, undefined, base),
    );
    const outdated = reviews.filter(
      (review, index) => checks.has(review.checkId) && !valid.has(approvals[index]!),
    );
    if (outdated.length === 0) return false;
    const checkIds = [...new Set(outdated.map((review) => review.checkId))];
    const resumed = immediate(this.db, () => {
      const current = getWorkItem(this.db, item.id);
      if (current?.state !== "running" || current.cancelRequested) return false;
      for (const review of outdated) markVisualReviewStale(this.db, review.questionId);
      if (current.currentRunId) releaseRunCapacity(this.db, current.currentRunId, this.now());
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.resume,
        jobKey: `visual-review-outdated:${outdated[0]!.questionId}`,
        payload: {
          itemId: item.id,
          freshSession: true,
          handoff: checkIds.map(visualReviewStaleHandoff).join("\n\n"),
          reason: "visual-review",
        },
        now: this.now(),
      });
      this.post(
        current,
        "thought",
        `Files under the paths of ${checkIds.join(", ")} changed after the visual review was accepted. The agent publishes new screenshots, then Paws asks again.`,
        `visual-review-outdated:${outdated[0]!.questionId}`,
      );
      return true;
    });
    if (resumed) await this.flush();
    return resumed;
  }

  /** The delegator and the project lead answer a visual review. */
  private canAnswerVisualReview(item: WorkItemRecord, actorId: string): boolean {
    return canAnswer(
      {
        kind: "visual-review",
        delegatorId: delegatedLinearUserId(this.db, item.id),
        leadId: projectLeadId(this.db, item.id),
      },
      { id: actorId },
    );
  }

  private prepareInputFiles(item: WorkItemRecord, turnId: string) {
    const loader = this.inputLoader;
    const sessionId = this.activitySession(item);
    const linear =
      loader && sessionId
        ? (input: { workspace: string; prompt: string; signal: AbortSignal }) =>
            loader({ ...input, sessionId, turnId })
        : undefined;
    const root = this.options.evidence?.root;
    if (!root) return linear;
    const marks = createReviewMarkLoader({ db: this.db, root, itemId: item.id, turnId });
    return async (input: { workspace: string; prompt: string; signal: AbortSignal }) => {
      const marked = await marks(input);
      if (!linear) return marked;
      const loaded = await linear({ ...input, prompt: marked.prompt });
      return { prompt: loaded.prompt, inputFiles: [...marked.inputFiles, ...loaded.inputFiles] };
    };
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
    const taskKey = this.parentTaskKey(item);
    const classification = taskKey ? getTaskClassification(this.db, taskKey) : null;
    const sourceItemId = classification?.mode !== "clarify" ? classification?.sourceItemId : null;
    const stored = getConversation(this.db, item.id);
    if (sourceItemId && stored.entries === "[]" && !stored.transcript) {
      await durableConversation(this.db, sourceItemId);
      saveConversation(this.db, item.id, getConversation(this.db, sourceItemId).entries, null);
    }
    const backend = this.remoteAgentForItem(item.id) ?? runAgent;
    const runner = await durableConversation(this.db, item.id, async (input) => {
      const policy =
        getTaskMode(this.db, item.id) === "code" &&
        input.role === "implementer" &&
        !input.prepareOnly
          ? await this.commitPolicy(item)
          : undefined;
      return backend({ ...input, commitPolicy: policy, ...this.trustedRunInputs(item, input) });
    });
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

  private async commitPolicy(item: WorkItemRecord): Promise<GitCommitPolicy | undefined> {
    if (!this.options.commitPolicyForItem) return undefined;
    const current = getWorkItem(this.db, item.id);
    if (!current?.currentRunId) throw new Error("Attribution run is missing");
    const prior =
      getRun(this.db, current.currentRunId)?.checkpoint?.commitPolicy ??
      getItemRunCommitPolicy(this.db, item.id);
    if (prior) {
      policyCoauthors(prior);
      saveRunCommitPolicy(this.db, current.currentRunId, prior);
      return prior;
    }
    const resolved = await this.options.commitPolicyForItem(current);
    if (
      getWorkItem(this.db, item.id)?.currentRunId !== current.currentRunId ||
      this.signalForItem(item.id)?.aborted
    )
      throw new Error("Attribution run changed while resolving identities");
    if (!resolved) throw new Error("Run attribution authority is unavailable");
    policyCoauthors(resolved);
    saveRunCommitPolicy(this.db, current.currentRunId, resolved);
    return resolved;
  }

  private agentDeps(item: WorkItemRecord): AcpAgentDeps {
    const runId = item.currentRunId ?? item.id;
    const repository = this.repositoryForItem(item);
    return {
      repository: repository ? `${repository.owner}/${repository.repo}` : undefined,
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
      promptRunner: async (input) => {
        const runner =
          this.conversations.get(item.id) ?? this.remoteAgentForItem(item.id) ?? runAgent;
        const policy =
          input.role === "implementer" && !input.prepareOnly
            ? await this.commitPolicy(item)
            : undefined;
        return runner({ ...input, commitPolicy: policy, ...this.trustedRunInputs(item, input) });
      },
      agentRunner: this.remoteAgentForItem(item.id),
      ...(this.options.home ? { home: this.options.home } : {}),
      launch: this.launchAgent.bind(this),
      brief: this.workContext(item),
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

  private activitySession(item: WorkItemRecord): string | null {
    const session = item.sessionKey;
    if (session === null || session.length === 0) return null;
    return session;
  }

  private delegationSession(items: readonly WorkItemRecord[]): string | null {
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
      closeActiveRun(this.db, runId, this.now());
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
    onRemoteEvent: (event: AcpEvent) => void,
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
    const required = reviewRequirements(
      worktree.path,
      this.options.home,
      this.options.closeoutPolicyRoot?.(repository),
    );
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
      const remote = this.remoteAgentForItem(item.id);
      const result = await (remote ?? runAgent)({
        ...launched,
        ...(remote ? { onEvent: onRemoteEvent } : {}),
        profile,
        role,
        itemId: itemPathId(item),
        runId: `${runId}-preflight-${role}`,
        worktreePath: worktree.path,
        pawsRoot: this.options.pawsRoot,
        ...(this.options.home ? { home: this.options.home } : {}),
        prepareOnly: true,
        readOnly: true,
        checkpoint: false,
        prompt: "",
        signal,
      }).catch((error: unknown) => {
        throw new Error(
          `${role} preparation failed: ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        );
      });
      if (!result.agentExited) this.blockConversation(item.id);
      if (!result.identity || result.errorMessage)
        throw new Error(
          `${role} preparation failed: ${result.errorMessage ?? "it did not report a concrete session model"}`,
        );
      identities.push(result.identity);
    }
    for (const check of requirements) {
      const [implementer, reviewer] = identities;
      if (check.independence.differentSession && implementer!.session === reviewer!.session)
        throw new Error(
          `reviewer preparation failed: Closeout ${check.id} requires a different reviewer session`,
        );
      if (check.independence.differentModel && implementer!.model === reviewer!.model)
        throw new Error(
          `reviewer preparation failed: Closeout ${check.id} requires a different reviewer model; choose another reviewer profile`,
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

  /** The Closeout policy and the runtime list, both read from origin/main and never the work tree. */
  private trustedRunInputs(
    item: WorkItemRecord,
    input: RunAgentOptions,
  ): Pick<RunAgentOptions, "closeoutPolicy" | "runtimes"> {
    if (input.prepareOnly || !this.repositoryForItem(item)) return {};
    const runtimes = { runtimes: () => this.runtimeList(item, input.worktreePath) };
    if (input.role !== "implementer") return runtimes;
    const { home, policyRoot } = this.closeoutHome(item);
    return {
      ...runtimes,
      closeoutPolicy: async () => {
        const load = trustedPolicyFiles(input.worktreePath, home, policyRoot);
        return load.ok && !load.absent
          ? { ...load, published: publishedEvidence(this.db, item.id) }
          : load;
      },
    };
  }

  /**
   * The repository's runtime list from mise config on origin/main, read once per run. Its
   * notices are returned with the first read only, so the task gets each line once.
   */
  private async runtimeList(item: WorkItemRecord, repo: string): Promise<RuntimeList> {
    const runId = getWorkItem(this.db, item.id)?.currentRunId ?? item.id;
    const cached = this.runtimeLists.get(item.id);
    if (cached?.runId === runId) return { runtimes: cached.list.runtimes, notices: [] };
    const list = runtimeList(trustedRootFiles(repo, RUNTIME_FILES));
    this.runtimeLists.set(item.id, { runId, list });
    return list;
  }

  private closeoutHome(item: WorkItemRecord): {
    home?: string;
    pawsHome: string;
    policyRoot?: string;
  } {
    const repository = this.repositoryForItem(item);
    const policyRoot = repository ? this.options.closeoutPolicyRoot?.(repository) : undefined;
    return {
      ...(policyRoot !== undefined ? { policyRoot } : {}),
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
      const catalog = listRepositoryCatalog(this.db).map(({ owner, repo, remoteUrl }) => ({
        owner,
        repo,
        remoteUrl,
      }));
      const configured = listRepositoryCandidates(
        this.db,
        item.sessionKey,
        this.options.repositories ?? (this.options.repository ? [this.options.repository] : []),
      );
      const listed = (candidate: RepositoryBinding) =>
        catalog.some((entry) => sameRepository(entry, candidate));
      const candidates: RepositoryBinding[] = auth ? [...configured] : [];
      for (const candidate of auth ? [] : configured) {
        controller.signal.throwIfAborted();
        if (
          listed(candidate) ||
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
          agentRunner: this.helperRunner(item.sessionKey, "select_repository"),
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
          if (savedAnswer)
            enqueueOutboxOnce(this.db, {
              target: "linear",
              op: "linear.repository_label",
              orderingKey: this.activitySession(item) ?? item.id,
              idempotencyKey: `repository-label:${item.id}`,
              payload: {
                issueId: item.linearIssueId,
                repository: `${selected.owner}/${selected.repo}`,
              },
              now: this.now(),
            });
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
      const recent = this.db
        .query<{ name: string }, []>(
          `SELECT lower(r.owner||'/'||r.repo) AS name FROM work_item_repository r
           JOIN work_item i ON i.id=r.item_id ORDER BY i.created_at DESC LIMIT 50`,
        )
        .all()
        .map((row) => row.name);
      const recency = (candidate: RepositoryBinding) => {
        const index = recent.indexOf(`${candidate.owner}/${candidate.repo}`.toLowerCase());
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
      };
      candidates.sort((left, right) => recency(left) - recency(right));
      let hinted: ReturnType<typeof hintedRepository> = null;
      if (this.tracker?.issueRepositoryHints) {
        try {
          const kept = getTaskLinearRead(this.db, item.id, "repository_hints") as
            | RepositoryHints
            | undefined;
          const hints =
            kept ??
            (await linearCaller("repository-hints", () =>
              this.tracker!.issueRepositoryHints!(item.linearIssueId, {
                signal: controller.signal,
              }),
            ));
          if (kept === undefined)
            keepTaskLinearRead(this.db, item.id, "repository_hints", hints, this.now());
          hinted = hintedRepository(candidates, hints);
        } catch (error) {
          controller.signal.throwIfAborted();
          console.error(
            `repository hints for ${item.linearIdentifier} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
      const best = new Map<string, RepositorySuggestion>();
      const pool = hinted && "ask" in hinted ? hinted.ask : candidates;
      const poolNames = pool.map((candidate) =>
        `${candidate.owner}/${candidate.repo}`.toLowerCase(),
      );
      const keptSuggestions = getTaskLinearRead(this.db, item.id, "repository_suggestions") as
        | { pool: string[]; suggestions: RepositorySuggestion[] }
        | undefined;
      const reuseSuggestions =
        keptSuggestions !== undefined &&
        poolNames.every((name) => keptSuggestions.pool.includes(name));
      if (reuseSuggestions)
        for (const suggestion of keptSuggestions.suggestions)
          best.set(suggestion.repositoryFullName.toLowerCase(), suggestion);
      const attempts =
        !reuseSuggestions &&
        !(hinted && "bind" in hinted) &&
        this.tracker?.issueRepositorySuggestions
          ? 3
          : 0;
      let suggested = false;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const read = await linearCaller("repository-hints", () =>
            this.tracker!.issueRepositorySuggestions!(
              {
                issueId: item.linearIssueId,
                candidateRepositories: pool.map((candidate) => ({
                  hostname: "github.com",
                  repositoryFullName: `${candidate.owner}/${candidate.repo}`,
                })),
              },
              { signal: controller.signal },
            ),
          );
          suggested = true;
          for (const suggestion of read) {
            const key = suggestion.repositoryFullName.toLowerCase();
            if ((best.get(key)?.confidence ?? -1) < suggestion.confidence)
              best.set(key, suggestion);
          }
        } catch (error) {
          controller.signal.throwIfAborted();
          console.error(
            `repository suggestions for ${item.linearIdentifier} failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
          if (attempt < 3) await delay(attempt * 500, undefined, { signal: controller.signal });
        }
      }
      if (suggested)
        keepTaskLinearRead(
          this.db,
          item.id,
          "repository_suggestions",
          { pool: poolNames, suggestions: [...best.values()] },
          this.now(),
        );
      if (this.stopped(item.id)) return false;
      const choice =
        hinted && "bind" in hinted ? hinted : chooseRepository(pool, [...best.values()]);
      let ranked = "ask" in choice ? choice.ask : [];
      if ("bind" in choice) {
        const accessible =
          !this.options.repositoryAccess ||
          (await this.options.repositoryAccess(choice.bind, controller.signal, access));
        controller.signal.throwIfAborted();
        if (!current()) return false;
        if (accessible) {
          bindWorkItemRepository(this.db, item.id, choice.bind);
          this.post(
            item,
            "thought",
            `Working in ${choice.bind.owner}/${choice.bind.repo}.`,
            `${item.id}:repository`,
          );
          if (auth && !(await auth.ensure(item, "initial", controller.signal))) {
            await this.flush();
            return false;
          }
          await this.flush();
          return true;
        }
        ranked = candidates
          .filter((candidate) => !sameRepository(candidate, choice.bind))
          .slice(0, 3);
      }
      const sessionId = this.activitySession(item);
      if (sessionId === null) throw new Error("Repository selection has no tracker session");
      immediate(this.db, () => {
        const { question } = ask(
          this.db,
          { itemId: item.id, runId: null, sessionId },
          "repository",
          "Which repository should I use? Choose one of the configured repositories or describe your choice.",
          {
            options: ranked.map(
              (candidate) => `https://github.com/${candidate.owner}/${candidate.repo}`,
            ),
            now: this.now(),
          },
        );
        saveWorkItemRepositoryQuestion(this.db, item.id, question.id, ranked);
        applyWorkItemEvent(this.db, item.id, "blocking_question");
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

const LINEAR_RATE_LIMITED = /Linear GraphQL: RATELIMITED/;
const RATE_LIMIT_RETRY_MS = 5_000;
const OUTBOX_WAIT_MS = 30_000;
const FIRST_ACTIVITY_HOLD_MS = 5_000;
const CHECKS_RATE_LIMIT_RETRY_MS = 60_000;
const CHECKS_RATE_LIMIT_WAIT_MS = 60 * 60_000;

export function attachOrchestrator(options: OrchestratorOptions): Orchestrator {
  return new Orchestrator(options);
}

function closeActiveRun(
  db: Database,
  runId: string,
  now: number,
  status: "ended" | "lost" = "ended",
): void {
  const run = getRun(db, runId);
  if (run && run.status === "active") markRun(db, runId, status, now);
}

function projectOverviewText(overview: ProjectOverview | null): string {
  return overview ? `Project overview: ${overview.name}\n\n${overview.content}` : "";
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

function withAcceptedBranch(text: string, item: WorkItemRecord): string {
  const sentence = /[.!?]$/.test(text) ? text : `${text}.`;
  return `${sentence} The accepted work is on branch \`${item.branchName || worktreeBranch(item)}\`.`;
}

function retryCount(payload: unknown): number {
  const retry = (payload as { retry?: unknown } | null)?.retry;
  return typeof retry === "number" ? retry : 0;
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

function listsChecks(report: string): boolean {
  try {
    const parsed = JSON.parse(report) as { required?: unknown };
    return Array.isArray(parsed.required) && parsed.required.length > 0;
  } catch {
    return false;
  }
}
