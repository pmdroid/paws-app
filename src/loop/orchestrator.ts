import { confirmDecision, suggestDecisions } from "../decisions";
import { checkoutPatterns, exclusionPatterns } from "../worktree-checkout";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
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
  PublishArtifactHook,
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
  resolveMergeSettings,
  type AgentProfile,
} from "../config";
import {
  approvalsAtHead,
  createCloseoutGate,
  reviewRequirements,
  trustedPolicyFiles,
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
  delegationHasOpenWork,
  delegationIssueIdSql,
  parentTaskKeySql,
  type Clock,
  type LinearCommand,
  type RepositoryBinding,
  PawsShutdown,
  RunnerSlotsBusyError,
  queueLine,
  mergeQueueLine,
  systemClock,
  parseLinearCommand,
  isTransientFailure,
  MAX_TRANSIENT_RETRIES,
  retryNote,
  transientRetryDelayMs,
} from "../core";
import {
  getTaskMode,
  assertLinearSessionCleanup,
  cancelOpenJobs,
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
  completeMergedItem,
  completeArtifactTask,
  artifactPublicationReady,
  listArtifacts,
  getTaskClassification,
  resolveTaskClassification,
  applyWorkItemEvent,
  configureWorkItem,
  enqueueJobOnce,
  enqueueJob,
  enqueueOutboxOnce,
  failWorkItem,
  getQueuePosition,
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
  saveCloseoutRecovery,
  listCloseoutRounds,
  recordCiRound,
  type CiRound,
  type CiRoundCheck,
  runRunnerAvailability,
  setRunningCloseoutStepDetail,
  startCloseoutRound,
  type CloseoutRecovery,
  markRun,
  releaseRunCapacity,
  saveCheckpoint,
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
  deferWorkItem,
  getTaskMergeSettings,
  getTaskLinearRead,
  keepTaskLinearRead,
  linearActivitiesListedAt,
  markLinearActivitiesListed,
  keepTaskMergeSettings,
  type TaskMergeSettings,
  joinMergeQueue,
  leaveMergeQueue,
  markMergeQueueNotified,
  mergeQueuePosition,
  delegatedLinearUserId,
} from "../db";
import {
  publishAccepted,
  closeStoppedPull,
  fetchUpstreamMain,
  githubQueueLine,
  githubQueueMerge,
  mergedPullHeads,
  readPullReview,
  serialMerge,
  UPSTREAM_MAIN_REF,
  type GitHubClient,
  type GitHubTokenProvider,
} from "../github";
import { intakeDelegatedIssue, readyItems, stopAdoptedParent, type IntakeResult } from "../intake";
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
  linearCaller,
  linearItem,
  isMergeConflictRequest,
  parseLinearSessionContext,
  renderLinearSessionContext,
} from "../linear";
import {
  answerQuestion,
  elicitationBody,
  findOpenQuestion,
  handoffNote,
  acceptedVisualReviews,
  getVisualReview,
  markVisualReviewStale,
  openQuestion,
  questionReplyConsumed,
  visualReviewStaleHandoff,
  VISUAL_REVIEW_ANSWERERS,
  VISUAL_REVIEW_DESCRIBE,
  VISUAL_REVIEW_WAIT,
  type StoredQuestion,
  type StoredVisualReview,
} from "../questions";
import {
  answerVisualReview,
  askForVisualReview,
  postNote,
  remindVisualReview,
  visualReviewApprovals,
  visualReviewHandoff,
} from "./visual-review";
import {
  ciWaitVerification,
  acceptCloseout,
  applyCloseoutAcceptance,
  githubQueueWatch,
  parkMergeForCi,
  retryMergeLater,
  waitForMergeTurn,
  type GitHubQueueWatch,
  type MergeWaitReason,
  type VerificationOwner,
} from "./merge-jobs";
import {
  createAcpActivityReporter,
  FIRST_ACTIVITY_MS,
  KEEPALIVE_MS,
  publicToolText,
} from "./activity";
import { parseRecoveryAnswer, recoveryOptions, recoveryQuestion } from "./closeout-recovery";
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
import { createLinearInputLoader } from "./input-files";
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
import { ciFixHandoff, ciFixQuestion, ciFixRoundLine } from "./ci-fix";
import { createRepositoryGit } from "./repository-git";
import { GitHubAuthQuestions, type HostGitHubAuth } from "./github-auth";
import {
  interpretRepositoryAnswer,
  chooseRepository,
  hintedRepository,
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
  githubAuth?: HostGitHubAuth;
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
  canDispatchDelegation?: (delegationId: string) => boolean;
  canAdvanceItem?: (itemId: string) => boolean;
  dispatchReady?: (input: { legacyReadyItemIds: readonly string[] }) => void;
  clock?: Clock;
  /** Comment mode posts on the Linear issue. Agent-session mode keeps the session id. */
  channel?: "comments" | "agent-session";
  caps?: { maxTurns: number; maxAwakeMs: number };
  retryBaseMs?: number;
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

/**
 * A merge pass that waits. `queued` waits in the merge queue or for a review, with no deadline.
 * `githubQueue` is set while the task waits on GitHub's merge queue.
 */
type MergeWait = {
  message: string;
  base?: string;
  head?: string;
  summary?: string;
  queued?: boolean;
  reason: MergeWaitReason;
  /** Set while the task uses GitHub's merge queue. */
  githubQueue?: GitHubQueueWatch;
};

/** Rebase conflicts keep a fixed limit. CI failures use the `[merge] ci_fix_attempts` setting. */
const MAX_REBASE_RETURNS = 3;
const LINEAR_ACCESS_CHANGED: IntakeDecision = {
  outcome: "refused",
  reason: "Access to this session changed while Paws waited to start it.",
};
/** The first line of a CI fix handoff under the GitHub merge queue order. */
const CI_FIX_SOURCE = {
  pull: "The pull request's own checks failed before Paws could add it to the GitHub merge queue.",
  queue:
    "GitHub's merge queue removed the pull request because a check failed on the combined commit it tested with the pull requests ahead of it. Main may have changed since this branch was made.",
};
export const REBASE_CONFLICT_INSTRUCTION =
  "The pull request no longer rebases cleanly onto main. Paws already fetched main into origin/main in your checkout. Rebase this branch onto origin/main without fetching again and without a merge commit, resolve every conflict so the change still does what the issue asks, and run the checks again.";
const REBASE_CONFLICT_THOUGHT =
  "Main moved and the branch conflicts. Sent it back to the agent to rebase.";

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
  private readonly askedRuns = new Set<string>();
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
  private readonly conversations = new Map<
    string,
    (options: RunAgentOptions) => Promise<RunAgentResult>
  >();
  private readonly jobContexts = new Map<string, JobContext>();
  private shuttingDown = false;
  private activitySeq = 0;
  private readonly activityRequests = new Map<number, AbortSignal>();
  private readonly updates = createUpdateLimiter(() => this.now());
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
      (!findOpenQuestion(this.db, event.sessionId) ||
        this.hasPublishedPullRequest(event.sessionId)) &&
      this.options.channel !== "comments"
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
    if (created) throw new LinearIntakeRefusedError(decision.reason);
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
      const linearPrompt = this.options.channel !== "comments" && event.sessionId;
      if (linearPrompt && event.sessionId && event.body) {
        const session = recordLinearSessionEvent(this.db, event, this.now());
        if (questionItem && session && !workItemForSession(this.db, event.sessionId)) {
          bindLinearSessionTask(this.db, event.sessionId, questionItem.delegationId);
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
      this.options.channel !== "comments"
        ? recordLinearSessionEvent(this.db, event, this.now())
        : null;
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
    const progressTracker =
      sessionId && this.options.channel !== "comments"
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
    const authorizeSnapshot = (snapshot: EpicSnapshot) => {
      if (sessionId && this.options.authorizeLinearIntake?.(sessionId, snapshot) === false)
        throw new Error("The Linear assignment changed before intake.");
      authorizedSnapshot = snapshot;
      return sessionId
        ? (this.options.linearIntakeScope?.(sessionId, snapshot) ?? snapshot)
        : snapshot;
    };
    let intakeTracker = {
      ...progressTracker,
      loadEpic: async (id: string) => authorizeSnapshot(await progressTracker.loadEpic(id)),
    };
    const deferred = !savedRequest && this.options.remoteExecution?.slotFree?.() === false;
    const snapshot =
      this.options.linearTaskModes &&
      sessionId &&
      taskKey &&
      this.options.channel !== "comments" &&
      !deferred
        ? authorizeSnapshot(await tracker.loadEpic(issueId))
        : null;
    if (snapshot) intakeTracker = { ...progressTracker, loadEpic: async () => snapshot };
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
      reconcileSessions:
        sessionId && this.options.channel !== "comments"
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
            (item) => !["completed", "merged", "cancelled"].includes(item.state),
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
    return item ? linearItem(item.linearIdentifier, run, item.id) : run();
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
    jobs.register(JOB_KIND.start, (job, context) =>
      this.runLeasedJob(job.payload, context, () => this.executeRetried(job, context)),
    );
    jobs.register(JOB_KIND.resume, (job, context) =>
      this.runLeasedJob(job.payload, context, () => this.executeRetried(job, context)),
    );
    jobs.register(JOB_KIND.reverify, (job, context) =>
      this.failOnLastAttempt(job, context, "reverify", () =>
        this.runLeasedJob(job.payload, context, () =>
          this.runOwnedJob(job.payload, () => this.reverify(job.payload, job.id)),
        ),
      ),
    );
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
      if (
        parkMergeForCi(
          this.db,
          job,
          this.now(),
          { base: waiting.base, head: waiting.head, summary: waiting.summary },
          {
            queued: waiting.queued === true,
            reason: waiting.reason,
            message: waiting.message,
            ...(waiting.githubQueue ? { githubQueue: waiting.githubQueue } : {}),
          },
        ) !== "expired"
      )
        return;
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
            onWait(await this.merge(job.payload, job.id));
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
      this.options.channel !== "comments" &&
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
    if (
      loaded.state === "queued" &&
      (this.options.canDispatchDelegation?.(loaded.delegationId) === false ||
        !this.blockersClear(loaded))
    )
      return;
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
      if (this.options.linearTaskModes && item.sessionKey && this.options.channel !== "comments") {
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
      closeActiveRun(this.db, runId, this.now());
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
      this.pump();
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
      this.post(item, "action", `Working on ${item.linearIdentifier}.`, `${run.id}:working`, {
        ephemeral: true,
      });
      sessionProgress?.phase("implementing");
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
    if (await this.visualReviewOutdated(current, worktree, head)) return;
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
    await this.askCloseoutHelp(after, verdict.result, verdict.summary);
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
          if (deps.signal?.aborted || verdict.outcome === "accepted") return;
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
        const result = await runner!({ ...options, ...this.closeoutPolicy(item, options) });
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
        if (deps.signal?.aborted) throw error;
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
    const pending: RunnerWaitQuestion = { answer: new Promise<string>(() => {}), cancel() {} };
    const sessionId = this.activitySession(item);
    if (sessionId === null) return pending;
    const minutes = Math.round((this.options.runnerWait?.askAfterMs ?? 30 * 60_000) / 60_000);
    const body = `Runner ${runnerName} has been unavailable for ${minutes} minutes, so Closeout for ${item.linearIdentifier} has not started. Move the task to another runner, or keep waiting?`;
    const options = [MOVE_TO_ANOTHER_RUNNER, KEEP_WAITING];
    const opened = immediate(this.db, () => {
      const open = findOpenQuestion(this.db, sessionId);
      // A wait question from before a restart has nobody waiting for its answer.
      if (
        open !== null &&
        open.itemId === item.id &&
        !this.waiters.has(open.id) &&
        JSON.stringify(open.options) === JSON.stringify(options)
      )
        this.db.run("UPDATE question SET cancelled_at=? WHERE id=?", [this.now(), open.id]);
      else if (open !== null) return null;
      const stored = openQuestion(this.db, {
        itemId: item.id,
        runId,
        sessionId,
        body,
        options,
        now: this.now(),
      });
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "elicitation",
        orderingKey: sessionId,
        idempotencyKey: `runner-wait:${stored.id}`,
        payload: {
          id: stored.id,
          sessionId,
          questionId: stored.id,
          body: elicitationBody(body, reason),
          options,
        },
        now: this.now(),
      });
      return stored;
    });
    if (opened === null) return pending;
    const answer = new Promise<string>((resolve) => this.waiters.set(opened.id, resolve));
    void this.flush().catch(() => {});
    return {
      answer,
      cancel: () => {
        this.waiters.delete(opened.id);
        this.db.run(
          "UPDATE question SET cancelled_at=? WHERE id=? AND status='open' AND cancelled_at IS NULL",
          [this.now(), opened.id],
        );
      },
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

  private async merge(payload: unknown, jobId: number): Promise<MergeWait | undefined> {
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
      if (completeMergedItem(this.db, { itemId: item.id, now: this.now() })) this.pump();
      return;
    }
    this.assertReconciled(item);
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
    immediate(this.db, () => {
      if (
        this.workspaceForDelegation(item.delegationId)
          ? this.options.canAdvanceItem?.(item.id) !== true
          : !this.blockersClear(item)
      )
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
    let publicationCandidate =
      item.checkpoint?.wipCommit && item.checkpoint.baseSha
        ? { sha: item.checkpoint.wipCommit, baseSha: item.checkpoint.baseSha }
        : undefined;
    const priorVerification = ciWaitVerification(payload);
    if (priorVerification)
      publicationCandidate = { sha: priorVerification.head, baseSha: priorVerification.base };
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
      assert: async (purpose) => {
        const current = getWorkItem(this.db, item.id);
        if (!current) throw new Error("The published task no longer exists.");
        await this.assertPublicationReady(
          current,
          purpose === "merge" ? "merge" : "publish",
          live.controller.signal,
          publicationCandidate,
        );
        const fresh = (purpose === "pr" || purpose === "merge") && !freshReads.has(purpose);
        await this.taskAccess()?.assert(current, live.controller.signal, { fresh });
        if (fresh) freshReads.add(purpose);
        const auth = this.authorization(current);
        if (auth && !(await auth.ensure(current, "publication", live.controller.signal, { fresh })))
          throw new Error("GitHub sign-in is required before publication.");
      },
    });
    const candidate = await this.candidateForItem(item);
    if (!candidate) return;
    const worktree = worktreePath(this.options.pawsRoot, itemPathId(item));
    const summary = readString(payload, "summary") ?? "Closeout accepted.";
    const policy = await this.commitPolicy(item);
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
    const draft = getPullRequestDraft(this.db, item.id);
    const published = await publishAccepted({
      accepted: true,
      evidence: summary + (policy ? `\n\n${policyPullRequestCredit(policy)}` : ""),
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
      publicationCandidate,
    );
    if (this.stopped(item.id)) return;
    if (getWorkItem(this.db, item.id)?.state === "awaiting_input") return;
    if (!published.published) {
      this.fail(item, "publish", published.reason);
      return;
    }
    this.post(
      item,
      this.options.channel === "comments" ? "thought" : "response",
      `Opened ${published.pull.url ?? `pull request #${published.pull.number}`}. CI checks and merging will continue in the background. Reply here to request changes.`,
      `pull-request-ready:${item.id}:${item.sessionKey ? getLinearSessionGeneration(this.db, item.sessionKey) : 0}`,
      {},
      "ordered",
    );
    const sessionProgress = this.sessionProgress(item);
    if (published.pull.url) sessionProgress?.link("Pull request", published.pull.url);
    sessionProgress?.phase("merging");
    await this.flush(live.controller.signal);
    let closeoutFailure: CloseoutVerdict | null = null;
    let verifying = item;
    const acceptedHead = readString(payload, "head") ?? item.checkpoint?.wipCommit ?? null;
    const mergeSettings = await this.mergeSettingsFor(item, live.controller.signal);
    if (mergeSettings.order === "github-queue") {
      const handed = await this.mergeThroughGitHubQueue({
        item,
        payload,
        repository,
        github,
        pull: published.pull,
        head: published.head,
        signal: live.controller.signal,
      });
      if (handed !== "no_queue") return handed;
    }
    // Overlap-only updates (PAS-394) wait for CI like `ci` until they land.
    const closeoutAfterUpdate = mergeSettings.mainMoved === "closeout";
    // Under "Add to the GitHub merge queue", a base branch without one merges each on its own.
    const queued = mergeSettings.order === "queue";
    if (queued) {
      const wait = await this.mergeQueueTurn(item, repository, github, {
        number: published.pull.number,
        head: priorVerification?.head ?? acceptedHead ?? "",
      });
      if (wait) return wait;
      if (this.stopped(item.id)) return;
    }
    const merged = await serialMerge({
      worktree,
      issue: item.linearIdentifier,
      branchKey: taskBranchKey(item),
      owner: repository.owner,
      repo: repository.repo,
      prNumber: published.pull.number,
      commitTitle: `${draft?.title ?? item.title} (#${published.pull.number})`,
      commitMessage: policy ? commitPolicyMessage(summary, policy) : undefined,
      commitEnv: policy ? commitIdentityEnv(appBotCommitIdentity(policy.bot)) : undefined,
      appId: github.appId,
      installationId: github.installationId,
      privateKeyPem: github.privateKeyPem,
      client: github.client,
      gitExec: github.gitExec,
      ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
      remoteUrl: repository.remoteUrl,
      isCancelled: () => this.stopped(item.id) || !artifactPublicationReady(this.db, item.id),
      releaseWhilePending: true,
      ...(priorVerification === undefined ? {} : { priorVerification }),
      onWait: async (message) => {
        this.post(item, "thought", message, `${item.id}:merge-wait:${message}`);
        await this.flush();
      },
      reverify: async (input) => {
        const updated = acceptedHead !== null && input.head !== acceptedHead;
        if (updated && !closeoutAfterUpdate) {
          publicationCandidate = { sha: input.head, baseSha: input.base };
          this.postBranchUpdate(item, input.head, branchUpdatedMessage(input.base));
          await this.flush();
          const filesReady = artifactPublicationReady(this.db, item.id);
          return {
            accepted: filesReady,
            outcome: filesReady ? "merged" : "blocked",
            summary: filesReady ? summary : "A requested artifact has not been uploaded.",
          };
        }
        if (updated)
          this.postBranchUpdate(item, input.head, "Branch updated, running Closeout again.");
        await this.startCloseoutRound(verifying, input.head);
        const verdict = await this.runVerification(
          verifying,
          input.worktree,
          input.base,
          input.head,
          candidate,
        );
        if (verdict.decision === "accepted" && !verdict.exhausted)
          applyCloseoutAcceptance(this.db, item.id, verdict.owner);
        verifying = getWorkItem(this.db, item.id) ?? verifying;
        if (verdict.decision === "accepted")
          publicationCandidate = { sha: input.head, baseSha: input.base };
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
    // The first task keeps its place while it waits for CI or runs Closeout again after main moved.
    // Any other outcome takes it out of the queue; after a fix it rejoins at the end.
    const unreadable =
      merged.outcome === "blocked" && merged.message?.startsWith("could not read") === true;
    if (
      queued &&
      !unreadable &&
      merged.outcome !== "waiting" &&
      !(
        closeoutAfterUpdate &&
        closeoutFailure === null &&
        (merged.outcome === "sha_moved" || merged.outcome === "rejected")
      )
    )
      leaveMergeQueue(this.db, item.id);
    if (merged.outcome === "waiting") {
      if (this.stopped(item.id)) return;
      return {
        message: merged.message ?? "Waiting for CI on the candidate commit.",
        reason: "ci",
        ...(merged.base === undefined ? {} : { base: merged.base }),
        ...(merged.head === undefined ? {} : { head: merged.head }),
        ...(merged.summary === undefined ? {} : { summary: merged.summary }),
      };
    }
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
      if (merged.merged) completeMergedItem(this.db, { itemId: item.id, now: this.now() });
      return;
    }
    if (!merged.merged)
      await this.assertPublicationReady(
        item,
        "merge",
        live.controller.signal,
        publicationCandidate,
      );
    if (!merged.merged && getWorkItem(this.db, item.id)?.state === "awaiting_input") return;
    if (!merged.merged) {
      if (unreadable) throw new Error(merged.message);
      if (closeoutFailure !== null) {
        const failure = closeoutFailure as CloseoutVerdict;
        await this.askCloseoutHelp(item, failure.result, failure.summary);
        return;
      }
      if (
        merged.outcome === "conflict" &&
        this.returnToAgent(
          item,
          "rebase-conflict",
          MAX_REBASE_RETURNS,
          REBASE_CONFLICT_INSTRUCTION,
          () => REBASE_CONFLICT_THOUGHT,
        )
      )
        return;
      if (merged.outcome === "ci_failed") {
        const checks = merged.failedChecks ?? [];
        // Read on every round, so a changed setting applies to the next round of a running task.
        const limit = this.ciFixAttempts();
        const round = (next: CiRound["next"]) =>
          this.recordCiRound(item, merged.head, merged.checks, next, limit);
        if (
          this.returnToAgent(item, "ci-failed", limit, ciFixHandoff(checks), (attempt) =>
            ciFixRoundLine(checks, attempt, limit),
          )
        ) {
          round("agent");
          return;
        }
        if (this.askCiHelp(item, ciFixQuestion(checks, limit, published.pull.url))) {
          round("asked");
          await this.flush();
          return;
        }
        round("failed");
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
        if (!closeoutAfterUpdate) {
          // Back to the CI wait: the next pass updates the branch onto main again.
          return {
            message: "Main moved again before the merge. Updating the branch and waiting for CI.",
            reason: "branch_update",
            ...(merged.base === undefined ? {} : { base: merged.base }),
            ...(merged.head === undefined ? {} : { head: merged.head }),
          };
        }
        applyWorkItemEvent(this.db, item.id, "main_moved");
        enqueueJobOnce(this.db, {
          queue: JOB_KIND.reverify,
          jobKey: `reverify:${item.id}:${merged.head ?? "again"}:merge:${jobId}`,
          payload: { itemId: item.id },
          now: this.now(),
        });
        return;
      }
      this.fail(
        item,
        "merge",
        merged.outcome === "conflict" &&
          this.agentReturns(item.id, "rebase-conflict") >= MAX_REBASE_RETURNS
          ? `The branch still conflicts with main after ${MAX_REBASE_RETURNS} attempts to resolve the conflict.`
          : (merged.message ?? merged.outcome),
      );
      return;
    }
    await this.completeMerge(item, repository);
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
    await removeWorktree({
      owner: repository.owner,
      repo: repository.repo,
      itemId: itemPathId(item),
      pawsRoot: this.options.pawsRoot,
    }).catch(() => undefined);
    this.pump();
    await this.flush();
  }

  /**
   * Settings → Merging: Merge queue. A task joins its repository's queue once it is approved or
   * needs no review, in the order tasks became ready. Only the first one moves. The others wait,
   * and Linear hears once each time the position changes. A missing or dismissed approval takes
   * the task out of the queue until it is approved again.
   */
  private async mergeQueueTurn(
    item: WorkItemRecord,
    repository: { owner: string; repo: string },
    github: GitHubBinding,
    pull: { number: number; head: string },
  ): Promise<MergeWait | undefined> {
    const prNumber = pull.number;
    const name = `${repository.owner}/${repository.repo}`;
    const review = await readPullReview({
      client: github.client,
      owner: repository.owner,
      repo: repository.repo,
      prNumber,
      ...this.gitHubCredentials(github),
    });
    if (this.stopped(item.id)) return undefined;
    if (review === "unreadable" && mergeQueuePosition(this.db, item.id) === null)
      return {
        message: "Could not read the pull request's reviews.",
        queued: true,
        reason: "review",
      };
    if (review === "required" || review === "changes_requested") {
      leaveMergeQueue(this.db, item.id);
      const body =
        review === "required"
          ? `Waiting for an approving review on pull request #${prNumber}. It joins the ${name} merge queue once approved.`
          : `Changes were requested on pull request #${prNumber}. It joins the ${name} merge queue once approved.`;
      this.postAfterPullRequest(item, body, `${item.id}:merge-review:${review}:${pull.head}`);
      return { message: body, queued: true, reason: "review" };
    }
    joinMergeQueue(this.db, { itemId: item.id, repository: name, now: this.now() });
    const place = mergeQueuePosition(this.db, item.id);
    if (place === null) return undefined;
    if (
      place.notifiedPosition !== place.position &&
      (place.position > 1 || place.notifiedPosition !== null)
    ) {
      const ahead = place.aheadItemId ? getWorkItem(this.db, place.aheadItemId) : null;
      const line = mergeQueueLine(place);
      const body =
        place.position === 1
          ? `${line}. Merging next.`
          : `${line}. ${ahead?.linearIdentifier ?? "The task ahead"} merges first.`;
      this.statusAfterPullRequest(
        item,
        body,
        `${item.id}:merge-queue:${place.readyAt}:${place.position}`,
      );
      markMergeQueueNotified(this.db, item.id, place.position);
    }
    if (place.position === 1) return undefined;
    const ahead = place.aheadItemId ? getWorkItem(this.db, place.aheadItemId) : null;
    return {
      message: `${mergeQueueLine(place)}. ${ahead?.linearIdentifier ?? "The task ahead"} merges first.`,
      queued: true,
      reason: "ahead",
    };
  }

  /**
   * Settings → Merging "Add to the GitHub merge queue". Paws neither rebases nor runs Closeout
   * again: GitHub tests the combined result. Once the pull request's own checks pass, Paws
   * queues it and reads the entry on each pass. A failing check or a conflict goes back to the
   * agent like CI does today, and a fixed head is queued again after Closeout accepts it. Any
   * other removal, such as a person dequeuing it, asks in Linear. `no_queue` means the base branch
   * has no merge queue, and Paws merges the pull request itself.
   */
  private async mergeThroughGitHubQueue(input: {
    item: WorkItemRecord;
    payload: unknown;
    repository: RepositoryBinding;
    github: GitHubBinding;
    pull: { number: number; url: string | null };
    head: string;
    signal: AbortSignal;
  }): Promise<MergeWait | undefined | "no_queue"> {
    const { item, repository, github, pull } = input;
    const name = `${repository.owner}/${repository.repo}`;
    const watch = githubQueueWatch(input.payload) ?? { queued: false };
    const result = await githubQueueMerge({
      owner: repository.owner,
      repo: repository.repo,
      prNumber: pull.number,
      head: input.head,
      client: github.client,
      appId: github.appId,
      installationId: github.installationId,
      privateKeyPem: github.privateKeyPem,
      ...(github.tokenProvider ? { tokenProvider: github.tokenProvider } : {}),
      queued: watch.queued,
      isCancelled: () => this.stopped(item.id) || !artifactPublicationReady(this.db, item.id),
      signal: input.signal,
    });
    if (this.stopped(item.id)) return;
    switch (result.outcome) {
      case "no_queue":
        this.statusAfterPullRequest(
          item,
          `${result.message} Paws merges the pull request itself when its CI is green.`,
          `${item.id}:github-queue:none:${input.head}`,
        );
        return "no_queue";
      case "checks_pending":
      case "unreadable":
        return { message: result.message, head: input.head, reason: "ci", githubQueue: watch };
      case "queued": {
        const line = githubQueueLine(name, result.position, result.state);
        if (!watch.queued)
          this.statusAfterPullRequest(
            item,
            `Added ${pull.url ?? `pull request #${pull.number}`} to the GitHub merge queue. ${line}`,
            `${item.id}:github-queue:added:${input.head}`,
          );
        else if (watch.position !== result.position || watch.state !== result.state)
          this.statusAfterPullRequest(
            item,
            line,
            `${item.id}:github-queue:${input.head}:${result.position}:${result.state}`,
          );
        await this.flush();
        return {
          message: line,
          head: input.head,
          reason: (result.position ?? 1) > 1 ? "ahead" : "ci",
          githubQueue: { queued: true, position: result.position, state: result.state, line },
        };
      }
      case "merged":
        recordConfirmedRemoteMerge(this.db, {
          itemId: item.id,
          repositoryOwner: repository.owner,
          repositoryName: repository.repo,
          pullNumber: pull.number,
          pullUrl: pull.url,
          mergeSha: result.sha,
          confirmedAt: this.now(),
        });
        await this.completeMerge(item, repository);
        return;
      case "ci_failed":
        return this.githubQueueCiFailed(item, result.failedChecks, pull.url, CI_FIX_SOURCE.pull);
      case "removed": {
        const { removal } = result;
        const why = removal.reason ? ` (${removal.reason})` : "";
        if (removal.cause === "failed")
          return this.githubQueueCiFailed(
            item,
            [{ name: removal.reason || "merge queue checks", url: pull.url }],
            pull.url,
            CI_FIX_SOURCE.queue,
          );
        if (removal.cause === "conflict") {
          if (
            (await this.fetchUpstreamMain(item).catch(() => false)) &&
            this.returnToAgent(
              item,
              "rebase-conflict",
              MAX_REBASE_RETURNS,
              REBASE_CONFLICT_INSTRUCTION,
              () =>
                `GitHub's merge queue removed the pull request for a conflict${why}. Sent it back to the agent to rebase.`,
            )
          )
            return;
          this.fail(
            item,
            "merge",
            `GitHub's merge queue removed the pull request for a conflict${why}.`,
          );
          return;
        }
        await this.askGitHubQueueRemoval(
          item,
          `${removal.actor ? `@${removal.actor}` : "Someone"} removed ${pull.url ?? `pull request #${pull.number}`} from the ${name} GitHub merge queue${why}.`,
        );
        return;
      }
      case "closed":
        await this.askGitHubQueueRemoval(
          item,
          `${pull.url ?? `Pull request #${pull.number}`} was closed on GitHub while it waited for the ${name} merge queue.`,
        );
        return;
      case "blocked":
      case "sha_moved":
        this.fail(item, "merge", result.message);
        return;
    }
  }

  /** A failing check sends the task back to the agent, at most `ci_fix_attempts` times, then asks. */
  private async githubQueueCiFailed(
    item: WorkItemRecord,
    checks: readonly { name: string; url: string | null }[],
    pullUrl: string | null,
    source: string,
  ): Promise<undefined> {
    const limit = this.ciFixAttempts();
    if (
      this.returnToAgent(
        item,
        "ci-failed",
        limit,
        `${source}\n\n${ciFixHandoff(checks)}`,
        (attempt) => ciFixRoundLine(checks, attempt, limit),
      )
    )
      return;
    if (this.askCiHelp(item, ciFixQuestion(checks, limit, pullUrl))) {
      await this.flush();
      return;
    }
    this.fail(item, "merge", `CI failed: ${checks.map((check) => check.name).join(", ")}`);
    return;
  }

  /** The pull request left GitHub's merge queue for a reason Paws should not decide alone. */
  private async askGitHubQueueRemoval(item: WorkItemRecord, what: string): Promise<void> {
    const body = [
      what,
      "",
      "What should Paws do? Reply with what to change, and the agent works on it. Paws adds the pull request to the merge queue again after Closeout accepts the change. To leave it as it is, stop the task.",
    ].join("\n");
    if (this.askCiHelp(item, body)) {
      await this.flush();
      return;
    }
    this.fail(item, "merge", what);
  }

  private postBranchUpdate(item: WorkItemRecord, head: string, body: string): void {
    this.statusAfterPullRequest(item, body, `${item.id}:branch-updated:${head}`);
  }

  private statusAfterPullRequest(item: WorkItemRecord, body: string, key: string): void {
    if (this.options.channel === "comments") {
      this.post(item, "thought", body, key);
      return;
    }
    if (!(this.jobContexts.get(item.id)?.isCurrent() ?? true)) return;
    if (getWorkItem(this.db, item.id)?.state === "cancelled") return;
    this.sessionProgress(item)?.status(body);
    void this.flush().catch(() => {});
  }

  /** Progress is quiet once the pull request is open, so this posts like the pull request note. */
  private postAfterPullRequest(item: WorkItemRecord, body: string, key: string): void {
    this.post(
      item,
      this.options.channel === "comments" ? "thought" : "response",
      body,
      key,
      {},
      "ordered",
    );
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

  /** `[merge] ci_fix_attempts`, read for every CI round. Missing means 3. */
  private ciFixAttempts(): number {
    return readMergeSettings(loadConfigFile(join(this.options.pawsRoot, "config.toml")))
      .ciFixAttempts;
  }

  /** CI fix attempts are spent: ask in the Linear session. A reply resumes the agent once more. */
  private askCiHelp(item: WorkItemRecord, body: string): boolean {
    return immediate(this.db, () => {
      const current = getWorkItem(this.db, item.id);
      if (!current || current.state !== "merge_queue" || current.cancelRequested) return false;
      const sessionId = this.activitySession(current);
      if (sessionId === null || findOpenQuestion(this.db, sessionId) !== null) return false;
      const question = openQuestion(this.db, {
        itemId: current.id,
        runId: current.currentRunId,
        sessionId,
        body,
        now: this.now(),
      });
      applyWorkItemEvent(this.db, current.id, "blocking_question");
      if (current.checkpoint)
        saveCheckpoint(this.db, current.id, { ...current.checkpoint, phase: "awaiting_input" });
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "elicitation",
        orderingKey: sessionId,
        idempotencyKey: `ci-help:${question.id}`,
        payload: { sessionId, questionId: question.id, body },
        now: this.now(),
      });
      return true;
    });
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

  private returnToAgent(
    item: WorkItemRecord,
    reason: "rebase-conflict" | "ci-failed",
    limit: number,
    handoff: string,
    thought: (attempt: number) => string,
  ): boolean {
    return immediate(this.db, () => {
      const current = getWorkItem(this.db, item.id);
      if (!current || current.state !== "merge_queue" || current.cancelRequested) return false;
      const returns = this.agentReturns(current.id, reason);
      if (returns >= limit) return false;
      const round = `${this.latestUserTurn(current.id)}:${returns}`;
      const running = applyWorkItemEvent(this.db, current.id, "ejected");
      if (current.checkpoint)
        saveCheckpoint(this.db, current.id, { ...current.checkpoint, phase: "running" });
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.resume,
        jobKey: `${reason}:${current.id}:${round}`,
        payload: { itemId: current.id, handoff, reason },
        now: this.now(),
      });
      const key = `${current.id}:${reason}:${round}`;
      if (reason === "ci-failed") this.statusAfterPullRequest(running, thought(returns + 1), key);
      else this.post(running, "thought", thought(returns + 1), key);
      return true;
    });
  }

  /** The checks of a failed CI read and what Paws did next, for the run page. */
  private recordCiRound(
    item: WorkItemRecord,
    head: string | undefined,
    checks: readonly CiRoundCheck[] | undefined,
    next: CiRound["next"],
    limit: number,
  ): void {
    if (!head) return;
    recordCiRound(this.db, {
      itemId: item.id,
      head,
      runId: getWorkItem(this.db, item.id)?.currentRunId ?? item.currentRunId,
      next,
      fix: next === "agent" ? this.agentReturns(item.id, "ci-failed") : null,
      fixLimit: limit,
      checks: [...(checks ?? [])],
      recordedAt: this.now(),
    });
  }

  private agentReturns(itemId: string, reason: string): number {
    const row = this.db
      .query<{ n: number }, [string, string, string, number]>(
        `SELECT COUNT(*) AS n FROM job
         WHERE queue = ? AND json_extract(payload, '$.itemId') = ?
           AND json_extract(payload, '$.reason') = ? AND id >= ?`,
      )
      .get(JOB_KIND.resume, itemId, reason, this.latestUserTurn(itemId));
    return Number(row?.n ?? 0);
  }

  private latestUserTurn(itemId: string): number {
    const row = this.db
      .query<{ id: number | null }, [string, string]>(
        `SELECT MAX(id) AS id FROM job
         WHERE queue = ? AND json_extract(payload, '$.itemId') = ?
           AND job_key LIKE 'linear-turn:%'`,
      )
      .get(JOB_KIND.resume, itemId);
    return Number(row?.id ?? 0);
  }

  private askHook(item: WorkItemRecord, runId: string): AskTeamHook {
    return {
      ask: async (request, context) => {
        const sessionId = this.activitySession(item);
        if (sessionId === null) {
          throw new Error("ask_team has no Linear session");
        }
        if (context.signal.aborted) throw new Error("cancelled");
        const options = request.options ?? [];
        immediate(this.db, () => {
          const opened = openQuestion(this.db, {
            itemId: item.id,
            runId,
            sessionId,
            body: [request.question.trim(), request.context?.trim()].filter(Boolean).join("\n\n"),
            options,
            now: this.now(),
          });
          const suggestions = suggestDecisions(this.db, opened.id, opened.body);
          const decisionContext = suggestions
            .map(
              (decision) =>
                `Saved decision: ${decision.statement}\nSource: ${decision.sourceUrl}\nConfirm: ${decision.value}`,
            )
            .join("\n\n");
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
              body: elicitationBody(
                request.question,
                [request.context, decisionContext].filter(Boolean).join("\n\n"),
              ),
              options: [
                ...options,
                ...suggestions.map((decision) => ({
                  label: `Use saved decision: ${decision.statement.slice(0, 80)}`,
                  value: decision.value,
                })),
              ],
            },
            now: this.now(),
          });
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
    const review = getVisualReview(this.db, open.id);
    if (review) {
      const item = getWorkItem(this.db, open.itemId);
      if (item === null) return "rejected";
      if (!(await this.canAnswerVisualReview(item, answeredBy))) {
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
    if (this.githubAuth?.owns(open.id)) {
      const accepted = await this.githubAuth.retry(open.id, answeredBy, () => {
        if (getWorkItem(this.db, open.itemId)?.sessionKey === sessionId)
          applyLinearTurns(this.db, sessionId, [event.dedupeKey], open.itemId);
      });
      await this.flush();
      return accepted ? "answered" : "rejected";
    }
    const runnerWaiter = recovery ? undefined : this.waiters.get(open.id);
    if (runnerWaiter) {
      const accepted = immediate(this.db, () => {
        if (
          answerQuestion(this.db, open.id, {
            answer,
            answeredBy,
            eventKey: event.dedupeKey,
            now: this.now(),
          }) === null
        )
          return false;
        if (getWorkItem(this.db, open.itemId)?.sessionKey === sessionId)
          applyLinearTurns(this.db, sessionId, [event.dedupeKey], open.itemId);
        return true;
      });
      if (!accepted) return "rejected";
      this.waiters.delete(open.id);
      runnerWaiter(answer);
      await this.flush();
      return "answered";
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
        if (item.sessionKey === sessionId)
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
      if (getWorkItem(this.db, open.itemId)?.sessionKey === sessionId)
        applyLinearTurns(this.db, sessionId, [event.dedupeKey], open.itemId);
      if (this.waiters.has(open.id) || (open.runId !== null && this.askedRuns.has(open.runId)))
        return "answered" as const;
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
    this.taskAccess()?.invalidate({ sessionId });
    this.githubAuth?.invalidate({ sessionId });
    const requestedAt = at > 0 ? at : this.now();
    const agentSession = this.options.channel !== "comments";
    const commands: LinearCommand[] = [];
    const accepted = immediate(this.db, () => {
      if (agentSession && acceptLinearStop(this.db, sessionId, eventKey, requestedAt) === null)
        return false;
      const items = this.itemsForSession(sessionId);
      if (items.length === 0 && agentSession) stopAdoptedParent(this.db, sessionId, requestedAt);
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

  private assertReconciled(item: WorkItemRecord): void {
    if (this.options.canDispatchDelegation?.(item.delegationId) === false)
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
        if (["merged", "completed", "cancelled"].includes(item.state)) continue;
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
        this.db.run(
          "UPDATE question SET cancelled_at=? WHERE item_id=? AND status='open' AND cancelled_at IS NULL",
          [this.now(), itemId],
        );

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
            "UPDATE work_item SET cancel_requested=0,awake_ms=0,last_mono_ms=NULL,turn_count=0,recovery_attempts=0 WHERE id=?",
            [itemId],
          );
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
    this.pump();
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

  private pump(): void {
    this.yieldIdleMergeSessions();
    const items = this.allItems();
    const delegationIds = new Set(
      this.db
        .query<{ id: string }, []>(
          `SELECT DISTINCT delegation_id AS id FROM work_item WHERE ${delegationHasOpenWork("work_item.delegation_id")}`,
        )
        .all()
        .map((row) => row.id),
    );
    for (const delegationId of delegationIds) this.questionDependencyCycle(delegationId);
    const queued = items.filter((item) => item.state === "queued" && !item.cancelRequested);
    queued.sort((left, right) => left.position - right.position || left.id.localeCompare(right.id));
    const ready = queued.filter(
      (item) =>
        this.options.canDispatchDelegation?.(item.delegationId) !== false &&
        this.blockersClear(item),
    );
    if (this.options.dispatchReady) {
      this.options.dispatchReady({ legacyReadyItemIds: ready.map((item) => item.id) });
      this.noteQueued(ready);
      return;
    }
    if (listInFlightItems(this.db).length > 0) return;
    const item = ready[0];
    if (!item) return;
    immediate(this.db, () => {
      if (
        this.db
          .query(
            "SELECT 1 FROM job WHERE queue=? AND status IN ('pending','running') AND json_extract(payload,'$.itemId')=? LIMIT 1",
          )
          .get(JOB_KIND.start, item.id)
      )
        return;
      enqueueJob(this.db, {
        queue: JOB_KIND.start,
        jobKey: `start:${item.id}:${item.version}:${crypto.randomUUID()}`,
        payload: { itemId: item.id, handoff: this.dependencyHandoff(item.id) },
        now: this.now(),
      });
    });
  }

  private noteQueued(ready: readonly WorkItemRecord[]): void {
    const now = this.now();
    const hours = this.queueStartTimeoutHours();
    for (const { id } of ready) {
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

  private yieldIdleMergeSessions(): void {
    immediate(this.db, () => {
      for (const item of this.allItems()) {
        if (
          item.state !== "merge_queue" ||
          this.options.canDispatchDelegation?.(item.delegationId) === false ||
          [...this.live.values()].some((live) => live.itemId === item.id) ||
          !this.delegationItems(item.delegationId).some(
            (other) =>
              other.id !== item.id && other.state === "queued" && this.blockersClear(other),
          )
        )
          continue;
        this.db.run(
          `UPDATE linear_session SET active_item_id=NULL WHERE active_item_id=?
           AND NOT EXISTS(SELECT 1 FROM run WHERE item_id=? AND status IN ('active','provisioning'))
           AND NOT EXISTS(SELECT 1 FROM job WHERE status='running' AND (locked_until IS NULL OR locked_until>?)
             AND json_extract(payload,'$.itemId')=?
             AND (queue IN ('item.start','run.resume','run.reverify','github.merge')
               OR queue LIKE 'github.merge.%' OR lane='merge'))`,
          [item.id, item.id, this.now(), item.id],
        );
      }
    });
  }

  private questionDependencyCycle(delegationId: string): void {
    const workspace = this.workspaceForDelegation(delegationId);
    if (!workspace || this.options.canDispatchDelegation?.(delegationId) === false) return;
    const ids: string[] = [];
    try {
      for (const item of this.delegationItems(delegationId))
        ids.push(
          ...readyItems(this.db, { itemId: item.id, workspaceId: workspace }).cycleHeldItemIds,
        );
    } catch {
      return;
    }
    if (!ids.length) return;
    const items = ids
      .map((id) => getWorkItem(this.db, id))
      .filter((item): item is WorkItemRecord => item !== null);
    const session = this.delegationSession(items);
    if (!session) return;
    const digest = createHash("sha256")
      .update(JSON.stringify([...ids].sort()))
      .digest("hex");
    const key = `dependency-cycle:${delegationId}:${digest}`;
    if (this.db.query("SELECT 1 FROM outbox WHERE idempotency_key=?").get(key)) return;
    immediate(this.db, () => {
      const body = `Linear dependencies contain a cycle. Update the dependencies in Linear to release this work: ${items.map((item) => item.linearIdentifier).join(", ")}. Unaffected work can continue.`;
      enqueueOutboxOnce(this.db, {
        target: "linear",
        op: "activity",
        orderingKey: session,
        idempotencyKey: key,
        payload: { sessionId: session, kind: "thought", body },
        now: this.now(),
      });
    });
  }

  private workspaceForDelegation(delegationId: string): string | null {
    return (
      this.db
        .query<{ id: string }, [string]>(
          `SELECT w.id FROM workspace w JOIN linear_session s ON s.organization_id=w.linear_organization_id JOIN work_item i ON i.session_key=s.session_id WHERE i.delegation_id=? LIMIT 1`,
        )
        .get(delegationId)?.id ?? null
    );
  }

  private blockersClear(item: WorkItemRecord): boolean {
    if (item.cancelRequested) return false;
    const workspace = this.workspaceForDelegation(item.delegationId);
    if (workspace) {
      try {
        return readyItems(this.db, {
          itemId: item.id,
          workspaceId: workspace,
        }).readyItemIds.includes(item.id);
      } catch {
        return false;
      }
    }
    const rows = this.db
      .query<{ blocker_linear_issue_id: string }, [string, string]>(
        `SELECT blocker_linear_issue_id FROM task_block
         WHERE blocked_linear_issue_id = ?
         AND EXISTS (
           SELECT 1 FROM work_item
           WHERE delegation_id = ? AND linear_issue_id = task_block.blocker_linear_issue_id
         )`,
      )
      .all(item.linearIssueId, item.delegationId);
    const active = new Map(
      this.delegationItems(item.delegationId).map((entry) => [entry.linearIssueId, entry]),
    );
    for (const row of rows) {
      const blocker = active.get(row.blocker_linear_issue_id);
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
    this.pump();
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
    if (this.options.channel === "comments" || !this.tracker?.updateSession) return null;
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
    delivery?: "critical" | "ordered",
  ): void {
    if (!(this.jobContexts.get(item.id)?.isCurrent() ?? true)) return;
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
      (findOpenQuestion(this.db, sessionId) === null &&
        (this.options.channel === "comments" || !this.hasPublishedPullRequest(sessionId)))
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
    if (this.options.channel === "comments") {
      for (const item of items) configureWorkItem(this.db, item.id, { sessionKey: sessionId });
      return;
    }
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
    return this.options.linearTaskModes && this.options.channel !== "comments"
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
          throw new Error("GitHub sign-in is required before reading the repository.");
      },
    });
  }

  private authorization(item: WorkItemRecord): GitHubAuthQuestions | null {
    return this.options.channel !== "comments" && item.sessionKey !== null ? this.githubAuth : null;
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
    const rebase =
      item.id === routed?.id &&
      this.hasOpenedPullRequest(item.id) &&
      turns.some((turn) => isMergeConflictRequest(turn.body)) &&
      this.agentReturns(item.id, "rebase-conflict") < MAX_REBASE_RETURNS &&
      (await this.fetchUpstreamMain(item));
    const handoff = turns.map((turn) => turn.body).join("\n\n");
    const jobKey = `linear-turn:${sessionId}:${getLinearSessionGeneration(this.db, sessionId)}`;
    immediate(this.db, () => {
      if (item!.cancelRequested || item!.state === "failed" || item!.state === "exhausted") {
        this.db.run(
          "UPDATE work_item SET cancel_requested = 0, awake_ms = 0, last_mono_ms = NULL, turn_count = 0, recovery_attempts = 0 WHERE id = ?",
          [item!.id],
        );
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
      enqueueJobOnce(this.db, {
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
    });
    await this.flush();
  }

  /** Fetch main into the item's worktree, as a merge pass does before a rebase-conflict return. */
  private async fetchUpstreamMain(item: WorkItemRecord): Promise<boolean> {
    const repository = this.repositoryForItem(item);
    const github = repository ? this.githubForRepository(repository) : null;
    const worktree = worktreePath(this.options.pawsRoot, itemPathId(item));
    if (!repository || !github || !existsSync(worktree)) return false;
    await fetchUpstreamMain({
      worktree,
      owner: repository.owner,
      repo: repository.repo,
      client: github.client,
      remoteUrl: repository.remoteUrl,
      ...this.gitHubCredentials(github),
    });
    return true;
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
    if (this.options.channel === "comments" || !sessionId) return;
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
    const publisher = createEvidenceArtifactPublisher({
      db: this.db,
      evidence: evidence.store,
      publicUrl: evidence.publicUrl,
      itemId: item.id,
      sessionId,
      uploads: Boolean(this.options.files && evidence.root),
      ...(linear ? { linear } : {}),
      now: () => this.now(),
    });
    return {
      ...publisher,
      publish: async (artifact, context) => {
        const published = await publisher.publish(artifact, context);
        if (!context.evidence) return published;
        const asked = await this.requestVisualReview(
          item,
          sessionId,
          context.runId,
          context.evidence.checkId,
          evidence.publicUrl,
        );
        return asked ? { ...published, note: VISUAL_REVIEW_WAIT } : published;
      },
    } satisfies PublishArtifactHook;
  }

  /**
   * Asks for a visual review once an `approval: human` check has its files. The run that
   * published them ends like one that asked the team: it keeps its work and frees its slot.
   */
  private async requestVisualReview(
    item: WorkItemRecord,
    sessionId: string,
    runId: string,
    checkId: string,
    publicUrl: string,
  ): Promise<boolean> {
    const repository = this.repositoryForItem(item);
    if (repository === null) return false;
    const required = visualReviewRequirements(
      worktreePath(this.options.pawsRoot, itemPathId(item)),
      this.options.home,
      this.options.closeoutPolicyRoot?.(repository),
    );
    const requirement = required.ok
      ? required.items.find((entry) => entry.id === checkId)
      : undefined;
    if (requirement === undefined) return false;
    const outcome = immediate(this.db, () =>
      askForVisualReview(this.db, {
        item,
        runId,
        sessionId,
        requirement,
        publicUrl,
        now: this.now(),
      }),
    );
    if (outcome === null) return false;
    this.askedRuns.add(runId);
    await this.flush();
    return true;
  }

  private async answerVisualReview(
    open: StoredQuestion,
    review: StoredVisualReview,
    eventKey: string,
    answer: string,
    answeredBy: string,
  ): Promise<"answered" | "rejected"> {
    const sessionId = open.sessionId;
    const outcome = immediate(this.db, () => {
      const result = answerVisualReview(this.db, {
        question: open,
        review,
        answer,
        answeredBy,
        eventKey,
        now: this.now(),
      });
      const item = getWorkItem(this.db, open.itemId);
      if (item === null || result === "rejected") return "rejected" as const;
      if (result === "describe") {
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
      if (item.sessionKey === sessionId) applyLinearTurns(this.db, sessionId, [eventKey], item.id);
      if (result === "asked" || (open.runId !== null && this.askedRuns.has(open.runId)))
        return "answered" as const;
      enqueueJobOnce(this.db, {
        queue: JOB_KIND.resume,
        jobKey: `resume:answer:${open.id}`,
        payload: {
          itemId: item.id,
          freshSession: true,
          handoff: visualReviewHandoff(this.db, open.id),
          reason: "visual-review",
        },
        now: this.now(),
      });
      return "answered" as const;
    });
    await this.flush();
    return outcome;
  }

  private async visualReviewOutdated(
    item: WorkItemRecord,
    worktree: string,
    head: string,
  ): Promise<boolean> {
    const reviews = acceptedVisualReviews(this.db, item.id);
    if (reviews.length === 0) return false;
    const repository = this.repositoryForItem(item);
    if (!repository) return false;
    const required = visualReviewRequirements(
      worktree,
      this.options.home,
      this.options.closeoutPolicyRoot?.(repository),
    );
    if (!required.ok) return false;
    const checks = new Set(required.items.map((entry) => entry.id));
    const approvals = visualReviewApprovals(this.db, item.id, itemPathId(item));
    const valid = new Set(await approvalsAtHead(worktree, head, approvals, required.items));
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
  private async canAnswerVisualReview(item: WorkItemRecord, actorId: string): Promise<boolean> {
    if (delegatedLinearUserId(this.db, item.id) === actorId) return true;
    const attribution = await this.tracker
      ?.getIssueAttribution?.(item.linearIssueId)
      .catch(() => null);
    return attribution?.leadId === actorId;
  }

  private prepareInputFiles(item: WorkItemRecord, turnId: string) {
    const loader = this.inputLoader;
    const sessionId = this.activitySession(item);
    if (!loader || !sessionId) return undefined;
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
      return backend({ ...input, commitPolicy: policy, ...this.closeoutPolicy(item, input) });
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
        return runner({ ...input, commitPolicy: policy, ...this.closeoutPolicy(item, input) });
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
    if (this.options.channel === "comments") return item.linearIssueId;
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

  private closeoutPolicy(
    item: WorkItemRecord,
    input: RunAgentOptions,
  ): Pick<RunAgentOptions, "closeoutPolicy"> {
    if (input.role !== "implementer" || input.prepareOnly || !this.repositoryForItem(item))
      return {};
    const { home, policyRoot } = this.closeoutHome(item);
    return {
      closeoutPolicy: async () => {
        const load = trustedPolicyFiles(input.worktreePath, home, policyRoot);
        return load.ok && !load.absent
          ? { ...load, published: publishedEvidence(this.db, item.id) }
          : load;
      },
    };
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

const LINEAR_RATE_LIMITED = /Linear GraphQL: RATELIMITED/;
const RATE_LIMIT_RETRY_MS = 5_000;
const OUTBOX_WAIT_MS = 30_000;
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

function branchUpdatedMessage(base: string): string {
  return `Branch updated onto main ${base.slice(0, 7)}, waiting for CI. Closeout does not run again, because "When main moved before the merge" for this task is set to wait for CI in Settings → Merging.`;
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
