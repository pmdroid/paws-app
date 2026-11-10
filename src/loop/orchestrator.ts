import {
  getTaskMergeSettingsSteps,
  getTaskLinearReadSteps,
  keepTaskLinearReadSteps,
  keepTaskMergeSettingsSteps,
  mergeCallInFlightSteps,
  saveCandidatePathsSteps,
  saveCandidateRiskSteps,
} from "../db";
import {
  bindWorkItemRepositorySteps,
  listRepositoryCandidates,
  reviewerFaultHolds,
  getWorkItemRepositoryAnswerSteps,
  getWorkItemRepositoryChoiceSteps,
  listRepositoryCandidatesSteps,
  listRepositoryCatalogSteps,
  rememberWorkItemRepositoryChoiceSteps,
} from "../db";
import {
  applyLinearTurnsSteps,
  clearConversationBlockSteps,
  deferWorkItemAsync,
  delegatedLinearUserIdSteps,
  deleteCancelledLinearTurnSteps,
  enqueueJobOnceAsync,
  enqueueOutboxOnceSteps,
  ensureLinearSessionSteps,
  gatherLinearCommentsAsync,
  getConversationSteps,
  getItemBranchStateSteps,
  getItemCandidateSteps,
  getItemRunCommitPolicySteps,
  getLinearSessionGenerationSteps,
  getPullRequestDraftSteps,
  getTaskClassificationSteps,
  hasLinearSessionSnapshotContextSteps,
  hasOpenItemJobSteps,
  issueOpenInOtherSessionSteps,
  itemDelegationIssueIdSteps,
  linearActivitiesListedAtSteps,
  linearOutboxKeyedSteps,
  listBlockedConversationsSteps,
  listLinearActivitySnapshotsSteps,
  listPendingLinearTurnsSteps,
  markJobAwakeWaitAsync,
  markLinearActivitiesListedSteps,
  pausedStoppedSessionItemSteps,
  recentRepositoryNamesSteps,
  recordAgentCloseoutSteps,
  restartAsync,
  reviewerAlertedSinceSteps,
  saveConversationSteps,
  saveLinearActivitySnapshotSteps,
  saveLinearSessionSnapshotContextSteps,
  savePullRequestDraftSteps,
  saveRunCommitPolicySteps,
} from "../db";
import { recoverStalledCloseout } from "./closeout-stall";
import { getItemPullRequestSteps, recordItemCandidateSteps } from "../db";
import { parkLeasedJobSteps } from "../db";
import {
  saveCheckpointSteps,
  recordReviewRoundsSteps,
  jobVersionCurrentSteps,
  refreshVerificationJobVersionSteps,
} from "../db";
import { failWorkItemSteps, runnerWorkHasResultSteps, releaseRunCapacitySteps } from "../db";
import {
  applyWorkItemEventSteps,
  cancelOpenJobsSteps,
  loseActiveItemRunsSteps,
  getRunSteps,
  markRunSteps,
  takeRunnerSetupResumeSteps,
  insertRunSteps,
  setCurrentRunSteps,
  claimRunSteps,
} from "../db";
import { dashboardUrl } from "../dashboard-links";
import { RiskDisplayReader, type RiskDisplay } from "./risk-display";
import { pullRequestReadyResponse } from "./pull-request-response";
import type { ItemRunnerVerdicts, RunnerHostRefusal } from "../db";
import {
  AFTER_PULL_REQUEST_RESPONSE,
  canReportProgress as canReportSessionProgress,
  hasPublishedPullRequest,
} from "./activity-policy";
import { reaskDeadQuestion } from "./dead-question";
import { createHash, randomUUID } from "node:crypto";
import { ask, restart, awaitQuestion } from "./operations";
import {
  RUNNER_REPOSITORY_REASON,
  RUNNER_REPOSITORY_RETRY,
  RUNNER_REPOSITORY_STOP,
  runnerRepositoryQuestion,
} from "./runner-repository";
import { acceptedResumeNeedsTurn, mergeAcceptedWork, settleRejectedPush } from "./accepted-work";
import { restartForPushConflict } from "./push-conflict";
import {
  saveHumanRetryWindow,
  fixRounds,
  restartLimit,
  type RestartHandoff,
  activateLinearItemSteps,
  bindLinearSessionTaskSteps,
  configureWorkItemSteps,
  discardLinearTurnsSteps,
  getLinearCommentSteps,
  getLinearSessionSteps,
  getTaskModeSteps,
  getWorkItemSteps,
  isWorkItemRepositoryQuestionSteps,
  recordLinearTurnSteps,
  saveLinearSessionContextSteps,
  settleLinearCommentsSteps,
  workItemForSessionSteps,
} from "../db";
import { journal, journalCaught } from "../journal";
import { rerunItemCi } from "./ci-rerun";
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
  ReplyHook,
  UpdatePlanHook,
} from "../acp";
import {
  executeItem,
  createUpdateLimiter,
  REPLIES_PER_TURN,
  validateCandidateAttribution,
  git,
  removeWorktree,
  resolveAdapter,
  providerFor,
  worktreePath,
  mirrorPath,
  candidateRef,
  runDir,
  runAgent,
  createWorktree,
  ensureBareMirror,
  ensureCandidateRef,
  adoptLegacyCandidate,
  removeCandidateRef,
  restoreCandidateRef,
  FOLLOW_UP_INTERRUPTION,
  type RunAgentOptions,
  type RunAgentResult,
  prepareRepositorySnapshot,
} from "../acp";
import {
  DEFAULT_COMMENT_WAIT,
  DEFAULT_QUEUE_START_TIMEOUT_HOURS,
  checkoutExclusionsFor,
  highRiskPaths,
  agentReadAllowed,
  loadConfigFile,
  mergeLaneKey,
  readMergeSettings,
  repositoryPackages,
  reviewApps,
  readQueueSettings,
  readAgentSettings,
  resolveAgentProfiles,
  resolveBriefTemplate,
  resolveMergeSettings,
  suggestedFindingsMode,
  type AgentLabelProblem,
  type AgentProfile,
  type AgentProfiles,
  type CheckoutExclusions,
  type MergeSettings,
} from "../config";
import {
  fixAttemptLimit,
  policyFixBudget,
  approvalsAtHead,
  awaitsVisualReview,
  createCloseoutGate,
  fixChangedPaths,
  samePatch,
  PolicyFetchError,
  reviewRequirements,
  trustedPolicyFiles,
  trustedMirrorMain,
  trustedOriginMain,
  trustedRootFilesAt,
  visualReviewRequirements,
  bypassable,
  readReviewRounds,
  reviewFindingText,
  bugClass,
  snapshotRetryBaseline,
  storedReviewFindings,
  loggedSessionCloseout,
  missingResultReason,
  readSessionCloseout,
  sessionCloseoutPath,
  sessionCloseoutResult,
  writeSessionCloseout,
  pullRequestDraftKey,
  usesPullRequestDraft,
  type PullRequestDraft,
  type GateResult,
  type ReviewFindings,
  type ReviewRounds,
  type CloseoutGate,
  type CloseoutGateOptions,
  type CloseoutVerdict,
  type ResolvedEvidence,
  type CandidateIdentity,
  type CiResult,
  type TurnPass,
  candidatePolicyDigests,
  ciMappings,
  mergeResultPolicyError,
  POLICY_SCHEMA_SUMMARY,
} from "../closeout";
import {
  hydrateCloseoutEvidence,
  publishCloseoutEvidence,
  type EvidenceObjects,
  type EvidenceStorage,
} from "../evidence";
import {
  CommandBus,
  riskLine,
  type RiskClassification,
  policyCoauthors,
  commitIdentityEnv,
  appBotCommitIdentity,
  policyPullRequestCredit,
  commitPolicyMessage,
  type GitCommitPolicy,
  JOB_KIND,
  OUTBOX_ACTIVITY,
  isTerminalWorkItemState,
  isReadOnlyTaskMode,
  isResponseTaskMode,
  type Clock,
  type StageLimits,
  type ResponseTaskMode,
  type TaskMode,
  type LinearCommand,
  type RepositoryBinding,
  PawsShutdown,
  RunnerSlotsBusyError,
  AgentServiceError,
  isAgentServiceError,
  usageLimitNotice,
  ordinal,
  queueLine,
  systemClock,
  parseLinearCommand,
  isHostDiskFull,
  isTransient,
  isTransientGitError,
  MAX_TRANSIENT_RETRIES,
  RUNNER_CAPACITY_WAIT_MS,
  RunnerCapacityWait,
  RunnerSetupRequired,
  RunnerRepositoryRefused,
  type RunnerRepositoryRefusal,
  type RunnerSetupNeed,
  placementWaitMs,
  resumeRetrySpreadMs,
  retryNote,
  transientRetryDelayMs,
} from "../core";
import {
  listWaitingProfileRuns,
  getTaskMode,
  cancelOpenJobs,
  getLinearSessionAccess,
  type ConfirmedRemoteMerge,
  getLinearTaskDelegation,
  getLinearSessionGeneration,
  getLinearSession,
  listPendingLinearTurns,
  saveTaskMode,
  selectTaskModeForTurn,
  completeAnswerTask,
  completeArtifactTask,
  getTaskClassification,
  accrueAwake,
  applyWorkItemEvent,
  configureWorkItem,
  enqueueJobOnce,
  recordRebaseReturn,
  enqueueOutboxOnce,
  lastOutboxSequence,
  getOutbox,
  failWorkItem,
  getQueuePosition,
  clearQueueWait,
  queueWaitSince,
  settled,
  sqliteDb,
  activeRunnerIdsSteps,
  announceLinearTurnSteps,
  applyLinearCommandAsync,
  artifactPublicationReadySteps,
  assertLinearSessionCleanupSteps,
  attachSessionUpdatesSteps,
  closeoutHeadsStartedSteps,
  dropUnsentSessionActivitySteps,
  enqueueJobOnceSteps,
  getConfirmedRemoteMergeSteps,
  getLinearSessionContextSteps,
  getLinearTaskDelegationSteps,
  getLinearTurnGenerationSteps,
  getTaskModeGenerationSteps,
  hasLiveJobSteps,
  itemContinuedSteps,
  latestRestartEventSteps,
  listAgentCloseoutSteps,
  listArtifactsSteps,
  listRunnerSetupHoldsSteps,
  openRunnerRepositoryQuestionsSteps,
  previousIssueSessionIdsSteps,
  pullRequestDraftSavedAtSteps,
  queuedLinearCommentItemIdsSteps,
  receivedLinearCommentsSteps,
  recordItemBranchStateSteps,
  recordLinearCommentSteps,
  releaseRunnerSetupHoldSteps,
  replaceLeasedJobPayloadSteps,
  resolveTaskClassificationSteps,
  restartHoldSteps,
  runnerSlotFreeSteps,
  savePlanProposalSteps,
  saveRunResultSteps,
  saveTaskModeSteps,
  setItemBranchNameSteps,
  slotWaitRunnersSteps,
  taskRequiresRepositorySteps,
  commandInstance,
  emitJobReady,
  fixRoundsSteps,
  getOutboxSteps,
  type Db,
  getRun,
  CLEANUP_BLOCKED_NOTICE,
  blockConversation as blockStoredConversation,
  getConversation,
  saveConversation,
  listLinearTurnsForItem,
  getWorkItemRepository,
  getWorkItemRepositoryAnswer,
  saveWorkItemRepositoryQuestion,
  getWorkItem,
  getPullRequestDraft,
  immediate,
  drainInstanceCommands,
  runRunnerAvailability,
  setRunningCloseoutStepDetail,
  markRun,
  releaseRunCapacity,
  getItemPullRequest,
  getItemBranchState,
  saveVisualReviewMarks,
  type VisualReviewMark,
  bindLinearSessionTask,
  type StoredLinearSession,
  activateLinearItem,
  getLinearSessionContext,
  listLinearActivitySnapshots,
  applyLinearCommand,
  type Job,
  type JobLoop,
  type JobContext,
  type OutboxDeliveryContext,
  type OutboxDispatcher,
  type OutboxRow,
  type PullFeedbackWait,
  type ReviewCheckWait,
  type WorkItemRecord,
  type RunnerCapacityWaitState,
  PULL_REVIEW_CHECK_MAX_WAIT_MS,
  type CloseoutFaults,
  releaseReviewerFaultHolds,
  enqueueRunnerSetupCheck,
  holdForRunnerSetup,
  markRunnerSetupNotified,
  runnerAgentName,
  runnerCapacityWait,
  getTaskMergeSettings,
  pinRunCheckout,
  getTaskLinearRead,
  type TaskMergeSettings,
  resetAwakeTime,
  getWorkItemLinearProjectId,
  assignUnownedItem,
  bumpItemVersion,
  cancelItemPendingJobs,
  clearItemRecovery,
  hasOpenItemJob,
  itemOwnerUserId,
  itemParentTaskKey,
  itemSpecificationRevision,
  landedTaskBlockersSteps,
  latestRestartEvent,
  listItemIds,
  listItemIdsSteps,
  getWorkItemRepositorySteps,
  acceptLinearStopSteps,
  advanceLinearSessionGenerationSteps,
  applyLinearCommandSteps,
  completeMergedItemSteps,
  failedCloseoutReviewsSteps,
  getLinkAskSteps,
  getPublishedHeadSteps,
  latestRunningAnswerSteps,
  listCloseoutRecoveriesSteps,
  listCloseoutRoundsSteps,
  listInFlightItemsSteps,
  listOpenPolicyBlocksSteps,
  rebaseReturnedForSteps,
  recordItemPullRequestSteps,
  recordRebaseReturnSteps,
  recordReviewFindingsSteps,
  rewritePendingLinearTurnSteps,
  runnerHoldsRunWorkSteps,
  saveOpenFindingsSteps,
  savePullRequestTextSteps,
  startCloseoutRoundSteps,
  suggestedFindingsSteps,
  type Q,
  type Steps,
  moveDelegationSession,
  openTaskDependents,
  workspaceUserIdForLinearUser,
} from "../db";
import {
  publishAccepted,
  publishedPullRequestBody,
  storeEvidenceFiles,
  closeStoppedPull,
  deleteHiddenRef,
  fetchUpstreamMain,
  leaveGitHubMergeQueue,
  readPullMergeable,
  readHeadCheckRuns,
  readReviewThreads,
  readPullCi,
  commentOnPullRequest,
  replyToReviewComment,
  resolveReviewThread,
  mergedPullHeads,
  readPullMerge,
  branchContains,
  hasOpenPullOnPrefix,
  readOpenPullHead,
  readBranchWork,
  UPSTREAM_MAIN_REF,
  pushOutageCause,
  GitHubHttpError,
  type GitExec,
  type GitHubBinding,
  type GitHubTokenProvider,
  type PullMergeable,
} from "../github";
import {
  asksForFreshStart,
  intakeDelegatedIssue,
  stopAdoptedParent,
  type EarlierAttempt,
  type EarlierBranch,
  type IntakeResult,
} from "../intake";
import {
  createAdmission,
  dispatch,
  projectLeadId,
  type ItemAdmission,
  type ItemWait,
  overlapLine,
  openBlockers,
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
  LinearComment,
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
  linearCommentOf,
  linearSourceCommentId,
  parseLinearSessionContext,
  renderLinearSessionContext,
} from "../linear";
import {
  answer as answerAsked,
  answerer,
  canAnswer,
  cancelItemQuestions,
  cancelQuestion,
  findAskedQuestion,
  findOpenQuestion,
  handoffNote,
  acceptedVisualReviews,
  getQuestion,
  isPawsAnswerKind,
  pawsAnswerNote,
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
  cancelVisualReviewQuestion,
  carryVisualReview,
  dueVisualReview,
  pendingVisualReview,
  planVisualReviewCarry,
  postNote,
  remindVisualReview,
  reviewable,
  visualReviewApprovals,
  visualReviewPullRequestNote,
  visualReviewHandoff,
} from "./visual-review";
import {
  closeLinkAsksOnHead,
  decideLinkAsk,
  guideLinkAsk,
  linkAskAvailable,
  remindLinkAsk,
  reverifyBypassedSteps,
  type LinkAskEffects,
} from "./link-ask";
import {
  acceptCloseout,
  askAboutSlowCi,
  retryMergeLater,
  waitForMergeTurn,
  waitForRunnerSlot,
} from "./merge-jobs";
import { handlePullComments } from "./pull-comments";
import { pullRequestScreenshots } from "./pull-screenshots";
import { readReviewChecks, withReviewWait } from "./review-checks";
import {
  readPendingFeedback,
  restartWithFeedback,
  storedFeedbackReads,
  type FeedbackReads,
} from "./pending-feedback";
import {
  authorizeLinearComment,
  canConverse,
  commitLinearCommentRoute,
  deliverLinearComments,
  routeLinearComment,
  linearCommentBrief,
  settleLinearCommentBrief,
  type LinearCommentBrief,
  type LinearCommentCapabilities,
  type LinearCommentPolicy,
  type LinearConversations,
} from "./linear-comments";
import { postReviewReplies, recordAgentReviewReplies } from "./review-replies";
import { suggestedFindingsSection } from "./pull-comments";
import {
  acceptedSuggestions,
  findingId,
  handSuggestions,
  recordAgentFindingDecisions,
  startSuggestionTurn,
  suggestionTurnRunning,
  undecidedSuggestions,
  waitingSuggestions,
  withDecisions,
} from "./suggested-findings";
import { ciForRecheck, conflictsAt, type CiRecheck } from "./ci-recheck";
import { turnPasses } from "./turn-passes";
import { closeoutFocus } from "./closeout-focus";
import { followUpCi, unavailableCi, type FollowUpCi } from "./follow-up-ci";
import { PULL_REVIEW_POLL_MS, handlePullReview, type PullReviewCapabilities } from "./pull-reviews";
import {
  REBASE_CONFLICT_INSTRUCTION,
  advanceMerge,
  ciFixHandoff,
  ciFixRoundLine,
  type FailedCiCheck,
  ciWaitVerification,
  parkMerge,
  queueConflictSweep,
  askMergeHelp,
  rebaseBudgetFor,
  returnQueuedConflicts,
  wakeMergesBehind,
  postMergeConflict,
  type MergePublication,
  type MergeStep,
  type MergeWait,
  type OrderCapabilities,
  type RebaseConflict,
  type RunnerRebase,
} from "../merge";
import {
  createAcpActivityReporter,
  FIRST_ACTIVITY_MS,
  KEEPALIVE_MS,
  publicToolText,
  type ActivityOrigin,
} from "./activity";
import { PREPARATION_FAILED, recoveryOptions } from "./closeout-recovery";
import { askCloseoutHelp, type CloseoutHelp } from "./closeout-help";
import { askReviewRounds, reviewRoundLimit } from "./review-rounds";
import { createDbCloseoutProgress, publishingCloseoutProgress } from "./closeout-progress";
import { checkPolicyRunners } from "./policy-runners";
import { itemPathId, taskBranchKey, worktreeBranch, worktreeStartRef } from "./sources";
import {
  closeoutChecksPrompt,
  createAcpCodexReviewer,
  createReviewCommandReviewer,
  hiddenPathsPrompt,
  implementPrompt,
  GITHUB_READ_PROMPT,
  POST_UPDATE_PROMPT,
  type AgentLaunch,
  type AcpAgentDeps,
} from "./agents";
import { deliverLinearOutbox } from "./dispatch";
import { durableConversation } from "./conversation";
import { createLinearSessionProgress } from "./session-progress";
import { renderWorkContext, withLeftForLater } from "../core";
import { recordLinearSessionEventSteps, sessionTaskKey } from "./linear-routing";
import {
  createEvidenceArtifactPublisher,
  enqueueEvidenceCard,
  evidenceThoughts,
  evidenceSectionUrl,
  createLinearArtifactPublisher,
  publishedEvidence,
  type EvidenceSink,
} from "./artifacts";
import { createLinearInputLoader, createReviewMarkLoader } from "./input-files";
import { createTaskPlanner } from "./task-planner";
import { classifyTask } from "./task-classifier";
import { PLAN_PROMPT, parsePlanResult, planOptions, planProposalBody } from "./plan-proposal";
import type { LinearTaskAccess } from "./linear-task-access";
import { guardGitHubPublication } from "./publication";
import { applyPullRequestDraft } from "./pull-request-text";
import {
  askAboutPushOutage,
  holdPush,
  installationSettingsUrl,
  parkForPushOutage,
  pushRefused,
  pushWorked,
} from "./push-outage";
import {
  holdForPolicyOutage,
  policyLoadFailed,
  policyLoads,
  policyOutageNote,
  type MainPolicyError,
} from "./policy-outage";
import { policyBlockedRepositories, retryPolicyBlocks } from "./policy-block";
import { changedPaths, classifyPathsRisk } from "./candidate-risk";
import {
  askRiskApproval,
  postRiskActivity,
  riskApprovalFor,
  type FixRisk,
  RISK_ANSWERERS,
} from "./risk-approval";
import { sweepWorktrees } from "./worktree-sweep";
import { sweepCheckpointRefs } from "./checkpoint-ref";
import {
  KEEP_WAITING,
  MOVE_TO_ANOTHER_RUNNER,
  waitForRunner,
  type RunnerWaitQuestion,
} from "./runner-wait";
import { createRepositoryGit } from "./repository-git";
import { readFixDiff, settleReviewEscapes } from "./review-escapes";
import { recordAcceptedFindings } from "./review-findings";
import {
  failedReviewFindings,
  openFindings,
  openFindingsLine,
  openFindingsSection,
  pawsIssueUrl,
  reviewFindingGroups,
  type OpenItems,
} from "./open-findings";
import type { RuntimeList } from "../runtimes";
import { createRuntimeLists } from "./runtime-lists";
import { startFreshBudget } from "./time-budget";
import { HOST_DISK_FULL_THOUGHT, hostDiskFullThoughtKey } from "./disk-full";
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
  /** The async `Db` over `db` for converted code. Defaults to `sqliteDb(db)`. */
  store?: Db;
  instanceId?: string;
  jobs: JobLoop;
  outbox: OutboxDispatcher;
  pawsRoot: string;
  home?: string;
  closeoutPolicyRoot?: (repository: RepositoryBinding) => string | undefined;
  /** Builds the Closeout gate for one evaluation. Tests pass the Closeout fake. */
  closeoutGate?: (options: CloseoutGateOptions) => CloseoutGate;
  /** Reads the review requirements from the trusted Closeout policy. Tests pass a fake. */
  reviewRequirements?: typeof reviewRequirements;
  /** How often a merge-queue re-check reads CI while it waits for it, and for how long. */
  ciRecheckWait?: { pollMs: number; maxWaitMs: number };
  tracker?: TrackerAdapter | null;
  linearTaskModes?: boolean;
  linearAccess?: LinearTaskAccess;
  authorizeLinearEvent?: (event: AcceptedLinearEvent) => Promise<IntakeDecision>;
  recheckLinearEvent?: (event: AcceptedLinearEvent) => boolean | Promise<boolean>;
  remoteFollowUp?: (itemId: string, body: string) => boolean | Promise<boolean>;
  linearComments?: LinearCommentPolicy;
  conversations?: () => Promise<LinearConversations | null>;
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
  evidence?: {
    store: EvidenceSink;
    publicUrl: string;
    root?: string;
    objects?: EvidenceObjects;
  } | null;
  closeoutEvidenceObjects?: EvidenceObjects;
  /** The HTTPS dashboard origin (`PAWS_PUBLIC_URL`). Without it Paws cannot ask with a link. */
  publicUrl?: string | null;
  catchUp?: () => Promise<void>;
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
  githubForRepository?: (repository: RepositoryBinding) => GitHubBinding | null;
  commitPolicyForItem?: (item: WorkItemRecord) => Promise<GitCommitPolicy | undefined>;
  launch?: AgentLaunch;
  remoteExecution?: {
    cancelItem?(itemId: string): Promise<void>;
    slotFree?(): boolean;
    /** An importer already owns this run, including backend preparation before attachment. */
    runInProgress?(runId: string): Promise<boolean>;
    agentForSession(sessionId: string, purpose: "classify" | "select_repository"): typeof runAgent;
    agentForItem(itemId: string): (options: RunAgentOptions) => Promise<RunAgentResult>;
    /**
     * Whether the runners the item ran on report all of its commands gone since `since`, so a
     * conversation blocked on their cleanup can continue. SQLite only.
     */
    commandsGone?(itemId: string, since: number): boolean;
  };
  remoteCloseoutRetry?: { attempts: number; delayMs: number };
  /** How often Closeout rechecks an unavailable runner, and when it asks the team. */
  runnerWait?: { pollMs: number; askAfterMs: number; sleep?: (ms: number) => Promise<void> };
  publicationReady?: (
    itemId: string,
    phase: "publish" | "merge",
    signal?: AbortSignal,
    candidate?: { sha: string; baseSha: string },
  ) => boolean | Promise<boolean>;
  admission?: ItemAdmission;
  journal?: (line: string) => void;
  scheduling?: () => Pick<SchedulerOptions, "ownerCap">;
  /**
   * Whether the item's owner has a runner they may use for this agent. False keeps a queued
   * item out of the slot line and its start timeout. Null when it cannot tell. SQLite only.
   */
  ownerHasRunner?: (itemId: string, agent: string, now: number) => boolean | null;
  itemRunners?: (
    itemId: string,
    profile: { agent: string; model?: string | null },
    now: number,
  ) => ItemRunnerVerdicts | null;
  onRunnerHostRefusals?: (refusals: readonly RunnerHostRefusal[], now: number) => void;
  /**
   * Why the item's owner has no runner they may use for this agent, for the runner-setup hold
   * and its thought. Null when a runner is usable or only offline. SQLite only.
   */
  runnerSetupNeed?: (itemId: string, agent: string, now: number) => RunnerSetupNeed | null;
  repositoryRefusals?: (
    itemId: string,
    now: number,
  ) => { repository: string; refusals: readonly RunnerRepositoryRefusal[] } | null;
  repositoryAllowedOn?: (itemId: string, runnerId: string, now: number) => boolean;
  /**
   * A runner the item's owner may use for this agent now, for the line that resumes a
   * runner-setup hold. Null when none is eligible. SQLite only.
   */
  eligibleRunner?: (
    itemId: string,
    agent: string,
    now: number,
  ) => { id: string; name: string } | null;
  runnerRebase?: (
    item: WorkItemRecord,
    heads: { head: string; main: string },
    signal: AbortSignal,
  ) => Promise<RunnerRebase>;
  clock?: Clock;
  caps?: {
    maxAwakeMs: number;
    limits?: (projectId: string | null) => StageLimits;
  };
  retryBaseMs?: number;
  placementPollMs?: number;
  random?: () => number;
  /** Runs publication Git (push, fetch, rebase) in place of the owned Git. Tests pass a wrapper. */
  publicationGitExec?: GitExec;
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
  jobId: number;
  publicationCandidate?: { sha: string; baseSha: string };
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
  readonly store: Db;
  private tracker: TrackerAdapter | null;
  private catchUpFn: () => Promise<void>;
  private readonly askedRuns = new Set<string>();
  /** Temporary errors thrown while the agent was being prepared, before it started. */
  private readonly preparationFailures = new WeakSet<object>();
  private readonly pullRequestReads = new Set<string>();
  private releasingBlocks: Promise<void> | null = null;
  private readonly live = new Map<
    string,
    {
      itemId: string;
      version: number;
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
  private readonly leasedJobs = new Map<string, Job>();
  private readonly jobContexts = new Map<string, JobContext>();
  private readonly mergeTurnNotes = new Map<string, number>();
  /** Why the current job dropped the item's Closeout result while the item stays in `verifying`. */
  private readonly verifyingStops = new Map<string, string>();
  private readonly reviewerFaults = new Map<string, string>();
  private readonly runtimeLists = createRuntimeLists(
    {
      originMain: trustedOriginMain,
      mirrorMain: trustedMirrorMain,
      rootFilesAt: trustedRootFilesAt,
    },
    { journal: (line) => (this.options.journal ?? journal)(line) },
  );
  private shuttingDown = false;
  private readonly admissionLabelReads = new Set<string>();
  private readonly activitySeqs = new Map<string, number>();
  private waitFaces = new Map<string, string>();
  private readonly activityRequests = new Map<number, AbortSignal>();
  private readonly updates = createUpdateLimiter(() => this.now());
  private readonly replies = new Map<string, { turn: string; count: number }>();
  private readonly inputLoader: ReturnType<typeof createLinearInputLoader> | null;
  private readonly taskPlanner: ReturnType<typeof createTaskPlanner>;
  private readonly githubAuth: GitHubInstallationCheck | null;
  private readonly authRecoveryController = new AbortController();
  private authRecovery: Promise<void> | null = null;
  private readonly admission: ItemAdmission;

  private readonly riskDisplayReader: RiskDisplayReader;

  /** The dashboard reads through this callback without importing the loop or loading config. */
  riskDisplay(itemId: string, head?: string): RiskDisplay | null {
    return this.riskDisplayReader.read(itemId, head);
  }

  refreshRiskDisplaySettings(): void {
    this.riskDisplayReader.refreshSettings();
  }

  constructor(private readonly options: OrchestratorOptions) {
    this.store = options.store ?? sqliteDb(options.db);
    this.riskDisplayReader = new RiskDisplayReader({
      db: options.db,
      configPath: join(options.pawsRoot, "config.toml"),
      readSettings: () => this.readMergePolicy(),
      publicUrl: options.publicUrl,
      journal: options.journal,
    });
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
    const comment = linearCommentOf(event);
    if (comment !== null) return this.receiveLinearComment(comment);
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
    if (event.action === "prompted" && (await this.commentAlreadyHandedOff(event))) return;
    await this.taskAccess()?.assertOpenIssue(event);
    let turnEventKey = event.dedupeKey;
    if (
      event.action === "prompted" &&
      event.sessionId &&
      event.body !== null &&
      (!findOpenQuestion(this.db, event.sessionId) ||
        this.hasPublishedPullRequest(event.sessionId) ||
        (await this.sessionPaused(event.sessionId)))
    ) {
      const turn = await this.recordTurn(event);
      if (turn) turnEventKey = turn.eventKey;
      if (
        turn?.state === "pending" &&
        !this.hasPublishedPullRequest(event.sessionId) &&
        (await this.forwardFollowUp(event.sessionId, turn))
      )
        return;
      const announcedSession = event.sessionId;
      if (
        turn &&
        (await this.store.transaction((q) =>
          announceLinearTurnSteps(q, announcedSession, turn.eventKey, this.now()),
        ))
      ) {
        for (const live of this.live.values())
          if (this.itemsForSession(event.sessionId).some((item) => item.id === live.itemId))
            live.controller.abort(FOLLOW_UP_INTERRUPTION);
        await this.stopTaskPlanning(event.sessionId);
      }
    }
    const key = event.sessionId ?? event.issueId ?? event.dedupeKey;
    const previous = this.sessionEvents.get(key) ?? Promise.resolve();
    const done = previous
      .catch((caughtError1) => {
        journalCaught(
          caughtError1,
          "orchestrator.onLinearEvent",
          this.itemsForSession(event.sessionId ?? "")
            .map((item) => item.id)
            .join(",") || null,
          undefined,
          this.options.journal,
        );
        return undefined;
      })
      .then(async () => {
        const current =
          (await this.options.recheckLinearEvent?.(event)) === false
            ? LINEAR_ACCESS_CHANGED
            : decision;
        if (!this.admitLinearEvent(event, current, true)) {
          const discarded = event.sessionId;
          if (discarded !== null)
            await this.store.transaction((q) =>
              discardLinearTurnsSteps(q, discarded, [turnEventKey]),
            );
          return false;
        }
        const open = event.sessionId ? findOpenQuestion(this.db, event.sessionId) : null;
        const questionDelegationId = open
          ? (await this.store.run((q) => getWorkItemSteps(q, open.itemId)))?.delegationId
          : null;
        await this.handleLinearEvent(event);
        const promptedSession = event.sessionId;
        if (event.action === "prompted" && promptedSession) {
          const delegationId =
            (await this.store.run((q) => workItemForSessionSteps(q, promptedSession)))
              ?.delegationId ?? questionDelegationId;
          if (delegationId) await this.reconcileExecution();
        }
      });
    this.sessionEvents.set(key, done);
    try {
      return await done;
    } finally {
      if (this.sessionEvents.get(key) === done) this.sessionEvents.delete(key);
    }
  }

  private async receiveLinearComment(comment: LinearComment): Promise<boolean> {
    const policy = this.options.linearComments;
    if (policy === undefined) return false;
    await this.store.transaction((q) => recordLinearCommentSteps(q, comment, this.now()));
    const wait = policy.wait?.() ?? this.feedbackWait();
    for (const received of await this.store.run((q) => receivedLinearCommentsSteps(q))) {
      if (received.issueId !== comment.issueId) continue;
      const route = await routeLinearComment(this.db, received, policy);
      const authorized =
        route.kind === "queue" ? await authorizeLinearComment(route, policy) : true;
      await commitLinearCommentRoute(this.db, received.commentId, route, {
        now: this.now(),
        wait,
        authorized,
      });
    }
    await this.leaveMergeQueueForComments(policy, comment.issueId);
    await this.flush();
    const stored = await this.store.run((q) => getLinearCommentSteps(q, comment.commentId));
    return stored !== null && stored.state !== "rejected" && stored.state !== "ignored";
  }

  private async leaveMergeQueueForComments(
    policy: LinearCommentPolicy,
    issueId: string,
  ): Promise<void> {
    for (const id of await this.store.run((q) => queuedLinearCommentItemIdsSteps(q, issueId))) {
      const item = await this.store.run((q) => getWorkItemSteps(q, id));
      const pull = item ? await this.store.run((q) => getItemPullRequestSteps(q, item.id)) : null;
      if (!item || item.state !== "merge_queue" || pull === null) continue;
      await this.linearCommentCapabilities(policy)
        .leaveMergeQueue(item, pull.pullNumber)
        .catch((error: unknown) =>
          journalCaught(
            error,
            "orchestrator.leaveMergeQueueForComments",
            item.id,
            undefined,
            this.options.journal,
          ),
        );
    }
  }

  private async commentAlreadyHandedOff(event: AcceptedLinearEvent): Promise<boolean> {
    const source = linearSourceCommentId(event);
    if (source === null) return false;
    const now = () => this.now();
    return await this.store.transaction(function* (q) {
      const comment = yield* getLinearCommentSteps(q, source);
      if (comment === null) return false;
      if (comment.state === "received" || comment.state === "queued") {
        yield* settleLinearCommentsSteps(q, [source], {
          state: "ignored",
          reason: "agent_session",
          now: now(),
        });
        return false;
      }
      return comment.state === "delivered";
    });
  }

  private linearCommentCapabilities(
    policy: LinearCommentPolicy,
    signal?: AbortSignal,
  ): LinearCommentCapabilities {
    return {
      now: () => this.now(),
      policy,
      busy: async (item) =>
        this.jobContexts.has(item.id) ||
        (await this.store.run((q) => hasLiveJobSteps(q, item.id, this.now()))),
      leaveMergeQueue: async (item, pullNumber) => {
        const repository = this.repositoryForItem(item);
        const github = repository ? this.githubForRepository(repository) : null;
        if (!repository || !github) return "not_queued";
        return leaveGitHubMergeQueue({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          prNumber: pullNumber,
          ...this.gitHubCredentials(github),
          ...(signal ? { signal } : {}),
        });
      },
      flush: () => this.flush(),
      ...(this.options.conversations ? { conversations: this.options.conversations } : {}),
      resumeSession: (sessionId) => this.resumeLinearSession(sessionId, false),
    };
  }

  private linearCommentBrief(item: WorkItemRecord): LinearCommentBrief | null {
    const policy = this.options.linearComments;
    return policy ? linearCommentBrief(this.db, item, { now: () => this.now(), policy }) : null;
  }

  private settleLinearCommentBrief(item: WorkItemRecord, brief: LinearCommentBrief | null): void {
    const policy = this.options.linearComments;
    if (brief === null || policy === undefined) return;
    settleLinearCommentBrief(this.db, item, brief, {
      now: this.now(),
      wait: policy.wait?.() ?? this.feedbackWait(),
    });
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
      throw new LinearIntakeRefusedError(decision.reason, {
        quiet: decision.quiet === true,
        response: decision.response === true,
      });
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
    // A previous session's agent the runner reports gone no longer holds up a new delegation.
    for (const item of items) {
      const conversation = await this.store.run((q) => getConversationSteps(q, item.id));
      if (conversation.blocked && !(await this.releaseCleanupBlock(item.id)))
        throw new Error("ACP process cleanup could not be verified");
    }
    const failure = joined.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.riskDisplayReader.close();
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
    for (const item of this.allItems(true))
      if ((await this.store.run((q) => getConversationSteps(q, item.id))).blocked)
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

  private async recordTurn(event: AcceptedLinearEvent) {
    if (!event.sessionId || event.body === null) return null;
    const sessionId = event.sessionId;
    const body = event.body;
    await this.store.transaction((q) => recordLinearSessionEventSteps(q, event, this.now()));
    return await this.store.transaction((q) =>
      recordLinearTurnSteps(q, {
        eventKey: event.dedupeKey,
        activityId: event.activityId,
        sessionId,
        actorId: "actorId" in event && typeof event.actorId === "string" ? event.actorId : null,
        body,
        payload: event.payload,
        createdAtMs:
          "activityCreatedAtMs" in event && typeof event.activityCreatedAtMs === "number"
            ? event.activityCreatedAtMs
            : event.updatedAtMs,
        now: this.now(),
      }),
    );
  }

  private async handleLinearEvent(event: AcceptedLinearEvent): Promise<void> {
    if (this.shuttingDown) throw new Error("Paws is shutting down");
    if (event.action === "prompted") {
      const question =
        event.sessionId && !(await this.sessionPaused(event.sessionId))
          ? findOpenQuestion(this.db, event.sessionId)
          : null;
      const questionItem = question
        ? await this.store.run((q) => getWorkItemSteps(q, question.itemId))
        : null;
      if (event.sessionId && event.body) {
        const sessionId = event.sessionId;
        const session = await this.store.transaction((q) =>
          recordLinearSessionEventSteps(q, event, this.now()),
        );
        if (
          questionItem &&
          session &&
          !(await this.store.run((q) => workItemForSessionSteps(q, sessionId)))
        ) {
          await this.store.transaction((q) =>
            bindLinearSessionTaskSteps(q, sessionId, questionItem.delegationId),
          );
          await this.store.transaction((q) =>
            activateLinearItemSteps(q, sessionId, questionItem.id),
          );
        }
        const turn = await this.recordTurn(event);
        if (turn?.state !== "pending") return;
        event = { ...event, dedupeKey: turn.eventKey, body: turn.body, payload: turn.payload };
      }
      if (!question && event.sessionId) {
        await this.resumeLinearSession(event.sessionId);
        return;
      }
      const responseMode = Boolean(
        event.sessionId &&
        questionItem &&
        question &&
        !(await this.store.run((q) =>
          isWorkItemRepositoryQuestionSteps(q, questionItem.id, question.id),
        )) &&
        isResponseTaskMode(await this.store.run((q) => getTaskModeSteps(q, questionItem.id))),
      );
      const outcome = await this.deliverPrompt(event, responseMode);
      if (event.sessionId) {
        const sessionId = event.sessionId;
        const eventKey = event.dedupeKey;
        if (outcome === "rejected")
          await this.store.transaction((q) => discardLinearTurnsSteps(q, sessionId, [eventKey]));
        if (outcome === "redirect") await this.resumeLinearSession(sessionId);
      }
      return;
    }
    if (event.action !== "created" || event.issueId === null) return;
    let startFresh = asksForFreshStart(event.body);
    if (event.sessionId !== null) {
      const sessionId = event.sessionId;
      const context = parseLinearSessionContext(event.payload);
      const comment = context.comment as { body?: unknown } | null;
      if (typeof comment?.body === "string" && asksForFreshStart(comment.body)) startFresh = true;
      await this.store.run((q) =>
        saveLinearSessionContextSteps(
          q,
          sessionId,
          renderLinearSessionContext(context),
          context.promptContext ? 2 : 1,
        ),
      );
    }
    const tracker = this.tracker;
    if (tracker === null) throw new Error("Linear is not connected");
    const session =
      event.sessionId === null
        ? null
        : await this.store.transaction((q) => recordLinearSessionEventSteps(q, event, this.now()));
    const taskKey = session ? await sessionTaskKey(this.store, session) : null;
    if (session?.stoppedAt !== null && session?.stoppedAt !== undefined) return;
    if (session && !startFresh && (await this.resumeRedelegatedItem(event.issueId, session)))
      return;
    let result: IntakeResult;
    try {
      result = await this.intakeLinearTask(event.issueId, event.sessionId, taskKey ?? undefined, {
        acknowledged: session !== null,
        startFresh,
      });
    } catch (error) {
      const current = session
        ? await this.store.run((q) => getLinearSessionSteps(q, session.sessionId))
        : null;
      if (session && (current?.stoppedAt !== null || current.generation !== session.generation)) {
        journalCaught(
          error,
          "orchestrator.handleLinearEvent.intakeLinearTask",
          this.itemsForSession(event.sessionId ?? "")
            .map((item) => item.id)
            .join(",") || null,
          undefined,
          this.options.journal,
        );
        return;
      }
      throw error;
    }
    if (result.ok) {
      const caps = this.options.caps;
      if (caps !== undefined) {
        for (const saved of result.items) {
          const limits = this.timeLimits(saved.id);
          await this.store.run((q) =>
            configureWorkItemSteps(q, saved.id, { maxAwakeMs: caps.maxAwakeMs, limits }),
          );
        }
      }
      await this.dispatch();
    }
    await this.flush();
  }

  sessionProgressReporter(event: AcceptedLinearEvent): TrackerAdapter["postProgress"] {
    const generation = event.sessionId
      ? getLinearSessionGeneration(this.db, event.sessionId)
      : undefined;
    const sessionId = event.sessionId;
    return async (update, request) =>
      this.enqueueSessionProgress(
        update,
        `ack:${event.dedupeKey}:${update.kind}${update.kind === "thought" && update.body !== FIRST_ACTIVITY_BODY ? ":pending" : ""}`,
        (sessionId
          ? await this.store.run((q) =>
              getLinearTurnGenerationSteps(q, sessionId, event.dedupeKey, event.activityId),
            )
          : null) ?? generation,
        request,
        event.action === "created" &&
          update.kind === "thought" &&
          update.body === FIRST_ACTIVITY_BODY,
      );
  }

  private async startPost(id: number): Promise<void> {
    const row = await this.store.run((q) => getOutboxSteps(q, id));
    const orderingKey = row?.orderingKey;
    if (orderingKey == null) return;
    await this.store.transaction((q) => attachSessionUpdatesSteps(q, id, this.now()));
    await this.store.run((q) =>
      dropUnsentSessionActivitySteps(q, {
        orderingKey,
        body: FIRST_ACTIVITY_BODY,
        error: `Sent as outbox ${id}.`,
        now: this.now(),
      }),
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
    const id = await this.store.transaction((q) =>
      enqueueOutboxOnceSteps(q, {
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
      }),
    );
    if (request?.signal) this.activityRequests.set(id, request.signal);
    if (initialActivity) {
      const forget = () => {
        if (this.activityRequests.get(id) === request?.signal) this.activityRequests.delete(id);
      };
      request?.signal?.addEventListener("abort", forget, { once: true });
      const held = setTimeout(() => {
        if (!this.shuttingDown)
          void this.flush(request?.signal, update.sessionId)
            .catch((caughtError2) => {
              journalCaught(
                caughtError2,
                "orchestrator.enqueueSessionProgress.flush",
                this.itemsForSession(update.sessionId)
                  .map((item) => item.id)
                  .join(",") || null,
                undefined,
                this.options.journal,
              );
              return undefined;
            })
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
      startFresh?: boolean;
    } = {},
  ) {
    const tracker = this.tracker;
    if (!tracker) throw new Error("Linear is not connected");
    const initialSession = sessionId
      ? await this.store.run((q) => getLinearSessionSteps(q, sessionId))
      : null;
    const isCurrent = () => {
      if (this.shuttingDown) return false;
      if (initialSession === null || sessionId === null) return true;
      const current = getLinearSession(this.db, sessionId);
      return current?.generation === initialSession.generation && current.stoppedAt === null;
    };
    if (!isCurrent()) throw new Error("The Linear request changed before intake");
    const requestKey = taskKey;
    const savedRequest = requestKey
      ? await this.store.run((q) => getTaskClassificationSteps(q, requestKey))
      : null;
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
              if (error instanceof RunnerSlotsBusyError && !savedRequest) {
                journalCaught(
                  error,
                  "orchestrator.intakeLinearTask.plan",
                  redirect?.itemId,
                  undefined,
                  this.options.journal,
                );
                return null;
              }
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
      cancelItemPendingJobs(this.db, previous.id, this.now());
    };
    const assignUnownedItems = (actorId: string | null, items: readonly { id: string }[]) => {
      if (items.length === 0 || !actorId) return;
      const ownerId = workspaceUserIdForLinearUser(this.db, actorId);
      if (!ownerId) return;
      for (const item of items) assignUnownedItem(this.db, item.id, ownerId);
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
        ? (issueIds) =>
            this.reconcilePreviousSessions(issueIds, sessionId, intakeCurrent, {
              keepPullRequest: options.startFresh !== true,
            })
        : undefined,
      startFresh: options.startFresh === true,
      inspectBranch: (earlier) => this.inspectEarlierBranch(earlier),
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
                maxAwakeMs: this.options.caps.maxAwakeMs,
                limits: this.timeLimits(child.id),
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
        if (!(await this.store.run((q) => getTaskModeSteps(q, item.id)))) {
          const generation = sessionId
            ? await this.store.run((q) => getLinearSessionGenerationSteps(q, sessionId))
            : 0;
          const { mode } = classification;
          const repository = classification.repository === true;
          await this.store.transaction((q) =>
            saveTaskModeSteps(q, item.id, mode, generation, repository),
          );
        }
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
    const history = (await this.store.run((q) => listLinearActivitySnapshotsSteps(q, sessionId)))
      .map((raw) => JSON.parse(raw) as LinearActivitySnapshot)
      .filter((activity) => activity.content.type !== "thought" && !activity.ephemeral);
    return [
      JSON.stringify(snapshot),
      await this.store.run((q) => getLinearSessionContextSteps(q, sessionId)),
      JSON.stringify(history),
      options.conversation ?? "",
      ...(options.followupBodies ??
        (await this.store.run((q) => listPendingLinearTurnsSteps(q, sessionId))).map(
          (turn) => turn.body,
        )),
    ].join("\n\n");
  }

  /**
   * What GitHub holds for an earlier item's branch. Without a repository or GitHub binding the
   * branch reads as empty, so the new item starts fresh.
   */
  private async inspectEarlierBranch(earlier: EarlierAttempt): Promise<EarlierBranch> {
    const previous = await this.store.run((q) => getWorkItemSteps(q, earlier.itemId));
    const repository = previous ? this.repositoryForItem(previous) : null;
    const github = repository ? this.githubForRepository(repository) : null;
    if (!repository || !github) return { pull: null, commits: 0 };
    return readBranchWork({
      client: github.client,
      owner: repository.owner,
      repo: repository.repo,
      branch: earlier.branchName,
      ...this.gitHubCredentials(github),
      signal: AbortSignal.any([this.authRecoveryController.signal, AbortSignal.timeout(10_000)]),
    });
  }

  private async reconcilePreviousSessions(
    issueIds: readonly string[],
    incomingSessionId: string,
    isCurrent: () => boolean,
    /** The new delegation may continue the stopped session's branch, so its pull request stays. */
    stop: { keepPullRequest: boolean },
  ): Promise<void> {
    if (!this.tracker?.getSession) return;
    const candidates = (issueId: string) =>
      this.store.run((q) => previousIssueSessionIdsSteps(q, incomingSessionId, issueId));
    try {
      for (const issueId of issueIds) {
        for (const sessionId of await candidates(issueId)) {
          const previous = (await this.store.run((q) => getLinearSessionSteps(q, sessionId)))!;
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
              (await this.store.run((q) => getLinearSessionSteps(q, sessionId)))?.generation !==
                previous.generation ||
              !(await candidates(issueId)).includes(sessionId)
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
              stop,
            );
          } else {
            await this.interruptLinearSession(sessionId);
          }
          if (!isCurrent()) throw new Error("Linear intake changed during cleanup");
          await this.store.run((q) => assertLinearSessionCleanupSteps(q, sessionId));
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

  private async forItem<T>(payload: unknown, run: () => T | Promise<T>): Promise<T> {
    const itemId = readString(payload, "itemId");
    const item = itemId ? await this.store.run((q) => getWorkItemSteps(q, itemId)) : null;
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
          this.forItem(job.payload, async () =>
            queue === JOB_KIND.command ||
            queue === JOB_KIND.reverify ||
            (await this.store.run((q) => jobVersionCurrentSteps(q, job)))
              ? handler(job, context)
              : undefined,
          ),
        ),
    };
    jobs.register("item.ask", async (job, context) => {
      if (!context.isCurrent()) return;
      const id = readString(job.payload, "itemId");
      const item = id ? await this.store.run((q) => getWorkItemSteps(q, id)) : null;
      if (!item?.sessionKey || item.cancelRequested) return;
      const payload = job.payload as {
        kind: "agent" | "time-limit";
        reason?: string;
        body: string;
        options: string[];
      };
      ask(
        this.db,
        {
          itemId: item.id,
          runId: item.currentRunId,
          sessionId: item.sessionKey,
          version: item.version,
        },
        payload.kind,
        payload.body,
        {
          options: payload.options,
          ...(payload.reason ? { reason: payload.reason } : {}),
          now: this.now(),
        },
      );
      const heldRunId = item.currentRunId;
      if (heldRunId) await this.store.run((q) => releaseRunCapacitySteps(q, heldRunId, this.now()));
      await this.flush();
    });
    jobs.register(JOB_KIND.command, async (job, context) => {
      if (!context.isCurrent()) return;
      const command = parseLinearCommand(job.payload);
      if (!command) return;
      const saved = job.payload as { response?: string; options?: { keepPullRequest?: boolean } };
      const result = await applyLinearCommandAsync(
        this.store,
        command,
        this.now(),
        saved.response,
        saved.options,
        commandInstance(this.db),
      );
      if (result.deferred) {
        await this.store.run((q) =>
          parkLeasedJobSteps(q, job, {
            runAt: this.now() + 1_000,
            payload: job.payload,
            attempts: 0,
            now: this.now(),
          }),
        );
        return;
      }
      if (!result.applied) return;
      try {
        this.bus.emit(command);
      } finally {
        await this.interruptItem(command.itemId);
      }
    });
    jobs.register(JOB_KIND.catchup, async (job) => {
      await this.store.transaction((q) =>
        enqueueOutboxOnceSteps(q, {
          target: "linear",
          op: "linear.catchup",
          idempotencyKey: `catchup:${job.id}:${job.attempts}`,
          payload: job.payload,
          now: this.now(),
        }),
      );
    });
    jobs.register(JOB_KIND.visualReviewReminder, async (job, context) => {
      const questionId = readString(job.payload, "questionId");
      if (!context.isCurrent() || questionId === null) return;
      if (await remindVisualReview(this.db, questionId, this.now())) await this.flush();
    });
    jobs.register(JOB_KIND.linkAskReminder, async (job, context) => {
      const questionId = readString(job.payload, "questionId");
      if (!context.isCurrent() || questionId === null) return;
      if (await remindLinkAsk(this.db, questionId, this.now())) await this.flush();
    });
    jobs.register(JOB_KIND.reaskQuestion, async (job, context) => {
      const itemId = readString(job.payload, "itemId");
      const questionId = readString(job.payload, "questionId");
      if (!context.isCurrent() || itemId === null || questionId === null) return;
      if (await reaskDeadQuestion(this.db, { itemId, questionId, jobId: job.id, now: this.now() }))
        await this.flush();
    });
    jobs.register(JOB_KIND.runnerSetupCheck, async (job) => {
      const owner = readString(job.payload, "ownerUserId");
      if (owner !== null) await this.checkRunnerSetup(owner);
    });
    jobs.register(JOB_KIND.runnerRepositoryCheck, async (job) => {
      const runnerId = readString(job.payload, "runnerId");
      if (runnerId !== null)
        await this.checkRunnerRepositories(
          runnerId,
          readString(job.payload, "answeredBy") ?? "paws",
        );
      await this.flush();
    });
    jobs.register(JOB_KIND.start, async (job, context) => {
      if (await this.waitingForConversation(job, context)) return;
      if (await this.waitingForRunnerSlot(job)) return;
      await this.runLeasedJob(job, context, () => this.executeRetried(job, context));
      await this.settleVerifying(job, context);
    });
    jobs.register(JOB_KIND.resume, async (job, context) => {
      if (await this.waitingForConversation(job, context)) return;
      if (await this.waitingForRunnerSlot(job)) return;
      if (await this.mergeInsteadOfTurn(job, context)) return;
      await this.runLeasedJob(job, context, () => this.executeRetried(job, context));
      await this.settleVerifying(job, context);
    });
    jobs.register(JOB_KIND.reverify, async (job, context) => {
      const itemId = readString(job.payload, "itemId");
      const item =
        itemId === null ? null : await this.store.run((q) => getWorkItemSteps(q, itemId));
      if (
        !item ||
        !this.reverifyEligible(item) ||
        !context.isCurrent() ||
        !(await this.reverifyJobCurrent(job, item)) ||
        (await this.waitingForConversation(job, context))
      )
        return;
      await this.failOnLastAttempt(job, context, "reverify", async () => {
        if (await this.reverifyHeld(item)) {
          await this.waitForVerification(job, context, item);
          return;
        }
        const clearWait = async () => {
          const payload = job.payload as Record<string, unknown>;
          if (!("verificationWaitSince" in payload)) return;
          const { verificationWaitSince: _since, verificationWaitRunId: _run, ...rest } = payload;
          const current = job;
          if (
            await this.store.run((q) => replaceLeasedJobPayloadSteps(q, current, rest, this.now()))
          )
            job = { ...job, payload: rest };
        };
        if (
          await this.waitingForRunnerSlot(job, async () => {
            await clearWait();
            return job;
          })
        )
          return;
        try {
          await this.runLeasedJob(job, context, () =>
            this.runOwnedJob(job.payload, () =>
              this.reverify(job.payload, job.id, async () => {
                const owned = await this.store.run((q) => getWorkItemSteps(q, item.id));
                const runId = owned?.currentRunId;
                if (runId && !(await this.store.run((q) => jobVersionCurrentSteps(q, job))))
                  await this.store.run((q) =>
                    refreshVerificationJobVersionSteps(q, job, runId, this.now()),
                  );
                await clearWait();
              }),
            ),
          );
          await this.settleVerifying(job, context);
        } catch (error) {
          if (error instanceof VerificationHeld && context.isCurrent()) {
            const held =
              itemId === null ? null : await this.store.run((q) => getWorkItemSteps(q, itemId));
            if (held) await this.waitForVerification(job, context, held);
            return;
          }
          const wait = await this.nextRunnerWait(job, error);
          if (!wait || !context.isCurrent()) throw error;
          journalCaught(
            error,
            "orchestrator.register.runLeasedJob",
            readString(job.payload, "itemId"),
            undefined,
            this.options.journal,
          );
          await clearWait();
          const waitingId = readString(job.payload, "itemId");
          if (waitingId) this.settleItemAwake(waitingId);
          waitForRunnerSlot(this.db, job, this.now(), this.runnerWaitMs(wait), wait);
        }
      });
    });
    jobs.register(JOB_KIND.merge, async (job, context) => {
      const ownerId = readString(job.payload, "itemId");
      if (ownerId !== null && this.mergeTurnTaken(ownerId)) {
        if (context.isCurrent()) await waitForMergeTurn(this.db, job, this.now());
        return;
      }
      let waiting: MergeWait | undefined;
      try {
        await this.mergeAttempt(job, context, (wait) => {
          waiting = wait;
        });
      } catch (error) {
        if (!this.shuttingDown && context.isCurrent() && (await this.holdForPushOutage(job, error)))
          return;
        if (this.shuttingDown || job.attempts >= job.maxAttempts || !context.isCurrent())
          throw error;

        const delayMs = transientRetryDelayMs(job.attempts, error, this.options.retryBaseMs);

        if (!(await retryMergeLater(this.db, job, this.now(), delayMs, error))) throw error;
        await this.noteHostDiskFull(readString(job.payload, "itemId"), error);
        journalCaught(
          error,
          "orchestrator.register.mergeAttempt",
          readString(job.payload, "itemId"),
          undefined,
          this.options.journal,
        );
        return;
      }
      if (waiting === undefined) return;
      const waitingId = readString(job.payload, "itemId");
      if (waitingId) this.settleItemAwake(waitingId);
      const parked = await parkMerge(this.store, job, this.now(), waiting);
      if (parked === "parked" || parked === "lost") return;
      const itemId = readString(job.payload, "itemId");
      if (
        parked === "ask" &&
        itemId &&
        (await askAboutSlowCi(this.db, itemId, { checks: waiting.message, now: this.now() }))
      ) {
        await this.flush();
        return;
      }
      const item = itemId ? await this.store.run((q) => getWorkItemSteps(q, itemId)) : null;
      if (item)
        await this.fail(
          item,
          "merge",
          withAcceptedBranch(`merge timed out waiting for GitHub: ${waiting.message}`, item),
        );
    });
    jobs.register(JOB_KIND.queueConflicts, async (job, context) => {
      const sweep = queueConflictSweep(job.payload);
      if (sweep === null || !context.isCurrent()) return;
      await returnQueuedConflicts(this.db, this.store, sweep, {
        ask,
        restart: (item, handoff) => this.restartWithStoredFeedback(item, handoff),
        now: () => this.now(),
        session: (item) => this.activitySession(item),
        voice: {
          thought: (item, body, key) => this.post(item, "thought", body, key),
          flush: () => this.flush(),
        },
        readPull: (item, pullNumber) => this.readItemPull(item, pullNumber, context.signal),
      });
    });
    jobs.register(JOB_KIND.closeStoppedPull, async (job, context) => {
      const itemId = readString(job.payload, "itemId");
      const comment = readString(job.payload, "comment");
      const item = itemId ? await this.store.run((q) => getWorkItemSteps(q, itemId)) : null;
      if (
        !item ||
        item.state !== "cancelled" ||
        (await this.store.run((q) => getConfirmedRemoteMergeSteps(q, item.id)))
      )
        return;
      // A re-delegation that took over the branch owns its pull request now.
      if (await this.store.run((q) => itemContinuedSteps(q, item.id))) return;
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
        ...(comment ? { comment } : {}),
      });
    });
    jobs.register(JOB_KIND.pullReview, async (job, context) => {
      const reviewId = (job.payload as { reviewId?: unknown }).reviewId;
      if (typeof reviewId !== "number" || !context.isCurrent()) return;
      let reviewWait: ReviewCheckWait | null | undefined;
      const step = await handlePullReview(this.db, reviewId, {
        ...this.pullFeedbackCapabilities(context.signal),
        noteReviewWait: (wait) => {
          reviewWait = wait;
        },
      });
      if (step === "wait" && context.isCurrent())
        await waitForMergeTurn(
          this.db,
          withReviewWait(job, reviewWait),
          this.now(),
          PULL_REVIEW_POLL_MS,
        );
    });
    jobs.register(JOB_KIND.linearComments, async (job, context) => {
      const itemId = (job.payload as { linearCommentsFor?: unknown }).linearCommentsFor;
      const policy = this.options.linearComments;
      if (typeof itemId !== "string" || policy === undefined || !context.isCurrent()) return;
      const step = await deliverLinearComments(
        this.db,
        itemId,
        this.linearCommentCapabilities(policy, context.signal),
      );
      if (step === "wait" && context.isCurrent())
        await waitForMergeTurn(this.db, job, this.now(), PULL_REVIEW_POLL_MS);
    });
    jobs.register(JOB_KIND.pullComments, async (job, context) => {
      const itemId = (job.payload as { pullCommentsFor?: unknown }).pullCommentsFor;
      if (typeof itemId !== "string" || !context.isCurrent()) return;
      let reviewWait: ReviewCheckWait | null | undefined;
      const step = await handlePullComments(this.db, itemId, {
        ...this.pullFeedbackCapabilities(context.signal),
        noteReviewWait: (wait) => {
          reviewWait = wait;
        },
      });
      if (step === "wait" && context.isCurrent())
        await waitForMergeTurn(
          this.db,
          withReviewWait(job, reviewWait),
          this.now(),
          PULL_REVIEW_POLL_MS,
        );
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

  /** GitHub and Linear for a review or comments on the item's pull request. */
  private pullFeedbackCapabilities(signal?: AbortSignal): PullReviewCapabilities {
    return {
      now: () => this.now(),
      busy: async (item) =>
        this.jobContexts.has(item.id) ||
        (await this.store.run((q) => hasLiveJobSteps(q, item.id, this.now()))),
      threads: async (item, pullNumber) => {
        const repository = this.repositoryForItem(item);
        const github = repository ? this.githubForRepository(repository) : null;
        if (!repository || !github) return [];
        return readReviewThreads({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          prNumber: pullNumber,
          ...this.gitHubCredentials(github),
        });
      },
      pullHead: async (item, pullNumber) => {
        const repository = this.repositoryForItem(item);
        const github = repository ? this.githubForRepository(repository) : null;
        if (!repository || !github) return null;
        const pull = await readPullMergeable({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          prNumber: pullNumber,
          reads: 1,
          ...this.gitHubCredentials(github),
          ...(signal ? { signal } : {}),
        });
        return pull?.head ?? null;
      },
      pullConflict: async (item, pullNumber) => {
        const repository = this.repositoryForItem(item);
        const github = repository ? this.githubForRepository(repository) : null;
        if (!repository || !github) return null;
        const pull = await readPullMergeable({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          prNumber: pullNumber,
          reads: 1,
          ...this.gitHubCredentials(github),
          ...(signal ? { signal } : {}),
        }).catch(() => null);
        if (pull?.merges !== "conflict") return null;
        const base = await this.fetchUpstreamMain(item).catch(() => null);
        return base === null ? null : { head: pull.head, base };
      },
      leaveMergeQueue: async (item, pullNumber) => {
        const repository = this.repositoryForItem(item);
        const github = repository ? this.githubForRepository(repository) : null;
        if (!repository || !github) return "not_queued";
        return leaveGitHubMergeQueue({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          prNumber: pullNumber,
          ...this.gitHubCredentials(github),
          ...(signal ? { signal } : {}),
        });
      },
      fixRoundLimit: (item) => this.fixRoundLimit(item),
      closeoutFindings: async (item) => {
        await this.pullCloseoutEvidence(item);
        const started = await this.store.run((q) => closeoutHeadsStartedSteps(q, item.id));
        try {
          return await storedReviewFindings(
            itemPathId(item),
            (head) => started.get(head) ?? 0,
            this.options.pawsRoot,
          );
        } catch (error) {
          journalCaught(
            error,
            "orchestrator.pullFeedbackCapabilities.closeoutFindings",
            item.id,
            "the handoff leaves out Closeout's findings",
            this.options.journal,
          );
          return [];
        }
      },
      session: (item) => this.activitySession(item),
      flush: () => this.flush(),
      reviewChecks: async (item, pullNumber, since) => {
        const repository = this.repositoryForItem(item);
        const github = repository ? this.githubForRepository(repository) : null;
        if (!repository || !github) return null;
        const pull = await readPullMergeable({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          prNumber: pullNumber,
          reads: 1,
          ...this.gitHubCredentials(github),
          ...(signal ? { signal } : {}),
        });
        const maxMs = this.feedbackWait().reviewMaxMs ?? PULL_REVIEW_CHECK_MAX_WAIT_MS;
        if (!pull) return { head: null, pending: null, until: since + maxMs };
        let configured: string[] = [];
        try {
          configured = reviewApps(this.readMergePolicy(), `${repository.owner}/${repository.repo}`);
        } catch (error) {
          journalCaught(
            error,
            "orchestrator.pullFeedbackCapabilities.reviewApps",
            item.id,
            undefined,
            this.options.journal,
          );
        }
        return readReviewChecks(this.store, {
          owner: repository.owner,
          repo: repository.repo,
          head: pull.head,
          configured,
          maxMs,
          since,
          checkRuns: (head) =>
            readHeadCheckRuns({
              client: github.client,
              owner: repository.owner,
              repo: repository.repo,
              head,
              ...this.gitHubCredentials(github),
              ...(signal ? { signal } : {}),
            }),
        });
      },
    };
  }

  private async mergeAttempt(
    job: Job,
    context: JobContext,
    onWait: (wait: MergeWait | undefined) => void,
  ): Promise<void> {
    await this.failOnLastAttempt(job, context, "merge", () =>
      this.runLeasedJob(job, context, async () => {
        try {
          await this.runOwnedJob(job.payload, async () => {
            const step = await this.merge(job.payload, job.id);
            if (step.kind === "wait") onWait(step);
            else await this.settleMerge(job.payload, step);
          });
        } catch (error) {
          if (await this.sendBackAfterServerError(job.payload, error, context)) return;
          if (!(error instanceof LinearReconciliationPendingError)) throw error;
          journalCaught(
            error,
            "orchestrator.mergeAttempt.runOwnedJob",
            readString(job.payload, "itemId"),
            undefined,
            this.options.journal,
          );
          const { inserted } = await this.store.transaction((q) =>
            this.mergeReconciliationSteps(q, job, context),
          );
          if (inserted) emitJobReady(this.store);
        }
      }),
    );
  }

  private *mergeReconciliationSteps(q: Q, job: Job, context: JobContext) {
    if (!context.isCurrent()) throw context.signal.reason;
    const item = yield* getWorkItemSteps(q, readString(job.payload, "itemId")!);
    return yield* enqueueJobOnceSteps(q, {
      queue: item?.state === "verifying" ? JOB_KIND.reverify : job.queue,
      priority: job.priority,
      payload: job.payload,
      jobKey: `merge-reconciliation:${job.id}`,
      now: this.now(),
      runAt: this.now() + 30000,
    });
  }

  /**
   * GitHub answered the merge attempt with a 5xx. A pull request that conflicts with main gets the
   * same answer on every retry, so one `mergeable` read decides: a conflict goes back to rebase
   * instead of retrying. False leaves the retry as it was.
   */
  private async sendBackAfterServerError(
    payload: unknown,
    error: unknown,
    context: JobContext,
  ): Promise<boolean> {
    if (!(error instanceof GitHubHttpError) || error.status < 500 || !context.isCurrent())
      return false;
    const itemId = readString(payload, "itemId");
    const item = itemId ? await this.store.run((q) => getWorkItemSteps(q, itemId)) : null;
    const pull = item ? await this.store.run((q) => getItemPullRequestSteps(q, item.id)) : null;
    if (!item || item.state !== "merge_queue" || pull === null) return false;
    const read = await this.readItemPull(item, pull.pullNumber, context.signal, 1).catch(
      () => null,
    );
    if (read === null || !read.open || read.merges !== "conflict") return false;
    const found = `merge attempt got ${error.message}; pull request #${pull.pullNumber} at ${read.head.slice(0, 7)}`;
    if (await this.sendBackForConflict(item, read.head, found)) return true;
    const base = await this.fetchUpstreamMain(item).catch(() => null);
    const budget = rebaseBudgetFor(this.db, item.id, { base, files: null }, this.now());
    if (
      budget.allowed ||
      !askMergeHelp(this.db, {
        itemId: item.id,
        body: `${budget.message} Reply with guidance to continue, or stop the task.`,
        reason: "rebase_budget_spent",
        now: this.now(),
        session: (current) => this.activitySession(current),
        ask,
      })
    )
      return false;
    this.options.journal?.(
      `item ${item.linearIdentifier} ${found}: the pull request conflicts with main and the rebase budget is spent. Asked for guidance.`,
    );
    await this.flush();
    return true;
  }

  private async readItemPull(
    item: WorkItemRecord,
    pullNumber: number,
    signal?: AbortSignal,
    reads?: number,
  ): Promise<PullMergeable | null> {
    const repository = this.repositoryForItem(item);
    const github = repository ? this.githubForRepository(repository) : null;
    if (!repository || !github) return null;
    return readPullMergeable({
      client: github.client,
      owner: repository.owner,
      repo: repository.repo,
      prNumber: pullNumber,
      ...(reads === undefined ? {} : { reads }),
      ...this.gitHubCredentials(github),
      ...(signal ? { signal } : {}),
    });
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
      const orderingKey = message.orderingKey;
      const itemId =
        readString(message.payload, "itemId") ??
        (await this.store.run((q) => workItemForSessionSteps(q, orderingKey)))?.id;
      const issueId =
        readString(message.payload, "linearIssueId") ??
        readString(message.payload, "issueId") ??
        undefined;
      if (
        message.op === "status" &&
        (!itemId ||
          !issueId ||
          !(await this.store.run((q) => getLinearTaskDelegationSteps(q, itemId, issueId)))
            ?.humanActorId)
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
    const storage = this.evidenceStorage();
    await deliverLinearOutbox(
      message,
      tracker,
      () => this.catchUpFn(),
      context,
      this.db,
      files && storage ? { files, ...storage } : undefined,
    );
  }

  private async executeRetried(job: Job, context: JobContext): Promise<void> {
    let capacityRun: { itemId: string; runId: string } | undefined;
    let capacityParked = false;
    try {
      await this.executeQueued(job.payload);
    } catch (error) {
      const itemId = readString(job.payload, "itemId");
      const item =
        itemId === null ? null : await this.store.run((q) => getWorkItemSteps(q, itemId));
      if (capacityWaitIn(error) && item?.currentRunId)
        capacityRun = { itemId: item.id, runId: item.currentRunId };
      if (
        this.shuttingDown ||
        !item ||
        !context.isCurrent() ||
        item.cancelRequested ||
        (item.state !== "running" && item.state !== "verifying" && item.state !== "recovering")
      )
        throw error;
      if (
        error instanceof RunnerSetupRequired &&
        (await this.holdForRunnerSetup(item, error.need))
      ) {
        journalCaught(
          error,
          "orchestrator.executeRetried.executeQueued",
          readString(job.payload, "itemId"),
          undefined,
          this.options.journal,
        );
        return;
      }
      const refused = repositoryRefusedIn(error);
      if (refused && (await this.askRunnerRepository(item, refused))) {
        journalCaught(
          error,
          "orchestrator.executeRetried.executeQueued",
          item.id,
          "asked which runner may take the repository",
          this.options.journal,
        );
        return;
      }
      const resetAt = usageResetAt(error);
      if (resetAt !== null) {
        const delayMs = Math.max(0, resetAt - this.now());
        this.settleItemAwake(item.id);
        await deferWorkItemAsync(this.store, item, {
          retry: retryCount(job.payload),
          delayMs,
          handoff: readString(job.payload, "handoff"),
          message: usageLimitNotice(
            (error as Error & { agent: string }).agent,
            resetAt,
            this.now(),
          ),
          now: this.now(),
        });
        journalCaught(
          error,
          "orchestrator.executeRetried.usageLimit",
          item.id,
          "waiting for the agent's usage limit to reset",
          this.options.journal,
        );
        return;
      }
      if (slotsBusy(error)) {
        this.settleItemAwake(item.id);
        await deferWorkItemAsync(this.store, item, {
          retry: retryCount(job.payload),
          delayMs: SLOTS_BUSY_RETRY_MS,
          handoff: readString(job.payload, "handoff"),
          message: null,
          now: this.now(),
        });
        journalCaught(
          error,
          "orchestrator.executeRetried.slotsBusy",
          item.id,
          "waiting for a runner slot",
          this.options.journal,
        );
        return;
      }
      const wait = await this.nextRunnerWait(job, error);
      if (wait) {
        // Settle the attempt before the park. The parked interval is waiting, not a lease expiry,
        // and the item keeps this run (PAS-898).
        this.settleItemAwake(item.id);
        if (
          waitForRunnerSlot(
            this.db,
            job,
            this.now(),
            this.runnerWaitMs(wait, job.queue === JOB_KIND.resume),
            wait,
          ) === "lost"
        )
          throw error;
        capacityParked = true;
        journalCaught(
          error,
          "orchestrator.executeRetried.executeQueued",
          readString(job.payload, "itemId"),
          undefined,
          this.options.journal,
        );
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      if (isTransient(error)) {
        const retry = retryCount(job.payload) + 1;
        if (retry > MAX_TRANSIENT_RETRIES && this.preparationFailures.has(error as object)) {
          await this.askPreparationHelp(
            item,
            `${PREPARATION_FAILED} after ${MAX_TRANSIENT_RETRIES} retries.\n${message}`,
          );
          journalCaught(
            error,
            "orchestrator.executeRetried.executeQueued",
            readString(job.payload, "itemId"),
            undefined,
            this.options.journal,
          );
          return;
        }
        if (retry > MAX_TRANSIENT_RETRIES) {
          await this.fail(
            item,
            "run_error",
            `Stopped after ${MAX_TRANSIENT_RETRIES} retries. ${message}`,
            error,
          );

          journalCaught(
            error,
            "orchestrator.executeRetried.executeQueued",
            readString(job.payload, "itemId"),
            undefined,
            this.options.journal,
          );
          return;
        }
        const delayMs = transientRetryDelayMs(retry, error, this.options.retryBaseMs);

        const diskFull = isHostDiskFull(error);
        if (diskFull) await this.noteHostDiskFull(item.id, error);
        this.settleItemAwake(item.id);
        await deferWorkItemAsync(this.store, item, {
          retry,
          delayMs,
          handoff: readString(job.payload, "handoff"),
          message: diskFull ? null : retryNote(message, delayMs),
          now: this.now(),
          ...(diskFull ? { lastError: message } : {}),
        });

        journalCaught(
          error,
          "orchestrator.executeRetried.executeQueued",
          readString(job.payload, "itemId"),
          undefined,
          this.options.journal,
        );
        return;
      }
      if (job.attempts >= job.maxAttempts)
        await this.fail(
          item,
          "run_error",
          `Stopped after ${job.attempts} attempts. ${message}`,
          error,
        );
      // A start is only claimed while its item is queued, so its retries continue as a resume.
      else if (job.queue === JOB_KIND.start && item.state === "running") {
        this.settleItemAwake(item.id);
        await deferWorkItemAsync(this.store, item, {
          retry: retryCount(job.payload),
          delayMs: transientRetryDelayMs(1, error, this.options.retryBaseMs),
          handoff: readString(job.payload, "handoff"),
          message: null,
          now: this.now(),
        });
        journalCaught(
          error,
          "orchestrator.executeRetried.startRetry",
          item.id,
          undefined,
          this.options.journal,
        );
        return;
      }
      throw error;
    } finally {
      if (
        capacityRun &&
        !capacityParked &&
        (await this.store.run((q) => getWorkItemSteps(q, capacityRun!.itemId)))?.currentRunId ===
          capacityRun.runId &&
        !(await this.store.run((q) => hasLiveJobSteps(q, capacityRun!.itemId, this.now(), job.id)))
      )
        await this.store.run((q) => closeActiveRunSteps(q, capacityRun!.runId, this.now(), "lost"));
    }
  }

  /**
   * Put the item back in the queue under a runner-setup hold and say once what is missing. The
   * scheduler skips held items, so nothing retries, times out or writes to Linear until the hold
   * ends. False when the item can no longer be held, so the caller retries as before.
   */
  private async holdForRunnerSetup(item: WorkItemRecord, need: RunnerSetupNeed): Promise<boolean> {
    const now = this.now();
    return await this.store.transaction((q) => this.holdForRunnerSetupSteps(q, item, need, now));
  }

  private *holdForRunnerSetupSteps(
    q: Q,
    item: WorkItemRecord,
    need: RunnerSetupNeed,
    now: number,
  ): Steps<boolean> {
    const current = yield* getWorkItemSteps(q, item.id);
    if (
      !current ||
      current.cancelRequested ||
      (current.state !== "running" && current.state !== "recovering")
    )
      return false;
    if (current.currentRunId !== null) {
      const run = yield* getRunSteps(q, current.currentRunId);
      if (run && (run.status === "active" || run.status === "provisioning"))
        yield* markRunSteps(q, run.id, "lost", now);
    }
    restart(this.db, current, { reason: "follow_up", body: "Retry runner setup.", now });
    this.recordRunnerSetupHold(current, need, now, current.currentRunId);
    return true;
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
      ownerUserId: itemOwnerUserId(this.db, current.id),
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
  private async checkRunnerSetup(ownerUserId: string): Promise<void> {
    const eligibleRunner = this.options.eligibleRunner;
    if (!eligibleRunner) return;
    const holds = await this.store.run((q) => listRunnerSetupHoldsSteps(q, ownerUserId));
    if (holds.length === 0) return;
    const config = loadConfigFile(join(this.options.pawsRoot, "config.toml"));
    const now = this.now();
    let resumed = false;
    for (const hold of holds) {
      const item = await this.store.run((q) => getWorkItemSteps(q, hold.itemId));
      if (!item || item.state !== "queued" || item.cancelRequested) continue;
      const runner = eligibleRunner(item.id, this.implementerAgent(item, config), now);
      if (!runner) continue;
      resumed =
        (await this.store.transaction((q) =>
          this.resumeRunnerSetupSteps(q, item.id, hold.since, runner.name, now),
        )) || resumed;
    }
    if (resumed) await this.dispatch();
  }

  private *resumeRunnerSetupSteps(
    q: Q,
    itemId: string,
    since: number,
    runnerName: string,
    now: number,
  ): Steps<boolean> {
    const current = yield* getWorkItemSteps(q, itemId);
    if (!current || current.state !== "queued" || current.cancelRequested) return false;
    if (!(yield* releaseRunnerSetupHoldSteps(q, current.id, now))) return false;
    this.options.journal?.(
      `item ${current.linearIdentifier} resumed: runner setup (${runnerName})`,
    );
    const sessionId = this.activitySession(current);
    if (sessionId !== null)
      yield* enqueueOutboxOnceSteps(q, {
        target: OUTBOX_ACTIVITY.target,
        op: OUTBOX_ACTIVITY.op,
        orderingKey: sessionId,
        idempotencyKey: `runner-setup-resume:${current.id}:${since}`,
        payload: {
          sessionId,
          itemId: current.id,
          kind: "thought",
          body: `Starting ${current.linearIdentifier ?? "this issue"} on ${runnerName}.`,
        },
        now,
      });
    return true;
  }

  private async askRunnerRepository(
    item: WorkItemRecord,
    refused: RunnerRepositoryRefused,
  ): Promise<boolean> {
    const now = this.now();
    const runnersUrl = this.options.runnersUrl ?? dashboardUrl("http://127.0.0.1:8787", "/runners");
    this.settleItemAwake(item.id);
    const asked = await this.store.transaction((q) =>
      this.askRunnerRepositorySteps(q, item.id, refused, runnersUrl, now),
    );
    if (!asked) return false;
    this.options.journal?.(`item ${item.linearIdentifier} asked: ${refused.message}`);
    void this.flush().catch((caught) => {
      journalCaught(
        caught,
        "orchestrator.askRunnerRepository.flush",
        item.id,
        undefined,
        this.options.journal,
      );
    });
    return true;
  }

  private *askRunnerRepositorySteps(
    q: Q,
    itemId: string,
    refused: RunnerRepositoryRefused,
    runnersUrl: string,
    now: number,
  ): Steps<boolean> {
    const current = yield* getWorkItemSteps(q, itemId);
    if (
      !current ||
      current.cancelRequested ||
      !["running", "verifying", "recovering"].includes(current.state)
    )
      return false;
    const sessionId = this.activitySession(current);
    if (sessionId === null) return false;
    if (current.currentRunId !== null) {
      const run = yield* getRunSteps(q, current.currentRunId);
      if (run && (run.status === "active" || run.status === "provisioning"))
        yield* markRunSteps(q, run.id, "lost", now);
    }
    ask(
      this.db,
      { itemId: current.id, runId: current.currentRunId, sessionId, version: current.version },
      "runner-repository",
      runnerRepositoryQuestion(refused.repository, refused.refusals, runnersUrl),
      {
        reason: RUNNER_REPOSITORY_REASON,
        options: [RUNNER_REPOSITORY_RETRY, RUNNER_REPOSITORY_STOP],
        now,
      },
    );
    return true;
  }

  private async checkRunnerRepositories(runnerId: string, answeredBy: string): Promise<void> {
    const allowedOn = this.options.repositoryAllowedOn;
    if (!allowedOn) return;
    const now = this.now();
    const seen = new Set<string>();
    const waiting = async () =>
      (await this.store.run(openRunnerRepositoryQuestionsSteps)).filter(
        (question) => !seen.has(question.id),
      );
    let answered = false;
    for (let batch = await waiting(); batch.length > 0; batch = await waiting())
      for (const question of batch) {
        seen.add(question.id);
        if (!allowedOn(question.itemId, runnerId, now)) continue;
        const outcome = answerAsked(
          this.db,
          {
            sessionId: question.sessionId,
            deliveryId: `runner-repository-allowed:${question.id}`,
            body: RUNNER_REPOSITORY_RETRY,
            answeredBy,
            now,
          },
          questionEffects(this.db, { now, maxAwakeMs: this.options.caps?.maxAwakeMs }),
        );
        answered = outcome.status === "answered" || answered;
      }
    if (answered) await this.dispatch();
  }

  private runnerSetupLine(need: RunnerSetupNeed): string {
    const url = this.options.runnersUrl ?? dashboardUrl("http://127.0.0.1:8787", "/runners");
    return need.reason === "no-runner"
      ? `You don't have a runner Paws can use yet. Create a VM or add a host here: ${url}. I'll start on my own once it's ready.`
      : `Your runner ${need.runnerName} needs ${runnerAgentName(need.agent)} signed in. Sign in on the [Runners page](${url}); I'll start right after.`;
  }

  private async nextRunnerWait(job: Job, caught: unknown): Promise<RunnerCapacityWaitState | null> {
    const error = capacityWaitIn(caught);
    if (!error) return null;
    const busy = error.runnerIds.length > 0;
    const previous = runnerCapacityWait(job.payload);
    // A busy runner is waited for without limit. Only a wait with no runner offered runs out, and
    // its clock starts when the runners stop being offered.
    const waited = previous && previous.runnerIds.length > 0 === busy ? previous : null;
    if (!busy && waited && this.now() - waited.since >= RUNNER_CAPACITY_WAIT_MS) return null;
    return {
      since: waited?.since ?? this.now(),
      attempt: waited ? waited.attempt + 1 : 0,
      runnerIds: error.runnerIds,
      online: waited?.online ?? (await this.store.run((q) => activeRunnerIdsSteps(q, this.now()))),
      ...(error.holdMs === undefined ? {} : { holdMs: error.holdMs }),
    };
  }

  private runnerWaitMs(wait: RunnerCapacityWaitState, recoveringResume = false): number {
    const baseMs = placementWaitMs(wait.attempt, this.options.placementPollMs);
    return recoveringResume ? baseMs - resumeRetrySpreadMs(baseMs, this.options.random) : baseMs;
  }

  private async waitingForConversation(
    job: Job,
    context: { isCurrent(): boolean },
  ): Promise<boolean> {
    const itemId = readString(job.payload, "itemId");
    const talk = itemId === null ? null : await this.options.conversations?.();
    if (!talk || (await talk.open(itemId!)).length === 0 || !context.isCurrent()) return false;
    await waitForMergeTurn(this.db, job, this.now(), PULL_REVIEW_POLL_MS);
    return true;
  }

  private async waitingForRunnerSlot(job: Job, beforePark?: () => Promise<Job>): Promise<boolean> {
    const waited = runnerCapacityWait(job.payload);
    const itemId = readString(job.payload, "itemId");
    const item = itemId === null ? null : await this.store.run((q) => getWorkItemSteps(q, itemId));
    if (
      !waited ||
      !item ||
      item.cancelRequested ||
      !["running", "recovering", "verifying", "merge_queue"].includes(item.state) ||
      this.shuttingDown ||
      (waited.runnerIds.length === 0 && this.now() - waited.since >= RUNNER_CAPACITY_WAIT_MS) ||
      this.now() - waited.since >= (waited.holdMs ?? Infinity)
    )
      return false;
    const runId = item.currentRunId ?? "";
    const runners = await this.store.run((q) => slotWaitRunnersSteps(q, runId, waited, this.now()));
    if (await this.store.run((q) => runnerSlotFreeSteps(q, runners, this.now(), runId)))
      return false;
    const next = { ...waited, attempt: waited.attempt + 1 };
    job = (await beforePark?.()) ?? job;
    const delayMs = this.runnerWaitMs(next, job.queue === JOB_KIND.resume);
    waitForRunnerSlot(this.db, job, this.now(), delayMs, next);
    return true;
  }

  /**
   * Parks a merge job whose push GitHub refused in a push outage, or that the outage held. The
   * item keeps its state and its work, and the attempt is not spent. False for any other error.
   */
  private async holdForPushOutage(job: Job, error: unknown): Promise<boolean> {
    const refused = pushOutageCause(error);
    const itemId = readString(job.payload, "itemId");
    const item =
      refused && itemId ? await this.store.run((q) => getWorkItemSteps(q, itemId)) : null;
    const repository = item ? this.repositoryForItem(item) : null;
    if (!refused || !item || !repository) return false;
    const github = this.githubForRepository(repository);
    const repositoryName = `${repository.owner}/${repository.repo}`;
    const outage = await pushRefused(this.db, {
      repository: repositoryName,
      error: refused,
      jobId: job.id,
      installationUrl: github ? installationSettingsUrl(github.installationId) : null,
      now: this.now(),
    });
    // The outage ended between the hold and now: look again shortly.
    if (outage === null) {
      if ((await waitForMergeTurn(this.db, job, this.now())) === "lost") throw error;
      return true;
    }
    if (!refused.held)
      journalCaught(
        error,
        "orchestrator.holdForPushOutage",
        item.id,
        `push outage on ${repositoryName}; the push waits`,
        this.options.journal,
      );
    const asked = (await askAboutPushOutage(this.db, repositoryName, this.now())) === "asked";
    if ((await parkForPushOutage(this.db, job, outage, this.now())) === "lost") throw error;
    if (asked) await this.flush();
    return true;
  }

  private async noteHostDiskFull(itemId: string | null, error: unknown): Promise<void> {
    if (itemId === null || !isHostDiskFull(error)) return;
    const item = await this.store.run((q) => getWorkItemSteps(q, itemId));
    const key = item && hostDiskFullThoughtKey(this.db, item.id, this.now());
    if (item && key) this.post(item, "thought", HOST_DISK_FULL_THOUGHT, key);
  }

  private pushWorked(repository: string): void {
    const ended = pushWorked(this.db, repository, this.now());
    if (ended) this.options.journal?.(`push outage on ${repository} ended`);
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
      const item =
        itemId === null ? null : await this.store.run((q) => getWorkItemSteps(q, itemId));
      if (
        job.attempts >= job.maxAttempts &&
        item &&
        // A push outage holds the item; it never fails it (PAS-867).
        !pushOutageCause(error) &&
        !this.shuttingDown &&
        context.isCurrent() &&
        !this.jobContexts.has(item.id) &&
        !item.cancelRequested &&
        (item.state === "verifying" || item.state === "merge_queue")
      ) {
        const message = error instanceof Error ? error.message : String(error);
        const accepted = item.state === "merge_queue" || item.checkpoint?.phase === "merge_queue";
        const text = `Stopped after ${job.attempts} attempts. ${message}`;
        await this.fail(item, reason, accepted ? withAcceptedBranch(text, item) : text, error);
      }
      throw error;
    }
  }

  private async executeQueued(payload: unknown): Promise<void> {
    if (this.shuttingDown) throw new Error("Paws is shutting down");
    const itemId = readString(payload, "itemId");
    if (itemId === null) return;
    const loaded = await this.store.run((q) => getWorkItemSteps(q, itemId));
    if (loaded === null) return;
    if (loaded.cancelRequested || loaded.state === "cancelled") return;
    if (loaded.state === "awaiting_input" || loaded.state === "paused") return;
    if ((await this.store.run((q) => restartHoldSteps(q, loaded))) !== null) return;
    const sessionId = loaded.sessionKey;
    if (sessionId && (await this.store.run((q) => getLinearSessionSteps(q, sessionId))))
      await this.store.transaction((q) => activateLinearItemSteps(q, sessionId, loaded.id));
    if (loaded.state === "queued")
      await this.store.transaction((q) => applyWorkItemEventSteps(q, loaded.id, "dispatched"));
    if (loaded.state === "recovering")
      await this.store.transaction((q) => applyWorkItemEventSteps(q, loaded.id, "recovered"));
    let item = await this.store.run((q) => getWorkItemSteps(q, loaded.id));
    if (item === null || item.state !== "running") return;

    {
      const handoff = readString(payload, "handoff") ?? undefined;
      if (this.options.linearTaskModes && item.sessionKey) {
        if (!(await this.resolveTaskMode(item, handoff))) return;
        item = await this.store.run((q) => getWorkItemSteps(q, loaded.id));
        if (!item || item.state !== "running" || item.cancelRequested) return;
        const mode = await this.store.run((q) => getTaskModeSteps(q, loaded.id));
        if (isResponseTaskMode(mode)) {
          if (
            (await this.store.run((q) => taskRequiresRepositorySteps(q, loaded.id))) &&
            !(await this.selectRepository(item, "read"))
          )
            return;
          await this.runResponse(item, mode, handoff);
          return;
        }
      }
      if (!(await this.selectRepository(item))) return;
      const refused = this.options.repositoryRefusals?.(item.id, this.now());
      if (refused) throw new RunnerRepositoryRefused(refused.repository, refused.refusals);
      // A rule matches the issue's labels as they are when the task starts.
      await this.mergeSettingsFor(item, this.signalForItem(item.id)).catch((caughtError3) => {
        journalCaught(
          caughtError3,
          "orchestrator.executeQueued.mergeSettingsFor",
          itemId,
          undefined,
          this.options.journal,
        );
        return undefined;
      });
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

  private async repositoryBeforeSelection(item: WorkItemRecord): Promise<RepositoryBinding | null> {
    const bound = this.repositoryForItem(item);
    if (bound) return bound;
    const candidates = listRepositoryCandidates(
      this.db,
      item.sessionKey,
      this.options.repositories ?? [],
    );
    if (candidates.length === 1) return candidates[0]!;
    if (candidates.length === 0 || !this.tracker?.issueRepositoryHints) return null;
    const kept = (await this.store.run((q) =>
      getTaskLinearReadSteps(q, item.id, "repository_hints"),
    )) as RepositoryHints | undefined;
    const hints =
      kept ??
      (await linearCaller("repository-hints", () =>
        this.tracker!.issueRepositoryHints!(item.linearIssueId, {
          signal: this.authRecoveryController.signal,
        }),
      ));
    if (kept === undefined)
      await this.store.run((q) =>
        keepTaskLinearReadSteps(q, item.id, "repository_hints", hints, this.now()),
      );
    const hinted = hintedRepository(candidates, hints);
    return hinted && "bind" in hinted ? hinted.bind : null;
  }

  private async hasOpenPawsPull(item: WorkItemRecord): Promise<boolean> {
    try {
      const repository = await this.repositoryBeforeSelection(item);
      const github = repository ? this.githubForRepository(repository) : null;
      if (!repository || !github) return false;
      return await hasOpenPullOnPrefix({
        client: github.client,
        owner: repository.owner,
        repo: repository.repo,
        prefix: `paws/${item.linearIdentifier.toLowerCase()}-`,
        ...this.gitHubCredentials(github),
        signal: AbortSignal.any([this.authRecoveryController.signal, AbortSignal.timeout(10_000)]),
      });
    } catch (error) {
      journalCaught(
        error,
        "orchestrator.hasOpenPawsPull",
        item.id,
        undefined,
        this.options.journal,
      );
      return false;
    }
  }

  private async resolveTaskMode(item: WorkItemRecord, handoff?: string): Promise<boolean> {
    if ((await this.store.run((q) => getConversationSteps(q, item.id))).blocked)
      throw new Error("ACP process cleanup could not be verified");
    const saved = await this.store.run((q) => getTaskModeSteps(q, item.id));
    const sessionKey = item.sessionKey;
    const sessionGeneration = (key: string) =>
      this.store.run((q) => getLinearSessionGenerationSteps(q, key));
    const generation = sessionKey ? await sessionGeneration(sessionKey) : 0;
    const taskKey = this.parentTaskKey(item);
    let classification = taskKey
      ? await this.store.run((q) => getTaskClassificationSteps(q, taskKey))
      : null;
    const delegatedIssueId = await this.delegationIssueId(item);
    if (!saved && !classification && taskKey && sessionKey && delegatedIssueId) {
      if (await this.hasOpenPawsPull(item)) {
        if (this.stopped(item.id) || (await sessionGeneration(sessionKey)) !== generation)
          return false;
        await this.store.transaction((q) =>
          saveTaskModeSteps(q, item.id, "code", generation, false),
        );
        return true;
      }
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
    }
    if (taskKey && classification?.mode === "code" && classification.redirect) {
      await this.intakeLinearTask((await this.delegationIssueId(item))!, item.sessionKey, taskKey);
      await this.dispatch();
      return false;
    }
    // Code stays code, and a plan stays a plan through its edits and questions.
    if (saved === "code" || saved === "plan") return true;
    if (
      saved &&
      (await this.store.run((q) => taskRequiresRepositorySteps(q, item.id))) &&
      getWorkItemRepositoryAnswer(this.db, item.id) &&
      !(await this.store.run((q) => getWorkItemRepositorySteps(q, item.id)))
    )
      return true;
    if (
      saved &&
      (!handoff ||
        (await this.store.run((q) => getTaskModeGenerationSteps(q, item.id))) >= generation)
    )
      return true;
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
    const run = await this.ensureRun(item);
    if (!(await this.checkProfileLabels(item, run.id))) return false;
    if (!handoff) {
      if (classification?.mode !== "clarify") throw new Error("Task clarification is missing");
      return this.requestTaskClarification(item, run.id, classification.question);
    }
    const live = await this.beginLive(item.id, run.id);
    const controller = live.controller;
    try {
      const resolved = await classifyTask({
        itemId: itemPathId(item),
        runId: run.id,
        request: [
          this.workContext(item),
          (await this.store.run((q) => getConversationSteps(q, item.id))).entries,
          handoff,
        ].join("\n\n"),
        pawsRoot: this.options.pawsRoot,
        home: this.options.home,
        profile: this.profileSnapshot(run.id).implementer,
        signal: controller.signal,
        launch: (input) => this.launchAgent(input),
        agentRunner: this.helperRunner(item.sessionKey, "classify"),
        onCleanupFailure: () => this.blockConversation(item.id),
      });
      controller.signal.throwIfAborted();
      if (
        this.stopped(item.id) ||
        (sessionKey && (await sessionGeneration(sessionKey)) !== generation)
      )
        return false;
      if (resolved.mode === "clarify")
        return this.requestTaskClarification(item, run.id, resolved.question);
      if (
        resolved.mode === "code" &&
        (classification?.mode === "clarify" || saved === "answer" || saved === "artifact") &&
        taskKey
      ) {
        const issueId = (await this.delegationIssueId(item))!;
        const snapshot = await this.tracker!.loadEpic(issueId);
        controller.signal.throwIfAborted();
        if (
          this.stopped(item.id) ||
          (sessionKey && (await sessionGeneration(sessionKey)) !== generation)
        )
          return false;
        if (snapshot.subIssues.length) {
          await this.store.transaction((q) =>
            resolveTaskClassificationSteps(q, {
              taskKey,
              itemId: item.id,
              context: [this.workContext(item), handoff].join("\n\n"),
            }),
          );
          await this.intakeLinearTask(issueId, item.sessionKey, taskKey);
          await this.dispatch();
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
      else
        await this.store.transaction((q) =>
          saveTaskModeSteps(q, item.id, resolved.mode, generation, resolved.repository === true),
        );
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
    await this.store.transaction((q) =>
      this.requestTaskClarificationSteps(q, item, runId, sessionId, body),
    );
    await this.flush();
    return false;
  }

  private *requestTaskClarificationSteps(
    q: Q,
    item: WorkItemRecord,
    runId: string,
    sessionId: string,
    body: string,
  ): Steps<void> {
    const current = yield* getWorkItemSteps(q, item.id);
    if (current?.state !== "running" || current.cancelRequested)
      throw new Error("The task changed before clarification");
    ask(
      this.db,
      { itemId: item.id, runId, sessionId, version: item.version },
      "clarification",
      body,
      {
        now: this.now(),
      },
    );
    yield* closeActiveRunSteps(q, runId, this.now());
  }

  private async runResponse(
    item: WorkItemRecord,
    mode: ResponseTaskMode,
    handoff?: string,
  ): Promise<void> {
    const run = await this.ensureRun(item);
    if (!(await this.checkProfileLabels(item, run.id))) return;
    item = (await this.store.run((q) => getWorkItemSteps(q, item.id)))!;
    const profile = this.profileSnapshot(run.id).implementer;
    const live = await this.beginLive(item.id, run.id);
    const controller = live.controller;
    const workspace = join(this.options.pawsRoot, "tasks", item.id, mode);
    mkdirSync(workspace, { recursive: true, mode: 0o700 });
    const sessionProgress = this.sessionProgress(item, mode);
    sessionProgress?.phase("working");
    const activity = createAcpActivityReporter(
      (update, origin) => {
        if (
          !controller.signal.aborted &&
          this.canReportProgress(item.id) &&
          update.kind !== "elicitation"
        )
          this.post(
            item,
            update.kind,
            update.body,
            this.activityKey(`${run.id}:answer`, origin),
            update,
          );
      },
      (steps) => {
        if (!controller.signal.aborted && !this.stopped(item.id)) sessionProgress?.plan(steps);
      },
    );
    const keepAlive = setInterval(() => {
      if (this.canReportProgress(item.id)) {
        this.postKeepalive(item, `${run.id}:keep:${this.now()}`, [
          sessionProgress?.keepalive(live.progress),
          sessionProgress?.keepalive(null),
          "Preparing the requested answer.",
        ]);
        void this.flush();
      }
    }, KEEPALIVE_MS);
    keepAlive.unref?.();
    try {
      await this.taskAccess()?.assert(item, controller.signal, { allowTerminalIssue: true });
      const promptRunner = await this.prepareConversation(item);
      let repositoryContext = "";
      if (await this.store.run((q) => taskRequiresRepositorySteps(q, item.id))) {
        const repository = await this.store.run((q) => getWorkItemRepositorySteps(q, item.id));
        if (repository === null) throw new Error("The requested repository has not been selected");
        const auth = this.authorization(item);
        if (auth && !(await auth.ensure(item, "initial", controller.signal))) return;
        const hidden = this.runCheckout(item).agent;
        const source = await prepareRepositorySnapshot({
          ...repository,
          checkoutExclusions: hidden,
          workspace,
          networkGit: await this.repositoryGit(item, repository, controller.signal, "read"),
          signal: controller.signal,
          onCleanupFailure: () => this.blockConversation(item.id),
        });
        controller.signal.throwIfAborted();
        repositoryContext = [
          `The selected repository ${repository.owner}/${repository.repo} is available in ./repository at commit ${source.commit}. Use this private source snapshot for the requested explanation or deliverable. Publish deliverable paths relative to this workspace and return the complete answer or file links.`,
          ...(hidden.length ? [hiddenPathsPrompt(hidden)] : []),
        ].join("\n");
      }
      await this.hydrateLinearContext(item.sessionKey, controller.signal);
      const responseComments = this.linearCommentBrief(item);
      const prompt = [
        mode === "answer"
          ? "Answer the user's request in this Linear conversation. Provide the complete answer in your final message."
          : mode === "plan"
            ? PLAN_PROMPT
            : "Create the requested deliverable files in this workspace, publish them using publish_artifact, and include the published file links in your complete final response.",
        "Use ask_team when a product decision is required.",
        "Call update_plan with the full working checklist whenever the steps or their statuses change. Statuses are pending, inProgress, completed, and canceled.",
        POST_UPDATE_PROMPT,
        repositoryContext,
        this.workContext(item),
        handoff ?? "",
        responseComments?.text ?? "",
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
      const turn = async (text: string, comments: LinearCommentBrief | null) => {
        const result = await promptRunner({
          ...launched,
          role: "implementer",
          profile,
          itemId: itemPathId(item),
          runId: run.id,
          worktreePath: workspace,
          pawsRoot: this.options.pawsRoot,
          home: this.options.home,
          prompt: text,
          readOnly: isReadOnlyTaskMode(mode),
          publishArtifact: mode === "artifact" ? this.artifactPublisher(item) : undefined,
          checkpoint: false,
          signal: controller.signal,
          askTeam: this.askHook(item, run.id),
          updatePlan: this.planHook(item, sessionProgress),
          postUpdate: this.updateHook(item),
          prepareInputFiles: this.prepareInputFiles(item, run.id),
          onEvent: activity.onEvent,
        });
        if (result.stopReason === "end_turn" || this.askedRuns.has(run.id))
          this.settleLinearCommentBrief(item, comments);
        controller.signal.throwIfAborted();
        if (this.stopped(item.id) || this.askedRuns.has(run.id)) return false;
        if (
          result.stopReason !== "end_turn" ||
          result.authRequired ||
          !result.agentExited ||
          result.errorMessage
        )
          throw new Error(result.errorMessage ?? `Answer stopped (${result.stopReason})`);
        return true;
      };
      if (!(await turn(prompt, responseComments))) return;
      for (let extra = 0; extra < RESPONSE_COMMENT_TURNS; extra++) {
        const later = this.linearCommentBrief(item);
        if (later === null) break;
        const again = [later.text, RESPONSE_COMMENT_PROMPT[mode]].join("\n\n");
        if (!(await turn(again, later))) return;
      }
      activity.flush();
      if (mode === "plan") {
        await this.proposePlan(item, run.id, activity.resultBody());
        return;
      }
      const finish = { runId: run.id, announce: () => sessionProgress?.phase("completed") };
      if (mode === "artifact") {
        const links = (await this.store.run((q) => listArtifactsSteps(q, item.id)))
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
      await this.dispatch();
    } catch (error) {
      if (
        !this.askedRuns.has(run.id) &&
        !this.stopped(item.id) &&
        !controller.signal.aborted &&
        (await this.store.run((q) => getWorkItemSteps(q, item.id)))?.state !== "awaiting_input"
      ) {
        if (isTransient(error)) throw error;
        await this.fail(
          item,
          "answer_error",
          error instanceof Error ? error.message : String(error),
          error,
        );
      }

      journalCaught(
        error,
        "orchestrator.runResponse.assert",
        live.itemId,
        undefined,
        this.options.journal,
      );
    } finally {
      clearInterval(keepAlive);
      await this.releaseAskedRun(run.id);
      this.live.delete(run.id);
      live.finish();
      await this.flush();
    }
  }

  /**
   * Ask to file the drafts a plan turn proposed. The elicitation carries the
   * proposal and its Create, Edit and Discard options; the drafts are stored
   * under the question id, which keys the filing.
   */
  private async proposePlan(item: WorkItemRecord, runId: string, body: string): Promise<void> {
    const plan = parsePlanResult(body);
    const sessionId = this.activitySession(item);
    if (!sessionId) throw new Error("A plan proposal requires a Linear session");
    const parentIssueId = (await this.delegationIssueId(item)) ?? item.linearIssueId;
    const repository = await this.store.run((q) => getWorkItemRepositorySteps(q, item.id));
    await this.store.transaction((q) =>
      this.proposePlanSteps(q, item, runId, sessionId, parentIssueId, repository, plan),
    );
    await this.flush();
  }

  private *proposePlanSteps(
    q: Q,
    item: WorkItemRecord,
    runId: string,
    sessionId: string,
    parentIssueId: string,
    repository: RepositoryBinding | null,
    plan: ReturnType<typeof parsePlanResult>,
  ): Steps<void> {
    const current = yield* getWorkItemSteps(q, item.id);
    if (current?.state !== "running" || current.cancelRequested || current.currentRunId !== runId)
      throw new Error("The task changed before its plan could be proposed");
    const asked = ask(
      this.db,
      { itemId: item.id, runId, sessionId, version: current.version },
      "plan-approval",
      planProposalBody(item.linearIdentifier, plan),
      { options: planOptions(plan.drafts.length), now: this.now() },
    );
    yield* savePlanProposalSteps(q, {
      questionId: asked.question.id,
      itemId: item.id,
      parentIssueId,
      repository: repository ? `${repository.owner}/${repository.repo}` : null,
      drafts: plan.drafts,
      now: this.now(),
    });
    yield* closeActiveRunSteps(q, runId, this.now());
  }

  private async runItem(item: WorkItemRecord, handoff?: string): Promise<void> {
    const repository = this.repositoryForItem(item);
    if (repository === null || repository === undefined) {
      await this.fail(item, "no_repository", "No repository is selected for this item.");
      return;
    }
    if (this.stopped(item.id)) return;
    const pathId = itemPathId(item);
    const branch = worktreeBranch(item);
    if (item.branchName !== branch) {
      await this.store.run((q) => setItemBranchNameSteps(q, item.id, branch));
    }
    const run = await this.ensureRun(item);
    if (!(await this.checkProfileLabels(item, run.id))) return;
    item = (await this.store.run((q) => getWorkItemSteps(q, item.id)))!;
    const profiles = this.profileSnapshot(run.id);
    const live = await this.beginLive(item.id, run.id);
    const controller = live.controller;
    let posted = true;
    const sessionProgress = this.sessionProgress(item);
    const first = setTimeout(() => {
      if (posted || !this.canReportProgress(item.id)) return;
      posted = true;
      const working = `Working on ${item.linearIdentifier}.`;
      this.post(
        item,
        "thought",
        sessionProgress?.keepalive(working) ?? working,
        `${run.id}:first`,
        {
          ephemeral: true,
        },
      );
      void this.flush();
    }, FIRST_ACTIVITY_MS);
    const keepAlive = setInterval(() => {
      if (this.live.get(run.id) !== live || !this.canReportProgress(item.id)) return;
      this.postKeepalive(item, `${run.id}:keep:${this.now()}`, [
        sessionProgress?.keepalive(live.progress) ?? live.progress,
        sessionProgress?.keepalive(null),
        `Working on ${item.linearIdentifier}.`,
      ]);
      void this.flush();
    }, KEEPALIVE_MS);
    first.unref?.();
    keepAlive.unref?.();
    const askTeam = this.askHook(item, run.id);
    const activity = createAcpActivityReporter(
      (update, origin) => {
        if (
          controller.signal.aborted ||
          !this.canReportProgress(item.id) ||
          update.kind === "elicitation"
        )
          return;
        posted = true;
        this.post(
          item,
          update.kind,
          update.body,
          this.activityKey(`${run.id}:acp`, origin),
          update,
        );
      },
      (steps) => {
        if (!controller.signal.aborted && !this.stopped(item.id)) sessionProgress?.plan(steps);
      },
    );
    let deferred = false;
    let capacityWaiting = false;

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
      const returned = await this.store.run((q) => latestRestartEventSteps(q, item.id));
      const fixing =
        returned !== null && ["findings", "ci", "review", "conflict"].includes(returned.reason);
      if (!fixing) sessionProgress?.phase("implementing");
      if (fixing) {
        const round = await this.store.run((q) => fixRoundsSteps(q, item.id));
        const limit = this.fixAttemptLimit(item, returned.reason);
        const label =
          returned.reason === "ci"
            ? "CI"
            : returned.reason === "review"
              ? "review findings"
              : returned.reason === "conflict"
                ? "merge conflicts"
                : "Closeout findings";
        const counter = returned.reason === "conflict" ? "" : ` (${round} of ${limit})`;
        sessionProgress?.restart(returned.reason, round, returned.version, limit);
        sessionProgress?.restartWait(`${item.linearIdentifier}: fixing ${label}${counter}`);
        live.progress =
          returned.reason === "conflict"
            ? `Resolving merge conflicts for ${item.linearIdentifier}.`
            : `Fixing ${label} for ${item.linearIdentifier}, fix attempt ${round} of ${limit}.`;
        this.post(item, "thought", live.progress, `${item.id}:fix:${item.version}`);
      }
      if (working !== undefined) await this.startPost(working);
      if (!this.taskAccess()) this.postStatus(item, "started");
      const promptRunner = await this.prepareConversation(item);
      await this.hydrateLinearContext(item.sessionKey, controller.signal);
      const checkout = this.runCheckout(item);
      const comments = this.linearCommentBrief(item);
      const suggestions = returned === null ? "" : await this.suggestionBrief(item, repository);
      const turnHandoff = [handoff, comments?.text, suggestions]
        .filter((part) => part)
        .join("\n\n");
      const focus = await closeoutFocus(this.store, item.id, returned?.reason);
      const draft = this.savedDraft(item.id);
      const prompt = implementPrompt({
        identifier: item.linearIdentifier,
        title: item.title,
        brief: this.workContext(item),
        hiddenPaths: checkout.agent,
        ...(turnHandoff ? { handoff: turnHandoff } : {}),
        ...(item.continuesBranch ? { continuesBranch: item.continuesBranch } : {}),
        ...(focus ? { closeoutFocus: focus } : {}),
      });
      await this.flush();
      if (this.stopped(item.id)) return;
      try {
        if (!this.readProfileSnapshot(run.id)?.candidate)
          await this.preflight(item, run.id, profiles, controller.signal, activity.onEvent);
      } catch (error) {
        if (
          this.stopped(item.id) ||
          (await this.store.run((q) => getWorkItemSteps(q, item.id)))?.state === "awaiting_input"
        )
          return;
        if (isTransient(error)) {
          // A temporary failure before the agent starts retries with backoff. A person is asked
          // only once the retries are spent.
          if (typeof error === "object" && error !== null) this.preparationFailures.add(error);
          throw error;
        }
        journalCaught(
          error,
          "orchestrator.runItem.preflight",
          live.itemId,
          undefined,
          this.options.journal,
        );
        await this.store.run((q) => closeActiveRunSteps(q, run.id, this.now()));
        const summary = `Closeout: blocked\n${error instanceof Error ? error.message : String(error)}`;
        this.post(item, "thought", summary, `${run.id}:profile-preflight`);
        await this.askCloseoutHelp(item, undefined, summary);
        return;
      }
      if (returned !== null)
        await this.fetchUpstreamMain(item).catch((caughtError) =>
          journalCaught(
            caughtError,
            "orchestrator.runItem.fetchUpstreamMain",
            live.itemId,
            undefined,
            this.options.journal,
          ),
        );
      const launched = this.launchAgent({
        role: "implementer",
        profile: profiles.implementer,
        purpose: returned?.reason === "findings" ? "fix" : "implement",
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
        networkGit: await this.repositoryGit(item, repository, controller.signal, "write"),
        pawsRoot: this.options.pawsRoot,
        home: this.options.home ?? homedir(),
        checkoutExclusions: checkout.agent,
        ...(worktreeStartRef(item) ? { startRef: worktreeStartRef(item) } : {}),
        ...(this.options.remoteExecution ? { workspace: this.runnerWorkspace(run.id) } : {}),
        signal: controller.signal,
        promptRunner,
        askTeam,
        updatePlan: this.planHook(item, sessionProgress),
        pullRequest: this.pullRequestHook(item),
        postUpdate: this.updateHook(item),
        reply: this.replyHook(item),
        publishArtifact: this.artifactPublisher(item),
        closeoutProgress: this.agentCloseoutHook(item, run.id),
        ...(focus ? { closeoutFocus: focus } : {}),
        ...(draft ? { pullRequestDraft: draft } : {}),
        prepareInputFiles: this.prepareInputFiles(item, run.id),
        onEvent: activity.onEvent,
        ...(launched.command ? { command: launched.command, args: launched.args ?? [] } : {}),
        ...(launched.env ? { env: launched.env } : {}),
        ...(launched.cancelGraceMs !== undefined ? { cancelGraceMs: launched.cancelGraceMs } : {}),
      });
      if (executed.run.stopReason === "end_turn" || this.askedRuns.has(run.id))
        this.settleLinearCommentBrief(item, comments);
      this.assertJobCurrent(item.id);
      controller.signal.throwIfAborted();
      const finished = await this.store.run((q) => getWorkItemSteps(q, item.id));
      if (finished === null || finished.state === "cancelled" || finished.cancelRequested) return;
      if (executed.run.authRequired) {
        await this.fail(finished, "auth", executed.run.errorMessage ?? "Claude login is missing.");
        return;
      }
      // A run handed over to another runner keeps its question; the item waits for the answer.
      if (executed.run.handedOver && this.askedRuns.has(run.id)) {
        await this.keepAskedWork(finished.id, run.id);
        return;
      }
      if (executed.run.handoverFailure && !this.askedRuns.has(run.id)) {
        // The handover stopped the agent, then failed: the session stays on its runner, and the
        // next turn loads it there and goes on from the WIP commit.
        restart(this.db, finished, {
          reason: "follow_up",
          body: HANDOVER_FAILED_PROMPT,
          now: this.now(),
        });
        return;
      }
      if (executed.run.cancelled || executed.run.stopReason === "cancelled") return;
      if (this.askedRuns.has(run.id)) {
        await this.keepAskedWork(finished.id, run.id);
        return;
      }
      if (executed.run.stopReason === "error" && isAgentServiceError(executed.run.errorMessage))
        throw new AgentServiceError(executed.run.errorMessage!);
      if (executed.run.stopReason !== "end_turn") {
        await this.fail(
          finished,
          executed.run.stopReason,
          executed.run.errorMessage ?? `Run stopped (${executed.run.stopReason}).`,
        );
        return;
      }
      activity.flush();
      if (!(await this.store.run((q) => artifactPublicationReadySteps(q, item.id))))
        throw new Error("A requested artifact has not been uploaded successfully");
      await this.store.run((q) => saveRunResultSteps(q, run.id, activity.resultBody(), this.now()));
      // A fix turn for pull request comments reports a reply for each one it was handed.
      await recordAgentReviewReplies(this.store, item.id, activity.resultBody(), this.now());
      if (!executed.run.identity)
        throw new Error("Implementer did not report a concrete session model");
      this.saveCandidate(run.id, executed.run.identity);
      const at = this.itemHead(finished);
      const head = (await git(["-C", at.repo, "rev-parse", at.ref])).trim();
      await recordAgentFindingDecisions(
        this.store,
        item.id,
        activity.resultBody(),
        await this.fixCommit(at.repo, item.id, head),
        this.now(),
      );
      const base = (await git(["-C", at.repo, "merge-base", at.ref, "origin/main"])).trim();
      const checkpoint = (await this.store.run((q) => getWorkItemSteps(q, item.id)))?.checkpoint;
      await this.store.run((q) =>
        saveCheckpointSteps(q, item.id, {
          ...checkpoint,
          phase: "running",
          baseSha: base,
          wipCommit: head,
        }),
      );
      const commits = Number(
        (await git(["-C", at.repo, "rev-list", "--count", `${base}..${head}`])).trim(),
      );
      await this.store.run((q) =>
        recordItemBranchStateSteps(q, {
          itemId: item.id,
          runId: run.id,
          head,
          base,
          commits,
          recordedAt: this.now(),
        }),
      );
      if (this.options.remoteExecution)
        writeSessionCloseout(
          sessionCloseoutPath(this.options.pawsRoot, pathId),
          head,
          executed.run.closeoutReport,
          pullRequestDraftKey(this.savedDraft(item.id)),
        );
      else await this.store.run((q) => closeActiveRunSteps(q, run.id, this.now()));
      const suggestionJob = await suggestionTurnRunning(this.store, item.id);
      if (
        suggestionJob !== null &&
        head === (await this.store.run((q) => getWorkItemSteps(q, item.id)))?.acceptedHead &&
        mergeAcceptedWork(this.db, item.id, { now: this.now(), exceptJobId: suggestionJob })
      ) {
        await this.flush();
        return;
      }
      await this.verify(
        finished,
        at.repo,
        base,
        head,
        this.candidateFor(run.id),
        turnPasses(
          await this.store.run((q) => listAgentCloseoutSteps(q, [run.id])),
          await this.store.run((q) => pullRequestDraftSavedAtSteps(q, item.id)),
        ),
      );
    } catch (error) {
      const current = await this.store.run((q) => getWorkItemSteps(q, item.id));
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
          await this.continueAfterRateLimit(
            current,
            error instanceof LinearRateLimitError ? error.retryAfterMs : 0,
          );
        else if (isTransient(error) || slotsBusy(error)) {
          deferred = true;
          capacityWaiting = capacityWaitIn(error) !== null;
          throw error;
        } else await this.fail(current, "run_error", message, error);
      }

      journalCaught(
        error,
        "orchestrator.runItem.assert",
        live.itemId,
        undefined,
        this.options.journal,
      );
    } finally {
      activity.flush();
      clearTimeout(first);
      clearInterval(keepAlive);
      await this.releaseAskedRun(run.id);
      if (
        this.options.remoteExecution &&
        !capacityWaiting &&
        !this.shuttingDown &&
        (this.jobContexts.get(item.id)?.isCurrent() ?? true)
      )
        await this.store.run((q) =>
          closeActiveRunSteps(q, run.id, this.now(), deferred ? "lost" : "ended"),
        );
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
    fromTurn: readonly TurnPass[],
  ): Promise<void> {
    const current = await this.store.run((q) => getWorkItemSteps(q, item.id));
    if (current === null || current.state !== "running") return;
    if (await this.visualReviewOutdated(current, worktree, base, head)) return;
    await this.store.transaction((q) => applyWorkItemEventSteps(q, item.id, "turn_ended"));
    const verifying = await this.store.run((q) => getWorkItemSteps(q, item.id));
    if (verifying === null) return;
    await this.store.run((q) =>
      saveCheckpointSteps(q, item.id, { phase: "verifying", baseSha: base, wipCommit: head }),
    );
    await this.evaluateHead(verifying, worktree, base, head, candidate, { fromTurn });
  }

  /**
   * The Closeout evaluation of head S. Pending-human checks are asked first
   * and wait beside the command checks and the independent review. When only
   * they are left the item waits on the person; once they are answered,
   * `decide` completes S from the recorded results, falling back to a full run.
   */
  private async evaluateHead(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
    candidate: CandidateIdentity,
    options: {
      decide?: boolean;
      reverifyJobId?: number;
      onOwned?: () => Promise<void>;
      fromTurn?: readonly TurnPass[];
    } = {},
  ): Promise<void> {
    const startRound =
      options.reverifyJobId !== undefined &&
      (item.state === "merge_queue" || item.checkpoint?.phase === "merge_queue");
    await this.withVerificationRun(
      item,
      candidate,
      options.reverifyJobId !== undefined,
      async (owned, assertCurrent, assertOwned) => {
        await options.onOwned?.();
        return this.evaluateOwnedHead(
          owned,
          worktree,
          base,
          head,
          candidate,
          { ...options, startRound },
          assertCurrent,
          assertOwned,
        );
      },
    );
  }

  private async evaluateOwnedHead(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
    candidate: CandidateIdentity,
    options: {
      decide?: boolean;
      reverifyJobId?: number;
      startRound: boolean;
      fromTurn?: readonly TurnPass[];
    },
    assertCurrent: () => void,
    assertOwned: () => void,
  ): Promise<void> {
    if (options.startRound) await this.startCloseoutRound(item, head);
    if (
      (await closeLinkAsksOnHead(
        this.db,
        item.id,
        head,
        this.now(),
        await this.samePatchVisualReview(item, worktree, base, head),
      )) > 0
    )
      await this.flush();
    if (!options.decide && (await this.openVisualReviewCheck(item, worktree, base, head)))
      await this.flush();
    const ci = options.decide ? null : await this.recheckCi(item, worktree, head);
    if (ci?.kind === "ci-failed" && (await this.sendBackForCi(item, head, ci.checks))) {
      await this.flush();
      return;
    }
    if (ci?.kind === "conflict" && (await this.sendBackForConflict(item, head))) {
      await this.flush();
      return;
    }
    const fromCi = ci?.kind === "check" ? ci.fromCi : [];
    let decide = options.decide ?? false;
    for (let pass = 0; ; pass++) {
      const before = (await this.store.run((q) => getWorkItemSteps(q, item.id))) ?? item;
      const result = await this.verifyCandidate(
        item,
        worktree,
        base,
        head,
        candidate,
        assertCurrent,
        decide,
        fromCi,
        options.fromTurn,
      );
      // A finished verdict may decide an aborted but still-owned run (PAS-771).
      assertOwned();
      const owner = this.options.remoteExecution
        ? (await this.store.run((q) => getWorkItemSteps(q, item.id)))!
        : before;
      const verdict = { ...result, owner: { version: owner.version, runId: owner.currentRunId } };
      await this.recordReviewRounds(item, verdict.owner.runId);
      if ((await this.closeoutStopped(item.id)) !== null) return;
      const after = await this.store.run((q) => getWorkItemSteps(q, item.id));
      if (after === null) return;
      if (verdict.decision === "accepted" && !verdict.exhausted) {
        const acceptedHead = (
          await git(["-C", worktree, "rev-parse", this.itemHead(item).ref])
        ).trim();
        const mergeJob = await acceptCloseout(this.db, {
          itemId: item.id,
          expected: verdict.owner,
          base,
          head: acceptedHead,
          summary: verdict.summary,
          now: this.now(),
          ...(options.reverifyJobId !== undefined ? { reverifyJobId: options.reverifyJobId } : {}),
        });
        if (mergeJob !== null)
          await settleReviewEscapes(this.store, {
            itemId: item.id,
            fixHead: acceptedHead,
            base,
            now: this.now(),
            read: readFixDiff((args) => git(args), worktree),
          }).catch((error: unknown) =>
            journalCaught(
              error,
              "orchestrator.evaluateHead.settleReviewEscapes",
              item.id,
              undefined,
              this.options.journal,
            ),
          );
        if (mergeJob !== null)
          await this.recordFindings(item, worktree, base, acceptedHead).catch((error: unknown) =>
            journalCaught(
              error,
              "orchestrator.evaluateHead.recordFindings",
              item.id,
              undefined,
              this.options.journal,
            ),
          );
        return;
      }
      if (pass < 2 && awaitsVisualReview(verdict.result)) {
        if (await this.awaitVisualReview(after, worktree, base, verdict.result?.head || head))
          return;
        decide = true;
        continue;
      }
      if (pass < 2 && decide) {
        decide = false;
        continue;
      }
      if (verdict.result?.reviewerFault && after.state === "verifying") {
        this.reviewerFaults.set(item.id, verdict.result.reviewerFault);
        return;
      }
      if (this.cancelVisualReview(after))
        this.post(
          after,
          "thought",
          verdict.summary,
          `${item.id}:verdict-after-visual-review:${verdict.result?.head ?? head}`,
        );
      await this.askCloseoutHelp(after, verdict.result, verdict.summary);
      return;
    }
  }

  /** Stores the accepted head's non-blocking findings for the Findings page. */
  private async recordFindings(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
  ): Promise<void> {
    const changed = await git([
      "-C",
      worktree,
      "diff",
      "--no-renames",
      "--name-only",
      "-z",
      `${base}...${head}`,
    ]);
    await recordAcceptedFindings(this.store, {
      itemId: item.id,
      head,
      pawsRoot: this.options.pawsRoot,
      now: this.now(),
      changedPaths: changed.split("\0").filter(Boolean),
    });
  }

  private async withVerificationRun(
    item: WorkItemRecord,
    candidate: CandidateIdentity,
    recheck: boolean,
    operation: (
      owned: WorkItemRecord,
      assertCurrent: () => void,
      assertOwned: () => void,
    ) => Promise<void>,
  ): Promise<void> {
    if (!this.options.remoteExecution) {
      const assertCurrent = () => this.assertJobCurrent(item.id);
      assertCurrent();
      await operation(item, assertCurrent, assertCurrent);
      return;
    }
    const priorRunId = item.currentRunId;
    if (priorRunId && (await this.options.remoteExecution.runInProgress?.(priorRunId)))
      throw new VerificationHeld();
    let ownedRunId: string | null = null;
    try {
      const db = this.db;
      const now = () => this.now();
      const snapshotOf = (runId: string) => this.readProfileSnapshot(runId);
      const holder = (q: Q, current: WorkItemRecord) =>
        this.verificationHolderSteps(q, current, false);
      const ownerInstance = this.options.instanceId ?? null;
      item = await this.store.transaction(function* (q) {
        const current = yield* getWorkItemSteps(q, item.id);
        if (
          !current ||
          current.currentRunId !== item.currentRunId ||
          current.cancelRequested ||
          !["verifying", "merge_queue"].includes(current.state)
        )
          throw new Error("Verification belongs to an obsolete task");
        const prior = current.currentRunId ? yield* getRunSteps(q, current.currentRunId) : null;
        if (!prior || prior.itemId !== current.id) throw new Error("Verification run is missing");
        const snapshot = snapshotOf(prior.id);
        if (
          !snapshot?.candidate ||
          JSON.stringify(snapshot.candidate) !== JSON.stringify(candidate)
        )
          throw new Error("Verification candidate identity changed");
        if (prior.status === "active") {
          if ((yield* holder(q, current)) === "process") {
            if (recheck || current.state !== "verifying") throw new VerificationHeld();
            return current;
          }
          if (yield* runnerWorkHasResultSteps(q, prior.id)) {
            // Keep the original run so the backend can import its delivered result.
            if (current.state === "merge_queue")
              yield* applyWorkItemEventSteps(q, current.id, "reverify_requested");
            ownedRunId = prior.id;
            return (yield* getWorkItemSteps(q, current.id))!;
          }
          if ((yield* holder(q, current)) === "runner") throw new VerificationHeld();
          // An abandoned run did not finish cleanly. Preserve that in its history.
          closeActiveRun(db, prior.id, now(), "lost");
          yield* releaseRunCapacitySteps(q, prior.id, now());
        } else if (prior.status !== "ended" && prior.status !== "lost")
          throw new Error("Prior verification run is still provisioning");
        if (current.state === "merge_queue")
          yield* applyWorkItemEventSteps(q, current.id, "reverify_requested");
        const run = yield* insertRunSteps(q, {
          itemId: current.id,
          kind: "recheck",
          agent: prior.agent,
          status: "active",
          freshSession: true,
          now: now(),
          ownerInstance,
        });
        ownedRunId = run.id;
        yield* setCurrentRunSteps(q, current.id, run.id);
        return (yield* getWorkItemSteps(q, current.id))!;
      });
      if (ownedRunId && ownedRunId !== priorRunId) {
        mkdirSync(runDir(this.options.pawsRoot, ownedRunId), { recursive: true, mode: 0o700 });
        writeFileSync(
          join(runDir(this.options.pawsRoot, ownedRunId), "agent-profile.json"),
          readFileSync(join(runDir(this.options.pawsRoot, priorRunId!), "agent-profile.json")),
          { mode: 0o600 },
        );
      }
      const operationLive = this.live.get(`operation:${item.id}`);
      if (ownedRunId && operationLive) this.live.set(ownedRunId, operationLive);
      const runId = item.currentRunId!;
      const assertOwned = () => {
        const current = getWorkItem(this.db, item.id);
        const identity = this.readProfileSnapshot(runId)?.candidate;
        if (
          !current ||
          current.currentRunId !== runId ||
          current.cancelRequested ||
          !(
            ["verifying", "running"].includes(current.state) ||
            (current.state === "awaiting_input" &&
              current.sessionKey !== null &&
              findOpenQuestion(this.db, current.sessionKey)?.kind === "runner-wait")
          ) ||
          getRun(this.db, runId)?.status !== "active" ||
          JSON.stringify(identity) !== JSON.stringify(candidate)
        )
          throw new Error("Verification belongs to an obsolete candidate or run");
      };
      const assertCurrent = () => {
        this.signalForItem(item.id)?.throwIfAborted();
        assertOwned();
      };
      assertCurrent();
      await operation(item, assertCurrent, assertOwned);
    } finally {
      if (ownedRunId) {
        const owned = ownedRunId;
        const live = this.live.get(owned);
        if (live === this.live.get(`operation:${item.id}`)) this.live.delete(owned);
        const current = await this.store.run((q) => getWorkItemSteps(q, item.id));
        if (
          !current ||
          current.currentRunId !== owned ||
          current.cancelRequested ||
          ["failed", "cancelled", "completed", "merged"].includes(current.state)
        ) {
          await this.store.run((q) => releaseRunCapacitySteps(q, owned, this.now()));
        } else if (
          owned !== priorRunId ||
          !(await this.store.run((q) => runnerWorkHasResultSteps(q, owned)))
        ) {
          await this.store.run((q) => releaseRunCapacitySteps(q, owned, this.now()));
        }
      }
    }
  }

  private async verifyCandidate(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
    candidate: CandidateIdentity,
    assertCurrent: () => void = () => {},
    decide = false,
    fromCi: readonly CiResult[] = [],
    fromTurn: readonly TurnPass[] = [],
  ): Promise<CloseoutVerdict> {
    const repository = this.repositoryForItem(item);
    const mirror =
      this.options.remoteExecution && repository
        ? {
            path: mirrorPath(this.options.pawsRoot, repository.owner, repository.repo),
            ref: candidateRef(itemPathId(item)),
          }
        : undefined;
    const policy = await this.commitPolicy(item);
    if (policy)
      await validateCandidateAttribution(
        mirror?.path ?? worktree,
        base,
        head,
        policy,
        undefined,
        this.signalForItem(item.id),
      );
    const sessionProgress = this.sessionProgress(item);
    sessionProgress?.phase("verifying");
    const checkoutExclusions = this.runCheckout(item).checks;
    const deps = this.agentDeps(item);
    const networkGit =
      repository && deps.signal
        ? await this.repositoryGit(item, repository, deps.signal, "write")
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
    const savedReport = (commit: string, argv: readonly string[] = []) => {
      const saved = readSessionCloseout(sessionPath);
      if (saved?.head !== commit) return undefined;
      if (
        usesPullRequestDraft(argv) &&
        saved.draft !== pullRequestDraftKey(this.savedDraft(item.id))
      )
        return undefined;
      return saved.report;
    };
    const recovery = await recoveryOptions(this.db, item.id);
    let rulesFirst = !recovery.bypasses.some((bypass) => bypass.head === head);
    let stoppedOnRule: string | undefined;
    const runnerChecks = new Map<string, Promise<void>>();
    const rerunHeads = new Set<string>();
    const runnerResults = (commit: string, stepId: string | undefined, again = false) => {
      let checks = runnerChecks.get(commit);
      if (!checks) {
        checks = this.runRunnerCloseout(item, deps, {
          again,
          worktree,
          base,
          head: commit,
          stepId,
          sessionPath,
          policy,
          assertCurrent,
          report: (body) => report(body),
          rulesFirst,
          // CI's results are for the head it ran on; a fixed head runs every check.
          fromCi: commit === head ? fromCi.map((entry) => entry.id) : [],
        });
        runnerChecks.set(commit, checks);
      }
      return checks;
    };
    const commands = this.options.remoteExecution
      ? {
          runLogged: async (request: Parameters<typeof loggedSessionCloseout>[1]) => {
            assertCurrent();
            const commit = request.expectedHead;
            if (!sessionCloseoutResult(savedReport(commit, request.argv), request))
              await runnerResults(commit, request.itemId);
            assertCurrent();
            const broken = rulesFirst ? brokenRuleOf(savedReport(commit)) : undefined;
            if (broken && !sessionCloseoutResult(savedReport(commit, request.argv), request)) {
              stoppedOnRule = broken;
              throw new Error(`Rule ${broken} broke before the checks ran.`);
            }
            if (
              !rerunHeads.has(commit) &&
              !sessionCloseoutResult(savedReport(commit, request.argv), request)
            ) {
              rerunHeads.add(commit);
              report(
                `Closeout has no result for ${request.itemId ?? "a check"} on ${commit.slice(0, 7)}: ${missingResultReason(savedReport(commit, request.argv), request)}. Running the checks once more.`,
              );
              runnerChecks.delete(commit);
              await runnerResults(commit, request.itemId, true);
              assertCurrent();
            }
            const result = loggedSessionCloseout(savedReport(commit, request.argv), request);
            assertCurrent();
            return result;
          },
          // No runProbe: Closeout runs each rule's policy probe here, against its own worktree
          // of the candidate, so a rule never waits on a result the runner may not report.
        }
      : undefined;
    const live = [...this.live.values()].find((entry) => entry.itemId === item.id);
    const key = `${item.currentRunId ?? item.id}:closeout:${crypto.randomUUID()}`;
    const report = (body: string) => {
      if (deps.signal?.aborted || !this.canReportProgress(item.id)) return;
      if (live) live.progress = body;
      this.post(item, "thought", body, this.activityKey(key));
    };
    const activity = createAcpActivityReporter(
      (update, origin) => {
        if (
          deps.signal?.aborted ||
          !this.canReportProgress(item.id) ||
          update.kind === "elicitation"
        )
          return;
        this.post(item, update.kind, update.body, this.activityKey(`${key}:acp`, origin), update);
      },
      (steps) => {
        if (!deps.signal?.aborted && !this.stopped(item.id)) sessionProgress?.plan(steps);
      },
    );
    const onCandidate = deps.onCandidate;
    deps.onCandidate = (identity) => {
      if (deps.signal?.aborted) return;
      Object.assign(candidate, identity);
      onCandidate?.(identity);
    };

    const reviewerAgent = deps.profiles?.reviewer?.agent;
    const reviewer =
      reviewerAgent === "grok" || reviewerAgent === "opencode"
        ? createAcpCodexReviewer({ ...deps, postUpdate: this.updateHook(item) })
        : createReviewCommandReviewer({ ...deps, postUpdate: this.updateHook(item) });
    const recorded = createDbCloseoutProgress(this.db, item.id, () => this.now());
    const publishing = this.closeoutEvidence()?.objects?.()
      ? publishingCloseoutProgress(recorded, () => this.pushCloseoutEvidence(item))
      : null;
    const progress = publishing ?? recorded;
    const gate = (this.options.closeoutGate ?? createCloseoutGate)({
      checkoutExclusions,
      candidate,
      published: () => publishedEvidence(this.db, item.id),
      approvals: () => visualReviewApprovals(this.db, item.id, itemPathId(item)),
      ...(fromCi.length > 0 ? { fromCi } : {}),
      ...(fromTurn.length > 0 ? { fromTurn } : {}),
      ...(commands ? { commandRunner: commands } : {}),
      pullRequest: () => this.savedDraft(item.id),
      reviewer: {
        async review(request) {
          // A runner-backed item's review runs on its runner; the mirror has no files to narrow.
          if (!mirror)
            await checkoutPatterns(request.worktree, exclusionPatterns(checkoutExclusions));
          return reviewer.review(request);
        },
      },
      maxFixAttempts: 0,
      fixer: {
        applyFix: async () => {
          throw new Error("Closeout fixes must restart the item");
        },
      },
      recorder: {
        record: async (verdict) => {
          if (!deps.signal?.aborted) this.postEvidence(item, verdict);
          if (
            deps.signal?.aborted ||
            verdict.outcome === "accepted" ||
            awaitsVisualReview(verdict) ||
            (stoppedOnRule !== undefined && verdict.decision === null)
          )
            return;
          this.post(
            item,
            "thought",
            verdict.summary,
            `${item.id}:verdict:${(await this.store.run((q) => listCloseoutRecoveriesSteps(q, item.id))).length}:${verdict.head}:${verdict.outcome}:${verdict.evaluations}:${verdict.fixAttempts}`,
          );
        },
      },
      reportDir: `${this.options.pawsRoot}/runs/${itemPathId(item)}`,
      ...this.closeoutHome(item),
      ...recovery,
      progress,
    });
    const request = {
      taskId: itemPathId(item),
      taskLabel: item.linearIdentifier,
      worktree,
      ...(mirror ? { mirror } : {}),
      baseSha: base,
      headSha: head,
      attempt: 1,
    };
    await this.pullCloseoutEvidence(item, true);
    try {
      const verdict = await gate[decide ? "decide" : "run"](request);
      if (stoppedOnRule === undefined) return verdict;
      const decided = await gate.decide(request);
      const ruleFailed = decided.result?.decision?.items.some(
        (entry) => entry.kind === "rule" && entry.state === "failed",
      );
      if (ruleFailed && decided.result?.ruleApprovals?.length)
        return {
          ...decided,
          exhausted: true,
          result: { ...decided.result, outcome: "exhausted" },
        };
      if (ruleFailed) return decided;
      rulesFirst = false;
      stoppedOnRule = undefined;
      runnerChecks.clear();
      return await gate.run(request);
    } finally {
      activity.flush();
      if (live) live.progress = null;
      await publishing?.settled();
      await this.pushCloseoutEvidence(item);
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
      /** Checks Closeout took from CI, which the runner leaves alone. */
      fromCi?: readonly string[];
      rulesFirst: boolean;
      again?: boolean;
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
        await this.waitWithoutAwake(item.id, "backoff", delayMs, deps.signal);
        assertCurrent();
      } else
        input.report(
          `Running the Closeout checks for ${item.linearIdentifier} on its runner at ${short}.`,
        );
      const draft = this.savedDraft(item.id);
      const checksRunId = `checks-${itemPathId(item)}-${short}-${input.again ? "again-" : ""}${attempt}`;
      try {
        const options: RunAgentOptions = {
          repository: deps.repository,
          role: "implementer",
          profile: deps.profiles?.implementer,
          itemId: itemPathId(item),
          runId: checksRunId,
          prompt: closeoutChecksPrompt(head, input.fromCi),
          worktreePath: this.runnerWorkspace(checksRunId),
          pawsRoot: this.options.pawsRoot,
          checkpoint: false,
          ...(input.rulesFirst ? { closeoutRulesFirst: true } : {}),
          ...(draft ? { pullRequestDraft: draft } : {}),
          mainSha: input.base,
          ...(input.policy ? { commitPolicy: input.policy } : {}),
          ...(deps.home ? { home: deps.home } : {}),
          ...(deps.signal ? { signal: deps.signal } : {}),
        };
        const result = await runner!({
          ...options,
          ...(await this.trustedRunInputs(item, options)),
        });
        assertCurrent();
        const { ref } = this.itemHead(item);
        const at = (await git(["-C", worktree, "rev-parse", ref])).trim();
        if (at !== head) {
          await git(
            ref === "HEAD"
              ? ["-C", worktree, "reset", "--hard", head]
              : ["-C", worktree, "update-ref", ref, head, at],
          );
          if (ref !== "HEAD")
            await this.store.run((q) =>
              recordItemCandidateSteps(q, {
                itemId: item.id,
                sha: head,
                branch: item.branchName,
                recordedAt: this.now(),
              }),
            );
          reason = "the checks run changed the commit";
        } else if (result.cancelled) reason = "the run was cancelled";
        else if (result.stopReason !== "end_turn" || result.errorMessage)
          reason = result.errorMessage ?? `the run stopped (${result.stopReason})`;
        else if (!result.closeoutReport) reason = "the runner returned no Closeout report";
        else if (!listsChecks(result.closeoutReport))
          reason = "the runner's Closeout listed no checks";
        else {
          writeSessionCloseout(
            input.sessionPath,
            head,
            result.closeoutReport,
            pullRequestDraftKey(draft),
          );
          return;
        }
      } catch (error) {
        assertCurrent();
        if (deps.signal?.aborted || error instanceof RunnerCapacityWait) throw error;
        journalCaught(
          error,
          "orchestrator.runRunnerCloseout.itemPathId",
          item?.id,
          "cancellation may interrupt work",
          this.options.journal,
        );
        reason = error instanceof Error ? error.message : String(error);
        if (
          (error instanceof LinearRateLimitError || LINEAR_RATE_LIMITED.test(reason)) &&
          this.now() < rateLimitDeadline
        ) {
          await this.waitWithoutAwake(
            item.id,
            "backoff",
            error instanceof LinearRateLimitError
              ? Math.min(error.retryAfterMs, CHECKS_RATE_LIMIT_WAIT_MS)
              : CHECKS_RATE_LIMIT_RETRY_MS,
            deps.signal,
          );
          assertCurrent();
          attempt -= 1;
        } else if (isTransient(error)) throw error;
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
      sleep: (ms) =>
        this.waitWithoutAwake(item.id, "runner", ms, signal, this.options.runnerWait?.sleep),
      waiting: (reason) => {
        if (stepId)
          setRunningCloseoutStepDetail(this.db, item.id, head, stepId, reason, this.now());
      },
      notify: (reason) => {
        this.post(item, "thought", reason, `${runId}:closeout-runner-wait:${head}:${reason}`);
        void this.flush().catch((caughtError4) => {
          journalCaught(
            caughtError4,
            "orchestrator.notify.flush",
            item?.id,
            undefined,
            this.options.journal,
          );
        });
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
    this.assertJobCurrent(item.id);
    const { question } = ask(
      this.db,
      { itemId: item.id, runId, sessionId, version: getWorkItem(this.db, item.id)?.version },
      "runner-wait",
      body,
      {
        options: [MOVE_TO_ANOTHER_RUNNER, KEEP_WAITING],
        context: reason,
        now: this.now(),
      },
    );
    void this.flush().catch((caughtError5) => {
      journalCaught(
        caughtError5,
        "orchestrator.askRunnerWait.flush",
        question.itemId,
        undefined,
        this.options.journal,
      );
    });
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
   * Record re-verification metadata. A rebase does not authorize new attempts.
   */
  private async startCloseoutRound(item: WorkItemRecord, head: string): Promise<void> {
    if (head === "" || head === item.checkpoint?.wipCommit) return;
    const rounds = await this.store.run((q) => listCloseoutRoundsSteps(q, item.id));
    if (rounds.some((round) => round.head === head)) return;
    await this.pullCloseoutEvidence(item);
    let retryBaseline: string[];
    try {
      retryBaseline = await snapshotRetryBaseline(itemPathId(item), this.options.pawsRoot);
    } catch (caughtError6) {
      journalCaught(
        caughtError6,
        "orchestrator.startCloseoutRound.snapshotRetryBaseline",
        item?.id,
        undefined,
        this.options.journal,
      );
      return;
    }
    await this.store.run((q) =>
      startCloseoutRoundSteps(q, {
        itemId: item.id,
        head,
        retryBaseline,
        startedAt: this.now(),
      }),
    );
  }

  /** Ask a person about a preparation that kept failing before the agent started. */
  private async askPreparationHelp(item: WorkItemRecord, summary: string): Promise<void> {
    const current = await this.store.run((q) => getWorkItemSteps(q, item.id));
    if (!current) return;
    this.post(current, "thought", summary, `${current.currentRunId ?? current.id}:preparation`);
    await this.askCloseoutHelp(current, undefined, summary);
  }

  /**
   * CI on the head of a merge-queue re-check (a CI or conflict fix, or a re-verify). Null for a
   * first Closeout run, or a policy that maps no check to CI.
   */
  private async recheckCi(
    item: WorkItemRecord,
    worktree: string,
    head: string,
  ): Promise<CiRecheck | null> {
    // Closeout accepted an earlier head and its pull request is open: the item is in the merge
    // queue, back from a CI or conflict fix, or re-verified there. A first run has no accepted head.
    const pull = await this.store.run((q) => getItemPullRequestSteps(q, item.id));
    if (
      pull === null ||
      (await this.store.run((q) => getWorkItemSteps(q, item.id)))?.acceptedHead == null
    )
      return null;
    const repository = this.repositoryForItem(item);
    const github = repository ? this.githubForRepository(repository) : null;
    if (!repository || !github) return null;
    const { home, policyRoot } = this.closeoutHome(item);
    const mappings = ciMappings(worktree, home, policyRoot);
    if (mappings.length === 0) return null;
    const signal = this.signalForItem(item.id);
    const short = head.slice(0, 7);
    return ciForRecheck({
      mappings,
      read: () => {
        this.assertJobCurrent(item.id);
        return readPullCi({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          prNumber: pull.pullNumber,
          head,
          ...this.gitHubCredentials(github),
        });
      },
      // GitHub runs no CI on a conflicting pull request (PAS-990). One read per poll; only a
      // conflict on this head counts, so unknown or unreadable keeps waiting.
      conflicts: async () => {
        this.assertJobCurrent(item.id);
        const read = await readPullMergeable({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          prNumber: pull.pullNumber,
          reads: 1,
          ...this.gitHubCredentials(github),
          ...(signal ? { signal } : {}),
        });
        return conflictsAt(read, head);
      },
      sleep: (ms) => this.waitWithoutAwake(item.id, "ci", ms, signal),
      now: () => this.now(),
      ...(this.options.ciRecheckWait ?? {}),
      onWait: (message) =>
        this.options.journal?.(
          `item ${item.linearIdentifier} re-check at ${short} waits for CI: ${message}`,
        ),
    });
  }

  /**
   * A merge-queue re-check's pull request conflicts with main: the item goes back to rebase, as
   * the merge lane's conflict return does, within the shared rebase budget. False when the head
   * already went back once, main cannot be fetched or the budget is spent, so the checks run.
   */
  private async sendBackForConflict(
    item: WorkItemRecord,
    head: string,
    found = `re-check at ${head.slice(0, 7)}`,
  ): Promise<boolean> {
    this.assertJobCurrent(item.id);
    if (await this.store.run((q) => rebaseReturnedForSteps(q, item.id, head))) return false;
    const base = await this.fetchUpstreamMain(item);
    if (base === null) return false;
    this.assertJobCurrent(item.id);
    const conflict = { base, files: null, reason: "merge" as const };
    const reads = await this.readPendingFeedback(item);
    this.assertJobCurrent(item.id);
    const sent = await this.store.transaction((q) =>
      this.sendBackForConflictSteps(q, item, head, conflict, reads),
    );
    if (sent)
      this.options.journal?.(
        `item ${item.linearIdentifier} ${found}: the pull request conflicts with main. Sent back to the agent to rebase.`,
      );
    return sent;
  }

  private *sendBackForConflictSteps(
    q: Q,
    item: WorkItemRecord,
    head: string,
    conflict: { base: string; files: null; reason: "merge" },
    reads: FeedbackReads | null,
  ): Steps<boolean> {
    const current = yield* getWorkItemSteps(q, item.id);
    if (
      !current ||
      current.cancelRequested ||
      (current.state !== "verifying" && current.state !== "merge_queue") ||
      !rebaseBudgetFor(this.db, item.id, conflict, this.now()).allowed
    )
      return false;
    const jobId = restartWithFeedback(this.db, current, {
      reason: "conflict",
      lead: [REBASE_CONFLICT_INSTRUCTION],
      reads,
      fixRoundLimit: this.fixRoundLimit(current),
      sessionId: this.activitySession(current),
      now: this.now(),
      jobKey: `conflict:${item.id}:recheck:${head}`,
    });
    if (jobId === null) return false;
    yield* recordRebaseReturnSteps(q, {
      itemId: item.id,
      jobId,
      candidate: head,
      ...conflict,
      recordedAt: this.now(),
    });
    const pull = yield* getItemPullRequestSteps(q, item.id);
    if (pull !== null)
      postMergeConflict(
        this.db,
        current,
        { sessionId: this.activitySession(current), pullNumber: pull.pullNumber, head },
        this.now(),
      );
    return true;
  }

  /**
   * CI failed on a merge-queue re-check's head: a CI fix round, as the merge lane would send.
   * False when no fix round is left, so the checks run and the usual way asks.
   */
  private async sendBackForCi(
    item: WorkItemRecord,
    head: string,
    checks: readonly FailedCiCheck[],
  ): Promise<boolean> {
    this.assertJobCurrent(item.id);
    const reads = await this.readPendingFeedback(item);
    this.assertJobCurrent(item.id);
    return await this.store.transaction((q) =>
      this.sendBackForCiSteps(q, item, head, checks, reads),
    );
  }

  private *sendBackForCiSteps(
    q: Q,
    item: WorkItemRecord,
    head: string,
    checks: readonly FailedCiCheck[],
    reads: FeedbackReads | null,
  ): Steps<boolean> {
    const current = yield* getWorkItemSteps(q, item.id);
    if (
      !current ||
      current.cancelRequested ||
      (current.state !== "verifying" && current.state !== "merge_queue")
    )
      return false;
    const rounds = yield* fixRoundsSteps(q, item.id);
    const limit = this.fixRoundLimit(current);
    if (rounds >= limit) return false;
    const jobId = restartWithFeedback(this.db, current, {
      reason: "ci",
      lead: [ciFixHandoff(checks)],
      reads,
      ci: false,
      fixRoundLimit: limit,
      sessionId: this.activitySession(current),
      now: this.now(),
      jobKey: `ci-failed:${item.id}:recheck:${head}`,
    });
    if (jobId === null) return false;
    this.options.journal?.(
      `item ${current.linearIdentifier} re-check at ${head.slice(0, 7)}: ${ciFixRoundLine(checks, rounds + 1, limit)}`,
    );
    return true;
  }

  private *restartForFindingsSteps(
    q: Q,
    itemId: string,
    version: number,
    input: {
      lead: string;
      reads: FeedbackReads | null;
      limit: number;
      attempts: ReturnType<typeof fixAttemptLimit>;
    },
  ): Steps<void> {
    const latest = yield* getWorkItemSteps(q, itemId);
    if (latest?.version !== version) return;
    restartWithFeedback(this.db, latest, {
      reason: "findings",
      lead: [input.lead],
      reads: input.reads,
      fixRoundLimit: input.limit,
      sessionId: this.activitySession(latest),
      now: this.now(),
      limit: input.attempts,
    });
  }

  private restartWithStoredFeedback(item: WorkItemRecord, handoff: RestartHandoff): number | null {
    return restartWithFeedback(this.db, item, {
      reason: handoff.reason,
      now: handoff.now,
      ...(handoff.jobKey === undefined ? {} : { jobKey: handoff.jobKey }),
      ...(handoff.limit === undefined ? {} : { limit: handoff.limit }),
      lead: [handoff.body],
      reads: storedFeedbackReads(this.db, item, handoff.now),
      ci: false,
      fixRoundLimit: this.fixRoundLimit(item),
      sessionId: this.activitySession(item),
    });
  }

  private async readPendingFeedback(item: WorkItemRecord): Promise<FeedbackReads | null> {
    return readPendingFeedback(
      this.db,
      item,
      this.pullFeedbackCapabilities(this.jobContexts.get(item.id)?.signal),
    );
  }

  private async askCloseoutHelp(
    item: WorkItemRecord,
    result: GateResult | undefined,
    summary: string,
  ): Promise<void> {
    if ((await this.closeoutStopped(item.id)) !== null) return;
    this.assertJobCurrent(item.id);
    const current = await this.store.run((q) => getWorkItemSteps(q, item.id));
    if (!current) return;
    const checks = result?.decision?.items ?? [];
    // A failed rule set to `onFail: approve` is not the agent's to fix: it waits for a person.
    const held = result?.ruleApprovals ?? [];
    const free = checks.filter((check) => !held.some((rule) => rule.id === check.id));
    const failed = free.some((check) => check.state === "failed");
    const exhausted = free.some((check) => check.state === "exhausted");
    const setupFailed = checks.some((check) => check.kind === "setup" && check.state === "failed");
    const rounds = await this.store.run((q) => fixRoundsSteps(q, item.id));
    const limit = this.fixRoundLimit(item);
    if (failed && !exhausted && !setupFailed && rounds < limit) {
      const reviews = result?.reviewFindings ?? [];
      const repository = this.repositoryForItem(item);
      const judgedReviews =
        (await this.store.run((q) => failedCloseoutReviewsSteps(q, item.id)))?.reviews ?? [];
      if (repository && reviews.length > 0) {
        const report = {
          itemId: item.id,
          repository: `${repository.owner}/${repository.repo}`,
          head: result!.head,
          seenAt: this.now(),
          findings: reviews.flatMap((review) =>
            review.findings
              .filter((finding) => {
                const failOn = judgedReviews.find((entry) => entry.id === review.itemId)?.failOn;
                return (
                  !review.preExisting?.includes(finding) &&
                  failOn != null &&
                  finding.severity <= failOn
                );
              })
              .map((finding) => ({
                review: review.itemId,
                severity: finding.severity,
                location: finding.location,
                text: finding.explanation,
                bugClass: bugClass(finding.explanation),
                why: "meets failOn" as const,
              })),
          ),
          reviewed: [],
        };
        await this.store.transaction((q) => recordReviewFindingsSteps(q, report));
      }
      const reads = await this.readPendingFeedback(current);
      this.assertJobCurrent(item.id);
      await this.store.transaction((q) =>
        this.restartForFindingsSteps(q, item.id, current.version, {
          lead: result?.handoff ?? summary,
          reads,
          limit,
          attempts: fixAttemptLimit(limit, rounds + 1, result?.fixesLeft ?? null),
        }),
      );
      return;
    }
    const sessionId = this.activitySession(item);
    if (sessionId === null) throw new Error("Closeout recovery has no tracker session");
    await this.pullCloseoutEvidence(item);
    let retryBaseline: string[] = [];
    try {
      retryBaseline = await snapshotRetryBaseline(itemPathId(item), this.options.pawsRoot);
    } catch (caughtError7) {
      journalCaught(
        caughtError7,
        "orchestrator.askCloseoutHelp.snapshotRetryBaseline",
        item?.id,
        undefined,
        this.options.journal,
      );
    }
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
              bypassable(check) &&
              !result.bypasses?.some((approval) => approval.checkIds.includes(check.id)),
          )
          .map((check) => check.id) ?? [],
      retryBaseline,
      summary,
    };
    // Only held rules failed: ask about them, whatever fix rounds are left; none is used.
    const rules =
      !failed && !exhausted && !setupFailed && result?.outcome === "exhausted" ? held : [];
    if (rules.length > 0) context.failedChecks = rules.map((rule) => rule.id);
    this.assertJobCurrent(item.id);
    if (
      exhausted &&
      checks.every((check) => check.state !== "exhausted" || check.kind === "review") &&
      (await this.askReviewRounds(current, sessionId, result, context))
    )
      return;
    const repository = this.repositoryForItem(item);
    const repositoryName = repository ? `${repository.owner}/${repository.repo}` : null;
    const policyFailed = repositoryName !== null && policyLoadFailed(result?.decision);
    const unreadable = policyFailed ? this.unreadableMainPolicy(item) : null;
    const brokenMain =
      repositoryName && policyFailed
        ? await policyOutageNote(
            this.db,
            repositoryName,
            item.id,
            this.options.publicUrl ?? null,
            unreadable,
          )
        : null;
    await askCloseoutHelp(this.db, sessionId, context, {
      now: this.now(),
      ...(brokenMain ? { error: brokenMain } : {}),
      ...(repositoryName && unreadable
        ? { policyBlock: { repository: repositoryName, unreadable } }
        : {}),
      version: current.version,
      publicUrl: this.options.publicUrl ?? null,
      ...(rules.length > 0 ? { rules } : {}),
      checks: checks.map((check) => ({
        id: check.id,
        kind: check.kind,
        state: check.state,
        ...(check.attempt === undefined ? {} : { attempt: check.attempt }),
        message: check.message,
      })),
      reason:
        rules.length > 0
          ? "rule_approval"
          : exhausted || rounds >= limit
            ? "budget_spent"
            : result?.outcome === "blocked"
              ? "blocked_check"
              : "setup_fault",
    });
    await this.flush();
  }

  /** Records on the verifying run how many review rounds the item has needed so far. */
  private async recordReviewRounds(item: WorkItemRecord, runId: string | null): Promise<void> {
    if (runId === null) return;
    await this.pullCloseoutEvidence(item);
    try {
      const { rounds } = await readReviewRounds(itemPathId(item), [], this.options.pawsRoot);
      if (rounds.length > 0)
        await this.store.run((q) => recordReviewRoundsSteps(q, runId, rounds.length));
    } catch (caught) {
      journalCaught(
        caught,
        "orchestrator.recordReviewRounds",
        item.id,
        undefined,
        this.options.journal,
      );
    }
  }

  /**
   * Review attempts ran out: ask on the item page whether to rethink, keep going
   * or stop. Returns false when Paws has no link a person can open, so the
   * caller asks in Linear instead.
   */
  private async askReviewRounds(
    item: WorkItemRecord,
    sessionId: string,
    result: GateResult | undefined,
    help: CloseoutHelp,
  ): Promise<boolean> {
    if (!linkAskAvailable(this.options.publicUrl) || item.sessionKey !== sessionId) return false;
    await this.pullCloseoutEvidence(item);
    let rounds: ReviewRounds;
    try {
      rounds = await readReviewRounds(
        itemPathId(item),
        (await recoveryOptions(this.db, item.id)).retryBaseline,
        this.options.pawsRoot,
      );
    } catch (caught) {
      journalCaught(
        caught,
        "orchestrator.askReviewRounds.readReviewRounds",
        item.id,
        undefined,
        this.options.journal,
      );
      return false;
    }
    const exhausted = result?.decision?.items.find(
      (check) => check.kind === "review" && check.state === "exhausted",
    );
    const findings = reviewFindingText(await this.failedReviewFindings(item));
    this.assertJobCurrent(item.id);
    const question = await askReviewRounds(this.db, {
      item,
      help,
      findings,
      rounds: {
        ...rounds,
        limit: reviewRoundLimit(exhausted?.message),
        handoff: result?.handoff ?? [help.summary, findings].filter(Boolean).join("\n"),
      },
      publicUrl: this.options.publicUrl ?? null,
      now: this.now(),
    });
    if (question === null) return false;
    await this.flush();
    return true;
  }

  private async waitForVerification(
    job: Job,
    context: JobContext,
    item: WorkItemRecord,
  ): Promise<void> {
    const backendBusy =
      item.currentRunId !== null &&
      (await this.options.remoteExecution?.runInProgress?.(item.currentRunId));
    const current = await this.store.run((q) => getWorkItemSteps(q, item.id));
    if (
      !context.isCurrent() ||
      !(await this.store.run((q) => jobVersionCurrentSteps(q, job))) ||
      !current ||
      current.version !== item.version ||
      !this.reverifyEligible(current)
    )
      return;
    const payload = job.payload as Record<string, unknown>;
    const since =
      typeof payload.verificationWaitSince === "number"
        ? payload.verificationWaitSince
        : this.now();
    if (
      this.now() - since >= VERIFICATION_OWNER_WAIT_MS &&
      !backendBusy &&
      (await this.verificationHolder(current)) === "runner"
    ) {
      this.options.journal?.(
        `reverify job ${job.id} stalled for item ${item.id}: ownership held for ${VERIFICATION_OWNER_WAIT_MS / 60_000} minutes`,
      );
      if (this.activitySession(current) === null) {
        await this.fail(
          current,
          "no_tracker_session",
          "Cannot request verification help because this item has no tracker session.",
        );
        return;
      }
      try {
        await this.askCloseoutHelp(
          current,
          undefined,
          `Closeout: blocked\nVerification has waited ${VERIFICATION_OWNER_WAIT_MS / 60_000} minutes for the runner. Check the runner and retry once it is ready.`,
        );
      } catch (error) {
        const after = await this.store.run((q) => getWorkItemSteps(q, item.id));
        if (
          !context.isCurrent() ||
          !(await this.store.run((q) => jobVersionCurrentSteps(q, job))) ||
          !after ||
          !this.reverifyEligible(after)
        )
          return;
        if (job.attempts < job.maxAttempts) throw error;
        await this.fail(
          after,
          "closeout_help_failed",
          `Could not request verification help: ${error instanceof Error ? error.message : String(error)}`,
          error,
        );
      }
      return;
    }
    if (payload.verificationWaitSince === undefined)
      this.options.journal?.(`reverify job ${job.id} waiting for ownership of item ${item.id}`);
    await this.store.run((q) =>
      parkLeasedJobSteps(q, job, {
        runAt: this.now() + VERIFICATION_OWNER_POLL_MS,
        payload: {
          ...payload,
          verificationWaitSince: since,
          verificationWaitRunId: current.currentRunId,
          // The accepted head when the wait began, kept across polls (PAS-1491).
          verificationWaitAccepted:
            "verificationWaitAccepted" in payload
              ? payload.verificationWaitAccepted
              : current.acceptedHead,
        },
        attempts: job.attempts - 1,
        now: this.now(),
      }),
    );
  }

  /**
   * The check run this re-verify parked behind accepted `head`, so it needs no second run
   * (PAS-1491). A head that was already accepted when the wait began still runs, and so does a
   * decide request.
   */
  private acceptedWhileWaiting(payload: unknown, item: WorkItemRecord, head: string): boolean {
    const record = payload as Record<string, unknown>;
    return (
      readBoolean(payload, "decide") !== true &&
      "verificationWaitAccepted" in record &&
      head !== "" &&
      item.acceptedHead === head &&
      record.verificationWaitAccepted !== head
    );
  }

  private reverifyEligible(item: WorkItemRecord): boolean {
    return !item.cancelRequested && (item.state === "verifying" || item.state === "merge_queue");
  }

  private async reverifyJobCurrent(job: Job, item: WorkItemRecord): Promise<boolean> {
    if (await this.store.run((q) => jobVersionCurrentSteps(q, job))) return true;
    const runId = readString(job.payload, "verificationWaitRunId");
    return (
      runId !== null &&
      runId === item.currentRunId &&
      (await this.store.run((q) => refreshVerificationJobVersionSteps(q, job, runId, this.now())))
    );
  }

  private *verificationHolderSteps(
    q: Q,
    item: WorkItemRecord,
    includeContext = true,
  ): Steps<"process" | "runner" | null> {
    if (
      (includeContext && this.jobContexts.has(item.id)) ||
      (item.currentRunId !== null && this.live.get(item.currentRunId)?.itemId === item.id)
    )
      return "process";
    if (
      item.currentRunId !== null &&
      (yield* getRunSteps(q, item.currentRunId))?.status === "active" &&
      (yield* runnerHoldsRunWorkSteps(q, item.currentRunId, this.now(), item.cancelRequested)) &&
      !(yield* runnerWorkHasResultSteps(q, item.currentRunId))
    )
      return "runner";
    return null;
  }

  private verificationHolder(item: WorkItemRecord): Promise<"process" | "runner" | null> {
    return this.store.run((q) => this.verificationHolderSteps(q, item));
  }

  private async reverifyHeld(item: WorkItemRecord): Promise<boolean> {
    return (await this.verificationHolder(item)) !== null;
  }

  private async reverify(
    payload: unknown,
    jobId: number,
    onOwned: () => Promise<void>,
  ): Promise<void> {
    const itemId = readString(payload, "itemId");
    if (itemId === null) return;
    const item = await this.store.run((q) => getWorkItemSteps(q, itemId));
    if (item === null || !this.reverifyEligible(item)) return;
    const repository = this.repositoryForItem(item);
    if (repository === null || repository === undefined) {
      await this.fail(item, "no_repository", "No repository is selected for this item.");
      return;
    }
    const { repo: worktree, ref } = await this.legacyItemHead(item);
    let head = "";
    let base = item.checkpoint?.baseSha ?? "";
    try {
      head = (await git(["-C", worktree, "rev-parse", ref])).trim();
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
          .catch((caughtError8) => {
            journalCaught(
              caughtError8,
              "orchestrator.reverify.then",
              itemId,
              undefined,
              this.options.journal,
            );
            return "origin/main";
          });
        base = (await git(["-C", worktree, "merge-base", ref, upstream])).trim();
      }
    } catch (error) {
      if (isTransient(error)) throw error;
      journalCaught(error, "orchestrator.reverify.trim", itemId, undefined, this.options.journal);
      const message = error instanceof Error ? error.message : String(error);
      await this.fail(item, "reverify", message, error);
      return;
    }
    if (item.state !== "verifying" && item.state !== "merge_queue") return;
    if (this.acceptedWhileWaiting(payload, item, head)) {
      this.options.journal?.(
        `reverify job ${jobId} for item ${itemId} ends: the check run it waited for accepted ${head}`,
      );
      return;
    }
    const candidate = await this.candidateForItem(item);
    if (!candidate) return;
    await this.evaluateHead(item, worktree, base, head, candidate, {
      decide: readBoolean(payload, "decide") === true,
      reverifyJobId: jobId,
      onOwned,
    });
  }

  private candidatePolicy(item: WorkItemRecord, worktree: string) {
    const { home, policyRoot } = this.closeoutHome(item);
    return candidatePolicyDigests(worktree, home, policyRoot, this.runCheckout(item).checks);
  }

  private unreadableMainPolicy(item: WorkItemRecord): MainPolicyError | null {
    try {
      const read = this.candidatePolicy(item, this.itemHead(item).repo);
      return read !== null && "ok" in read ? read : null;
    } catch (caughtError) {
      journalCaught(
        caughtError,
        "orchestrator.unreadableMainPolicy",
        item.id,
        undefined,
        this.options.journal,
      );
      return null;
    }
  }

  private async retryPolicyBlocks(item: WorkItemRecord, main: string): Promise<void> {
    const repository = this.repositoryForItem(item);
    if (!repository) return;
    const name = `${repository.owner}/${repository.repo}`;
    if ((await this.store.run((q) => listOpenPolicyBlocksSteps(q, name))).length === 0) return;
    await retryPolicyBlocks(this.db, {
      repository: name,
      main,
      policy: this.candidatePolicy(item, this.itemHead(item).repo),
      now: this.now(),
    });
  }

  private riskDisplayInputs(item: WorkItemRecord, worktree: string) {
    const settings = this.riskDisplayReader.inputs();
    let policyDigest: string | null = null;
    let policyPaths: readonly string[] | null = null;
    let policyFiles: ReturnType<RiskDisplayReader["observeFiles"]> = [];
    try {
      if (settings.autoApproveHighRisk) {
        const read = this.candidatePolicy(item, worktree);
        const current = read !== null && !("ok" in read) ? read : null;
        policyDigest = current?.digest ?? null;
        policyPaths = current?.paths ?? null;
        const { home, policyRoot } = this.closeoutHome(item);
        // A runner-backed item has no checkout to observe; its head already names its files.
        const checkout = this.itemHead(item).ref === "HEAD" ? [worktree] : [];
        const roots = [...checkout, ...(home ? [home] : []), ...(policyRoot ? [policyRoot] : [])];
        policyFiles = this.riskDisplayReader.observeFiles(
          roots.flatMap((root) =>
            [...(policyPaths ?? []), ".paws/high-risk-paths"].map((path) => join(root, path)),
          ),
        );
      }
    } catch (error) {
      journalCaught(
        error,
        "orchestrator.riskDisplayInputs",
        item.id,
        undefined,
        this.options.journal,
      );
    }
    return { ...settings, policyDigest, policyPaths, policyFiles };
  }

  private async merge(payload: unknown, jobId: number): Promise<MergeStep> {
    const itemId = readString(payload, "itemId");
    if (itemId === null) return { kind: "obsolete" };
    const run: MergeRun = { payload, jobId };
    let policy: MergeSettings | undefined;
    const mergePolicy = () => (policy ??= this.readMergePolicy());
    // The lane calls this again after async publication checks, so keep digest reads fresh.
    const policyDigests = (item: WorkItemRecord, worktree: string) => {
      return this.candidatePolicy(item, worktree);
    };
    return advanceMerge(
      this.db,
      this.store,
      { itemId, payload, jobId },
      {
        ...this.orderCapabilities(itemId),
        publish: (item) => this.publishForMerge(item, run),
        ...(this.options.runnerRebase ? { runnerRebase: this.options.runnerRebase } : {}),
        settings: (item, signal) => this.mergeSettingsFor(item, signal, mergePolicy),
        policyDigests,
        holdForPolicy: (item, repository, unreadable) =>
          holdForPolicyOutage(this.db, {
            item,
            repository,
            unreadable,
            now: this.now(),
            publicUrl: this.options.publicUrl ?? null,
          }),
        policyLoads: (repository) => {
          policyLoads(this.db, repository, this.now());
        },
        mergeResultPolicy: (_, worktree, heads) => {
          const error = mergeResultPolicyError(worktree, heads.base, heads.head);
          return error === undefined ? undefined : { error, reference: POLICY_SCHEMA_SUMMARY };
        },
        packages: (repository) => this.repositoryPackages(repository),
        assertReady: (item) =>
          this.assertPublicationReady(item, "merge", run.signal!, run.publicationCandidate),
        riskApproval: (item, published) => {
          const context = this.riskDisplayInputs(item, published.worktree);
          const { autoApproveHighRisk, policyDigest, policyPaths } = context;
          let approvedHead: string | undefined;
          let approvalKind: "exact" | "same_patch" | "fix" | undefined;
          return riskApprovalFor(this.db, {
            itemId: item.id,
            head: published.head,
            publicUrl: this.options.publicUrl,
            onHumanApproval: (head, kind) => {
              approvedHead = head;
              approvalKind = kind;
            },
            autoApproveHighRisk,
            policyDigest,
            policyPaths,
            journal: this.options.journal,
            samePatch: (approved, base) =>
              samePatch(published.worktree, approved, published.head, base),
            fixRisk: (approved, base) => this.fixRisk(item, published, approved, base),
            now: this.now(),
          }).then(async (approval) => {
            await this.riskDisplayReader.remember(item.id, published.head, {
              ...context,
              ...(approvedHead ? { approvedHead, approvalKind } : {}),
            });
            return approval;
          });
        },
        askRiskApproval: async (item, published) => {
          const asked = await askRiskApproval(this.db, {
            item,
            head: published.head,
            publicUrl: this.options.publicUrl ?? null,
            now: this.now(),
          });
          if (asked !== "asked") return { kind: "obsolete" };
          await this.flush(published.signal);
          return { kind: "asked" };
        },
        mergedOutsideLane: (item) => this.mergedOutsideLane(item),
        rerunCi: (item, pullNumber, reason) => this.rerunCi(item, pullNumber, reason),
        completed: () => this.dispatch(),
      },
    );
  }

  private async rerunCi(item: WorkItemRecord, pullNumber: number, reason: string): Promise<string> {
    const repository = this.repositoryForItem(item);
    const github = repository ? this.githubForRepository(repository) : null;
    if (!repository || !github) return "no GitHub binding for the item";
    return rerunItemCi({
      db: this.db,
      itemId: item.id,
      label: item.linearIdentifier,
      reason,
      github: {
        client: github.client,
        owner: repository.owner,
        repo: repository.repo,
        prNumber: pullNumber,
        ...this.gitHubCredentials(github),
      },
      now: () => this.now(),
      journal: this.options.journal,
      requestedBy: "Paws",
    });
  }

  /** The merge of the item's pull request when a person merged it on GitHub, outside the lane. */
  private async mergedOutsideLane(
    item: WorkItemRecord,
  ): Promise<Omit<ConfirmedRemoteMerge, "itemId" | "confirmedAt"> | null | "unknown"> {
    const pull = await this.store.run((q) => getItemPullRequestSteps(q, item.id));
    const repository = pull ? this.repositoryForItem(item) : null;
    const github = repository ? this.githubForRepository(repository) : null;
    if (!pull) {
      if (await this.store.run((q) => mergeCallInFlightSteps(q, item.id)))
        throw new Error("Cannot reconcile an in-flight merge: the pull request record is missing.");
      return null;
    }
    if (!repository || !github) return "unknown";
    const read = await readPullMerge({
      client: github.client,
      owner: repository.owner,
      repo: repository.repo,
      number: pull.pullNumber,
      ...this.gitHubCredentials(github),
      signal: AbortSignal.timeout(10_000),
    }).catch((caughtError) => {
      journalCaught(
        caughtError,
        "orchestrator.mergedOutsideLane.readPullMerge",
        item.id,
        undefined,
        this.options.journal,
      );
      return null;
    });
    if (read === null) return "unknown";
    if (!read.merged) return null;
    return {
      repositoryOwner: repository.owner,
      repositoryName: repository.repo,
      pullNumber: pull.pullNumber,
      pullUrl: read.url ?? pull.pullUrl,
      mergeSha: read.sha,
    };
  }

  private *activateForMergeSteps(q: Q, item: WorkItemRecord): Steps<void> {
    const sessionId = item.sessionKey;
    const session = sessionId ? yield* getLinearSessionSteps(q, sessionId) : null;
    if (!sessionId || !session) return;
    const activeId = session.activeItemId;
    if (
      activeId &&
      activeId !== item.id &&
      (yield* listInFlightItemsSteps(q)).some((entry) => entry.id === activeId)
    )
      throw new LinearReconciliationPendingError("Another Linear task owns this session");
    yield* activateLinearItemSteps(q, sessionId, item.id);
  }

  private async publishForMerge(
    item: WorkItemRecord,
    run: MergeRun,
  ): Promise<MergePublication | MergeStep> {
    await this.reconcileForMerge(item, run);
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
    if (!(await this.admission.canMerge(item.id)).ok)
      throw new LinearReconciliationPendingError("Linear dependencies are still running");
    await this.store.transaction((q) => this.activateForMergeSteps(q, item));
    const live = this.live.get(`operation:${item.id}`);
    if (!live) throw new Error("GitHub publication has no owned operation.");
    run.publicationCandidate = mergeCandidate(item, run.payload);
    const freshReads = new Set<string>();
    const repositoryName = `${repository.owner}/${repository.repo}`;
    const github = guardGitHubPublication({
      github: configuredGitHub,
      repository,
      signal: live.controller.signal,
      ...(this.options.publicationGitExec ? { gitExec: this.options.publicationGitExec } : {}),
      // During a push outage only the probe pushes; the first push that works ends it.
      push: {
        before: () => holdPush(this.db, repositoryName, run.jobId),
        after: () => this.pushWorked(repositoryName),
      },
      onCleanupFailure: () => this.blockConversation(item.id),
      isCurrent: () =>
        !this.stopped(item.id) &&
        (live.sessionId === null ||
          getLinearSessionGeneration(this.db, live.sessionId) === live.generation),
      assert: async (purpose, merging) => {
        const current = await this.store.run((q) => getWorkItemSteps(q, item.id));
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
    const { repo: worktree, ref } = await this.legacyItemHead(item);
    const summary = readString(run.payload, "summary") ?? "Closeout accepted.";
    const policy = await this.commitPolicy(item);
    if (this.stopped(item.id)) return { kind: "obsolete" };
    if (!(await this.store.run((q) => artifactPublicationReadySteps(q, item.id))))
      return {
        kind: "failed",
        reason: "artifact_upload",
        message: "A requested artifact has not been uploaded successfully.",
      };
    const risk = await this.classifyRisk(
      item,
      worktree,
      repository,
      run.publicationCandidate,
      live.controller.signal,
    );
    if (this.stopped(item.id)) return { kind: "obsolete" };
    await this.pullCloseoutEvidence(item);
    const publicUrl = this.options.evidence?.publicUrl ?? this.options.publicUrl ?? null;
    const open: OpenItems = {
      findings: await openFindings(
        this.store,
        item,
        run.publicationCandidate?.sha ?? null,
        this.options.pawsRoot,
      )
        .then(async (findings) =>
          withDecisions(findings, await this.store.run((q) => suggestedFindingsSteps(q, item.id))),
        )
        .catch((error: unknown) => {
          journalCaught(
            error,
            "orchestrator.publishForMerge.openFindings",
            item.id,
            undefined,
            this.options.journal,
          );
          return [];
        }),
      risk,
      link: pawsIssueUrl(publicUrl, item),
    };
    const openLine = openFindingsLine(open);
    const candidateHead = await git(["-C", worktree, "rev-parse", ref])
      .then((head) => head.trim())
      .catch((caughtError: unknown) => {
        journalCaught(
          caughtError,
          "orchestrator.publishForMerge.candidateHead",
          item.id,
          undefined,
          this.options.journal,
        );
        return null;
      });
    if (this.stopped(item.id)) return { kind: "obsolete" };
    const newPublication =
      candidateHead === null ||
      (await this.store.run((q) => getItemPullRequestSteps(q, item.id))) === null ||
      (await this.store.run((q) => getPublishedHeadSteps(q, item.id))) !== candidateHead;
    if (newPublication) this.sessionProgress(item)?.phase("publishing");
    const draft = await this.store.run((q) => getPullRequestDraftSteps(q, item.id));
    const screenshots = await pullRequestScreenshots({
      db: this.db,
      itemId: item.id,
      storage: this.evidenceStorage(),
      owner: repository.owner,
      repo: repository.repo,
      store: (files) =>
        storeEvidenceFiles({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          issue: item.linearIdentifier,
          files,
          signal: live.controller.signal,
          ...this.gitHubCredentials(github),
        }),
      ...(this.options.journal ? { journal: this.options.journal } : {}),
    });
    if (this.stopped(item.id)) return { kind: "obsolete" };
    const evidence = [
      summary,
      riskLine(risk),
      await visualReviewPullRequestNote(
        this.store,
        item,
        this.options.evidence?.publicUrl ?? null,
        this.now(),
      ),
      screenshots,
      policy ? policyPullRequestCredit(policy) : "",
      openFindingsSection(open),
    ]
      .filter(Boolean)
      .join("\n\n");
    const title = draft?.title ?? item.title;
    const published = await publishAccepted({
      accepted: true,
      evidence,
      worktree,
      ...(ref === "HEAD" ? {} : { ref }),
      issue: item.linearIdentifier,
      branchKey: taskBranchKey(item),
      owner: repository.owner,
      repo: repository.repo,
      title,
      ...(draft ? { description: draft.body } : {}),
      reviewer: (await this.store.run((q) => getItemRunCommitPolicySteps(q, item.id)))?.credit
        ?.login,
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
    if ((await this.store.run((q) => getWorkItemSteps(q, item.id)))?.state === "awaiting_input")
      return { kind: "obsolete" };
    if (!published.published)
      return { kind: "failed", reason: "publish", message: published.reason };
    if (newPublication)
      await this.store.run((q) =>
        recordItemCandidateSteps(q, {
          itemId: item.id,
          sha: published.head,
          branch: item.branchName,
          recordedAt: this.now(),
        }),
      );
    await this.store.run((q) =>
      recordItemPullRequestSteps(q, {
        itemId: item.id,
        pullNumber: published.pull.number,
        pullUrl: published.pull.url ?? null,
        openedAt: this.now(),
      }),
    );
    await this.store.run((q) =>
      savePullRequestTextSteps(
        q,
        item.id,
        {
          title,
          body: publishedPullRequestBody({
            issue: item.linearIdentifier,
            ...(draft ? { description: withLeftForLater(draft.body, draft.remaining ?? []) } : {}),
            evidence,
          }),
          evidence,
        },
        this.now(),
      ),
    );
    await this.store.run((q) =>
      saveOpenFindingsSteps(q, {
        itemId: item.id,
        head: published.head,
        line: openLine,
        now: this.now(),
      }),
    );
    if (risk?.tier === "high")
      await this.riskDisplayReader.remember(
        item.id,
        published.head,
        this.riskDisplayInputs(item, worktree),
      );
    await this.postReviewReplies(item, github, repository, published.pull.number, published.head);
    const sessionKey = item.sessionKey;
    const generation = sessionKey
      ? await this.store.run((q) => getLinearSessionGenerationSteps(q, sessionKey))
      : 0;
    this.post(
      item,
      "response",
      pullRequestReadyResponse({
        itemId: item.id,
        head: published.head,
        pull: published.pull,
        risk,
        openLine,
        riskApproval: () =>
          this.riskDisplay(item.id, published.head)?.detail ?? "Manual approval required",
        journal: this.options.journal,
      }),
      `pull-request-ready:${item.id}:${generation}`,
      {},
      "ordered",
    );
    this.attachEvidence(item, published.head);
    const sessionProgress = this.sessionProgress(item);
    if (published.pull.url) sessionProgress?.link("Pull request", published.pull.url);
    if (newPublication || published.head !== candidateHead) sessionProgress?.phase("merging");
    else sessionProgress?.reach("merging");
    await this.flush(live.controller.signal);
    if (
      this.suggestedFindingsMode(repositoryName) === "own_turn" &&
      (await startSuggestionTurn(this.store, {
        itemId: item.id,
        head: published.head,
        suggestions: undecidedSuggestions(open.findings).length,
        now: this.now(),
      })) === "started"
    )
      return { kind: "returned" };
    run.signal = live.controller.signal;
    return {
      github,
      repository,
      pull: published.pull,
      head: published.head,
      worktree,
      ...(ref === "HEAD" ? {} : { ref }),
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

  /**
   * Classifies the head about to be published and stores its tier. The settings globs are read
   * on every publication, so a change in Settings › Merging applies to the next head. When the
   * paths cannot be read the head gets no stored tier and the pull request says the risk is
   * unknown; a head without a stored tier is unclassified, never normal.
   */
  private async classifyRisk(
    item: WorkItemRecord,
    worktree: string,
    repository: RepositoryBinding,
    candidate: { sha: string; baseSha: string } | undefined,
    signal: AbortSignal,
  ): Promise<RiskClassification | null> {
    try {
      return await this.classifyHeadRisk(item, worktree, repository, candidate);
    } catch (error) {
      signal.throwIfAborted();
      if (isTransient(error)) throw error;
      journalCaught(error, "orchestrator.classifyRisk", item.id, undefined, this.options.journal);
      return null;
    }
  }

  private async classifyHeadRisk(
    item: WorkItemRecord,
    worktree: string,
    repository: RepositoryBinding,
    candidate: { sha: string; baseSha: string } | undefined,
  ): Promise<RiskClassification> {
    const run = (args: string[]) => git(["-C", worktree, ...args]);
    const { ref } = this.itemHead(item);
    const head = (await run(["rev-parse", ref])).trim();
    const base =
      candidate?.sha === head
        ? candidate.baseSha
        : (await run(["merge-base", ref, await this.upstreamMainRef(worktree, item.id)])).trim();
    const changed = await changedPaths(run, base, head);
    // Every changed path, so the scheduler can hold work that changes the same hot files.
    await this.store.run((q) =>
      saveCandidatePathsSteps(q, { itemId: item.id, head, paths: changed, recordedAt: this.now() }),
    );
    const risk = await classifyPathsRisk({
      git: run,
      base,
      changed,
      settingsGlobs: highRiskPaths(
        readMergeSettings(loadConfigFile(join(this.options.pawsRoot, "config.toml"))),
        `${repository.owner}/${repository.repo}`,
      ),
    });
    await this.store.run((q) =>
      saveCandidateRiskSteps(q, { itemId: item.id, head, base, ...risk, classifiedAt: this.now() }),
    );
    return risk;
  }

  /**
   * The files the fix from the approved head to the published head changed, and which of them
   * are high-risk against the repository's settings globs and `.paws/high-risk-paths` at main's
   * `base`. Null when the head is no fix on the approved patch, as after a rebase that changed
   * it, or when git cannot read it, so the head asks again rather than carrying over.
   */
  private async fixRisk(
    item: WorkItemRecord,
    published: MergePublication,
    approved: string,
    base: string,
  ): Promise<FixRisk | null> {
    try {
      const changed = await fixChangedPaths(published.worktree, approved, published.head, base);
      if (changed === null) return null;
      const { owner, repo } = published.repository;
      const risk = await classifyPathsRisk({
        git: (args) => git(["-C", published.worktree, ...args]),
        base,
        changed,
        settingsGlobs: highRiskPaths(
          readMergeSettings(loadConfigFile(join(this.options.pawsRoot, "config.toml"))),
          `${owner}/${repo}`,
        ),
      });
      return { changed, paths: risk.paths };
    } catch (error) {
      published.signal.throwIfAborted();
      if (isTransient(error)) throw error;
      journalCaught(error, "orchestrator.fixRisk", item.id, undefined, this.options.journal);
      return null;
    }
  }

  private async upstreamMainRef(worktree: string, itemId: string): Promise<string> {
    return git(["-C", worktree, "rev-parse", "--verify", "--quiet", UPSTREAM_MAIN_REF])
      .then(() => UPSTREAM_MAIN_REF)
      .catch((caughtError) => {
        journalCaught(
          caughtError,
          "orchestrator.upstreamMainRef",
          itemId,
          undefined,
          this.options.journal,
        );
        return "origin/main";
      });
  }

  private async settleMerge(payload: unknown, step: MergeStep): Promise<void> {
    if (step.kind !== "failed" && step.kind !== "merged") return;
    const item = await this.store.run((q) =>
      getWorkItemSteps(q, readString(payload, "itemId") ?? ""),
    );
    if (!item) return;
    if (step.kind === "failed") {
      await this.fail(item, step.reason, step.message);
      return;
    }
    const repository = this.repositoryForItem(item);
    if (repository) await this.completeMerge(item, repository);
  }

  private async completeMerge(item: WorkItemRecord, repository: RepositoryBinding): Promise<void> {
    const merged = await this.store.transaction((q) =>
      completeMergedItemSteps(q, {
        itemId: item.id,
        now: this.now(),
        announce: (current) => {
          this.sessionProgress(current)?.phase("completed");
          this.postStatus(current, "completed");
        },
      }),
    );
    if (!merged) return;
    wakeMergesBehind(this.db, this.now());
    await (this.options.remoteExecution ? removeCandidateRef : removeWorktree)({
      owner: repository.owner,
      repo: repository.repo,
      itemId: itemPathId(item),
      pawsRoot: this.options.pawsRoot,
    }).catch((caughtError9) => {
      journalCaught(
        caughtError9,
        "orchestrator.completeMerge.removeWorktree",
        item?.id,
        undefined,
        this.options.journal,
      );
      return undefined;
    });
    await this.dispatch();
    await this.flush();
  }

  private orderCapabilities(itemId: string): OrderCapabilities {
    return {
      ask,
      now: () => this.now(),
      stopped: () => this.stopped(itemId),
      session: (item) => this.activitySession(item),
      fetchMain: (item) => this.fetchUpstreamMain(item),
      ciFixAttempts: (item) => this.fixRoundLimit(item),
      feedbackWait: () => this.feedbackWait(),
      readPullCi: async (item, pull) => {
        const repository = this.repositoryForItem(item);
        const github = repository ? this.githubForRepository(repository) : null;
        if (!repository || !github)
          return { state: "unknown", message: "GitHub App is not configured." };
        return readPullCi({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          prNumber: pull.number,
          head: pull.head,
          ...this.gitHubCredentials(github),
        });
      },
      readPull: (item, pullNumber) =>
        this.readItemPull(item, pullNumber, this.signalForItem(item.id)),
      restart: (item, handoff) => this.restartWithStoredFeedback(item, handoff),
      dependencyHold: (id) => {
        // Only unmet dependencies; a pending reconciliation keeps its own retry in mergeAttempt.
        // Stays sync: the merge queue calls this as a predicate inside listMergeQueuesSteps.
        const admitted = settled(this.admission.canMerge(id));
        if (admitted.ok || admitted.held !== "blocked") return null;
        return openBlockers(this.db, id);
      },
      mergeLane: (item) =>
        mergeLaneKey(getWorkItemLinearProjectId(this.db, item.id), this.readMergePolicy()),
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
    this.sessionProgress(item)?.mergeStatus(body);
    void this.flush().catch((caughtError10) => {
      journalCaught(
        caughtError10,
        "orchestrator.statusAfterPullRequest.flush",
        item?.id,
        undefined,
        this.options.journal,
      );
    });
  }

  /** Progress is quiet once the pull request is open, so this posts like the pull request note. */
  private postAfterPullRequest(item: WorkItemRecord, body: string, key: string): void {
    if (this.stopped(item.id)) return;
    this.post(item, "response", body, key, { id: randomUUID() }, "ordered");
  }

  /** `[queue] start_timeout_hours`, read on every dispatch. Missing or unreadable means 24. */
  private queueStartTimeoutHours(): number {
    try {
      return readQueueSettings(loadConfigFile(join(this.options.pawsRoot, "config.toml")))
        .startTimeoutHours;
    } catch (caughtError11) {
      journalCaught(
        caughtError11,
        "orchestrator.queueStartTimeoutHours.readQueueSettings",
        null,
        undefined,
        this.options.journal,
      );
      return DEFAULT_QUEUE_START_TIMEOUT_HOURS;
    }
  }

  private repositoryPackages(repository: string): string[] {
    try {
      return repositoryPackages(
        readMergeSettings(loadConfigFile(join(this.options.pawsRoot, "config.toml"))),
        repository,
      );
    } catch (caughtError) {
      journalCaught(
        caughtError,
        "orchestrator.repositoryPackages",
        null,
        undefined,
        this.options.journal,
      );
      return [];
    }
  }

  private fixRoundLimit(item: WorkItemRecord): number {
    const { home, policyRoot } = this.closeoutHome(item);
    return policyFixBudget(this.itemHead(item).repo, home, policyRoot) ?? 3;
  }

  /**
   * The limit a fix-attempt line names for this round. Closeout findings also end when a failed
   * check spends its attempts, so their restart records whichever limit stops the item first.
   */
  private fixAttemptLimit(item: WorkItemRecord, reason: string): number {
    const rounds = this.fixRoundLimit(item);
    if (reason !== "findings") return rounds;
    return Math.min(rounds, restartLimit(this.db, item.id) ?? rounds);
  }

  private feedbackWait(): PullFeedbackWait {
    let wait = DEFAULT_COMMENT_WAIT;
    try {
      wait = this.readMergePolicy().commentWait;
    } catch (caughtError) {
      journalCaught(
        caughtError,
        "orchestrator.feedbackWait",
        null,
        undefined,
        this.options.journal,
      );
    }
    return {
      quietMs: wait.quietSeconds * 1000,
      maxMs: wait.maxWaitSeconds * 1000,
      reviewMaxMs: wait.reviewWaitMaxSeconds * 1000,
    };
  }

  private suggestedFindingsMode(repository: string) {
    try {
      return suggestedFindingsMode(this.readMergePolicy(), repository);
    } catch (error) {
      journalCaught(
        error,
        "orchestrator.suggestedFindingsMode",
        null,
        undefined,
        this.options.journal,
      );
      return "next_turn";
    }
  }

  private async fixCommit(repo: string, itemId: string, head: string): Promise<string | null> {
    const accepted =
      (await this.store.run((q) => getWorkItemSteps(q, itemId)))?.acceptedHead ?? null;
    if (accepted === null || accepted === head) return null;
    const added = await git(["-C", repo, "rev-list", "--count", `${accepted}..${head}`]).catch(
      () => "0",
    );
    return Number(added.trim()) > 0 ? head : null;
  }

  private async suggestionBrief(
    item: WorkItemRecord,
    repository: RepositoryBinding,
  ): Promise<string> {
    if (this.suggestedFindingsMode(`${repository.owner}/${repository.repo}`) === "off") return "";
    await this.pullCloseoutEvidence(item);
    const findings = undecidedSuggestions(
      await acceptedSuggestions(this.store, item, this.options.pawsRoot).catch((error: unknown) => {
        journalCaught(
          error,
          "orchestrator.suggestionBrief",
          item.id,
          undefined,
          this.options.journal,
        );
        return [];
      }),
    );
    await handSuggestions(this.store, item.id, findings, this.now());
    if (findings.length === 0) return "";
    return suggestedFindingsSection(
      findings.map((finding) => ({ ...finding, id: findingId(finding) })),
    );
  }

  private timeLimits(itemId: string): StageLimits | undefined {
    const limits = this.options.caps?.limits;
    if (limits === undefined) return undefined;
    return limits(getWorkItem(this.db, itemId)?.linearProjectId ?? null);
  }

  private readMergePolicy(): MergeSettings {
    return readMergeSettings(loadConfigFile(join(this.options.pawsRoot, "config.toml")));
  }

  /**
   * Settings → Merging for this task: an issue rule, then the Linear project, then the workspace
   * default. Resolved from the issue's project and labels once, then kept with the task. A failed
   * Linear read uses the workspace default for now and tries again next time.
   */
  private async mergeSettingsFor(
    item: WorkItemRecord,
    signal?: AbortSignal,
    readPolicy = () => this.readMergePolicy(),
  ): Promise<TaskMergeSettings> {
    const kept = await this.store.run((q) => getTaskMergeSettingsSteps(q, item.id));
    if (kept) return kept;
    const policy = readPolicy();
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
        journalCaught(
          error,
          "orchestrator.mergeSettingsFor.issueMergeContext",
          item.id,
          undefined,
          this.options.journal,
        );
      }
    }
    if (context?.overview !== undefined) {
      const overview = projectOverviewText(context.overview);
      await this.store.run((q) =>
        keepTaskLinearReadSteps(q, item.id, "project_overview", overview, this.now()),
      );
    }
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
    if (context !== null)
      await this.store.run((q) => keepTaskMergeSettingsSteps(q, item.id, settings, this.now()));
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
        this.assertJobCurrent(item.id);
        if (request.pushRejected && (await this.acceptedOnRemote(item, request.pushRejected))) {
          this.askedRuns.add(runId);
          await this.flush();
          return { answer: ACCEPTED_ON_REMOTE };
        }
        if (
          request.pushRejected?.conflicts &&
          (await restartForPushConflict(this.db, item.id, {
            branch: request.pushRejected.branch,
            files: request.pushRejected.conflicts,
            now: this.now(),
          }))
        ) {
          this.askedRuns.add(runId);
          await this.flush();
          return { answer: PUSH_CONFLICT_RESTARTED };
        }
        await this.store.transaction((q) =>
          this.recordAgentQuestionSteps(q, item, runId, sessionId, request),
        );
        this.askedRuns.add(runId);
        await this.flush();
        return {
          answer:
            "Question posted to the team. End your turn now without further changes; you will be resumed with the answer as your next message.",
        };
      },
    };
  }

  private *recordAgentQuestionSteps(
    q: Q,
    item: WorkItemRecord,
    runId: string,
    sessionId: string,
    request: Parameters<AskTeamHook["ask"]>[0],
  ): Steps<void> {
    ask(
      this.db,
      { itemId: item.id, runId, sessionId, version: item.version },
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
    const current = yield* getWorkItemSteps(q, item.id);
    if (current?.state === "running") {
      yield* saveCheckpointSteps(q, item.id, {
        ...current.checkpoint,
        phase: "awaiting_input",
        ...(current.checkpoint?.wipCommit ? { wipCommit: current.checkpoint.wipCommit } : {}),
        ...(current.checkpoint?.baseSha ? { baseSha: current.checkpoint.baseSha } : {}),
      });
    }
  }

  /**
   * A rejected candidate push of accepted work: when the branch on GitHub is the accepted head or
   * contains it, the item goes to the merge queue instead of asking. Anything else, or a failed
   * read, goes on to the question and the conflict handling.
   */
  private async acceptedOnRemote(
    item: WorkItemRecord,
    rejected: { branch: string },
  ): Promise<boolean> {
    const accepted =
      (await this.store.run((q) => getWorkItemSteps(q, item.id)))?.acceptedHead ?? null;
    const repository = accepted === null ? null : this.repositoryForItem(item);
    const github = repository ? this.githubForRepository(repository) : null;
    if (accepted === null || !repository || !github) return false;
    const remote = await branchContains({
      client: github.client,
      owner: repository.owner,
      repo: repository.repo,
      branch: rejected.branch,
      sha: accepted,
      ...this.gitHubCredentials(github),
      signal: AbortSignal.timeout(10_000),
    }).catch((caughtError) => {
      journalCaught(
        caughtError,
        "orchestrator.acceptedOnRemote.branchContains",
        item.id,
        undefined,
        this.options.journal,
      );
      return null;
    });
    if (remote === null) return false;
    return await settleRejectedPush(this.db, item.id, {
      remoteHead: remote.head,
      containsAccepted: remote.contains,
      now: this.now(),
    });
  }

  /**
   * A resume that brings nothing new for work Closeout accepted, while that head is the pull
   * request's head on GitHub, goes to the merge queue instead of starting an implement turn.
   */
  private async mergeInsteadOfTurn(job: Job, context: JobContext): Promise<boolean> {
    const itemId = readString(job.payload, "itemId");
    const item = itemId === null ? null : await this.store.run((q) => getWorkItemSteps(q, itemId));
    if (!item?.acceptedHead || !context.isCurrent()) return false;
    const reason = readString(job.payload, "reason");
    if (
      acceptedResumeNeedsTurn({
        acceptedHead: item.acceptedHead,
        pullHead: item.acceptedHead,
        reason,
        handoff: readString(job.payload, "handoff"),
      })
    )
      return false;
    const pull = await this.store.run((q) => getItemPullRequestSteps(q, item.id));
    const repository = pull ? this.repositoryForItem(item) : null;
    const github = repository ? this.githubForRepository(repository) : null;
    if (!pull || !repository || !github) return false;
    const pullHead = await readOpenPullHead({
      client: github.client,
      owner: repository.owner,
      repo: repository.repo,
      number: pull.pullNumber,
      ...this.gitHubCredentials(github),
      signal: AbortSignal.timeout(10_000),
    }).catch((caughtError) => {
      journalCaught(
        caughtError,
        "orchestrator.mergeInsteadOfTurn.readOpenPullHead",
        item.id,
        undefined,
        this.options.journal,
      );
      return null;
    });
    if (
      !context.isCurrent() ||
      acceptedResumeNeedsTurn({
        acceptedHead: item.acceptedHead,
        pullHead,
        reason,
        handoff: readString(job.payload, "handoff"),
      }) ||
      !mergeAcceptedWork(this.db, item.id, { now: this.now(), exceptJobId: job.id })
    )
      return false;
    await this.flush();
    return true;
  }

  private async releaseAskedRun(runId: string): Promise<void> {
    if (!this.askedRuns.delete(runId)) return;
    await this.store.run((q) => releaseRunCapacitySteps(q, runId, this.now()));
    const answered = await this.store.run((q) => latestRunningAnswerSteps(q, runId));
    if (!answered) return;
    await enqueueJobOnceAsync(this.store, {
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

  private async keepAskedWork(itemId: string, runId: string): Promise<void> {
    let current = await this.store.run((q) => getWorkItemSteps(q, itemId));
    if (!current || current.state === "cancelled" || current.cancelRequested) return;
    // Accepted work that went to the merge queue keeps its accepted head, not the rejected turn's.
    if (current.state === "merge_queue" && current.checkpoint?.wipCommit === current.acceptedHead)
      return;
    const sessionId = this.activitySession(current);
    if (
      current.state === "running" &&
      sessionId !== null &&
      findOpenQuestion(this.db, sessionId)?.runId === runId
    ) {
      awaitQuestion(this.db, current, findOpenQuestion(this.db, sessionId)!, this.now());
      current = await this.store.run((q) => getWorkItemSteps(q, itemId));
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
    const { repo: worktree, ref } = await this.legacyItemHead(current);
    let head = "";
    let base = current.checkpoint?.baseSha ?? "";
    try {
      head = (await git(["-C", worktree, "rev-parse", ref])).trim();
    } catch (caughtError13) {
      journalCaught(
        caughtError13,
        "orchestrator.keepAskedWork.trim",
        itemId,
        undefined,
        this.options.journal,
      );
      return;
    }
    if (base === "")
      base = await git(["-C", worktree, "merge-base", ref, "origin/main"]).then(
        (out) => out.trim(),
        (caughtError1) => {
          journalCaught(
            caughtError1,
            "orchestrator.keepAskedWork.git",
            itemId,
            undefined,
            this.options.journal,
          );
          return "";
        },
      );
    const saved = (await this.store.run((q) => getWorkItemSteps(q, itemId)))?.checkpoint;
    await this.store.run((q) =>
      saveCheckpointSteps(q, itemId, {
        ...saved,
        phase,
        ...(head === "" ? {} : { wipCommit: head }),
        ...(base === "" ? {} : { baseSha: base }),
      }),
    );
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
    } catch (caughtError14) {
      journalCaught(
        caughtError14,
        "orchestrator.deliverPrompt.parse",
        open.itemId,
        undefined,
        this.options.journal,
      );
    }
    const user = answerer(answeredBy);
    if (user === null) return "rejected";
    if (open.kind === "visual-review") {
      const review = getVisualReview(this.db, open.id);
      const item = await this.store.run((q) => getWorkItemSteps(q, open.itemId));
      if (review === null || item === null) return "rejected";
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
    // A reply never decides a link ask: it goes to the agent as guidance.
    if (open.kind === "link") {
      // On a visual review or a risk approval the reply requests changes, so only the delegator
      // or the lead may send it.
      const linkAsk = await this.store.run((q) => getLinkAskSteps(q, open.id));
      const item = await this.store.run((q) => getWorkItemSteps(q, open.itemId));
      if (
        (linkAsk?.kind === "screenshots" || linkAsk?.kind === "risk") &&
        item !== null &&
        !canAnswer({ kind: "link", allowedIds: linkAsk.answerers }, { id: answeredBy })
      ) {
        if (linkAsk.kind === "risk")
          postRiskActivity(this.db, {
            sessionId,
            item,
            kind: "thought",
            body: RISK_ANSWERERS,
            key: `refused:${event.dedupeKey}`,
            now: this.now(),
          });
        else
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
      const guided = await guideLinkAsk(this.db, {
        questionId: open.id,
        eventKey: event.dedupeKey,
        body: answer,
        answeredBy,
        now: this.now(),
      });
      if (guided) {
        this.abortItem(open.itemId);
        await this.dispatch();
      }
      await this.flush();
      return guided ? "answered" : "rejected";
    }
    // The installation check answers its own waiting question when the App returns.
    if (open.kind === "github-auth") return "rejected";
    if (!canAnswer({ kind: open.kind }, user)) return "rejected";
    if (
      open.kind === "push-outage" ||
      open.kind === "policy-outage" ||
      open.kind === "runner-repository"
    ) {
      const outcome = answerAsked(
        this.db,
        { sessionId, deliveryId: event.dedupeKey, body: answer, answeredBy, now: this.now() },
        questionEffects(this.db, {
          now: this.now(),
          maxAwakeMs: this.options.caps?.maxAwakeMs,
          timeLimits: this.options.caps?.limits,
        }),
      );
      await this.flush();
      return outcome.status === "answered" ? "answered" : "rejected";
    }
    if (open.kind === "runner-wait" || open.kind === "closeout-help") {
      const recovery = (
        await this.store.run((q) => listCloseoutRecoveriesSteps(q, open.itemId))
      ).find((entry) => entry.questionId === open.id);
      if (
        recovery &&
        (await this.store.run((q) => getWorkItemSteps(q, open.itemId)))?.state !== "awaiting_input"
      )
        return "rejected";
      const outcome = answerAsked(
        this.db,
        { sessionId, deliveryId: event.dedupeKey, body: answer, answeredBy, now: this.now() },
        questionEffects(this.db, {
          now: this.now(),
          maxAwakeMs: this.options.caps?.maxAwakeMs,
          timeLimits: this.options.caps?.limits,
        }),
      );
      await this.flush();
      return outcome.status === "answered" ? "answered" : "rejected";
    }
    const db = this.db;
    const now = () => this.now();
    const caps = this.options.caps;
    const journalTo = this.options.journal;
    const post = (item: WorkItemRecord, message: string) =>
      this.post(item, "error", message, `decision-rejected:${event.dedupeKey}`);
    const askedRuns = this.askedRuns;
    const outcome = await this.store.transaction(function* (q) {
      const item = yield* getWorkItemSteps(q, open.itemId);
      if (item?.state !== "awaiting_input") return "rejected" as const;
      if (answer.startsWith("/paws decision")) {
        try {
          const confirmed = confirmDecision(db, open.id, answer, answeredBy, now());
          if (confirmed === null)
            throw new Error("This suggestion is invalid. Answer this question in your own words.");
          answer = confirmed;
          yield* rewritePendingLinearTurnSteps(q, { sessionId, eventKey: event.dedupeKey }, answer);
        } catch (error) {
          journalCaught(
            error,
            "orchestrator.deliverPrompt.confirmDecision",
            open.itemId,
            undefined,
            journalTo,
          );
          post(
            item,
            error instanceof Error ? error.message : "Answer this question in your own words.",
          );
          return "rejected" as const;
        }
      }
      const answered = answerAsked(
        db,
        { sessionId, deliveryId: event.dedupeKey, body: answer, answeredBy, now: now() },
        questionEffects(db, {
          maxAwakeMs: caps?.maxAwakeMs,
          timeLimits: caps?.limits,
          now: now(),
          asking: (runId) => askedRuns.has(runId),
          redirect,
        }),
      );
      if (answered.status !== "answered") return "rejected" as const;
      return redirect ? ("redirect" as const) : ("answered" as const);
    });
    if (outcome === "redirect")
      for (const live of this.live.values())
        if (live.itemId === open.itemId) live.controller.abort(FOLLOW_UP_INTERRUPTION);
    if (outcome === "answered" && open.kind === "plan-approval") {
      const item = await this.store.run((q) => getWorkItemSteps(q, open.itemId));
      if (item?.state === "completed") this.sessionProgress(item, "plan")?.phase("completed");
    }
    await this.flush();
    return outcome;
  }

  private async stopSession(
    sessionId: string | null,
    eventKey: string,
    at: number,
    options: { keepPullRequest?: boolean } = {},
  ): Promise<void> {
    if (sessionId === null) return;
    this.taskAccess()?.invalidate({ sessionId });
    this.githubAuth?.invalidate({ sessionId });
    const requestedAt = at > 0 ? at : this.now();
    const commands: LinearCommand[] = [];
    let deferred = false;
    const notifications = { ready: false };
    const db = this.db;
    const itemsForSession = (id: string) => this.itemsForSession(id);
    const accepted = await this.store.transaction(function* (q) {
      if ((yield* acceptLinearStopSteps(q, sessionId, eventKey, requestedAt)) === null)
        return false;
      const items = itemsForSession(sessionId);
      if (items.length === 0) stopAdoptedParent(db, sessionId, requestedAt);
      if (items.length === 0)
        yield* enqueueOutboxOnceSteps(q, {
          target: "linear",
          op: "activity",
          orderingKey: sessionId,
          delivery: "stop",
          generation: yield* getLinearSessionGenerationSteps(q, sessionId),
          idempotencyKey: `command:stop:${sessionId}:${yield* getLinearSessionGenerationSteps(q, sessionId)}`,
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
        const result = yield* applyLinearCommandSteps(
          q,
          command,
          undefined,
          undefined,
          options,
          commandInstance(db),
          notifications,
        );
        if (result.deferred) {
          deferred = true;
          continue;
        }
        if (!result.applied) throw new Error(`Could not stop Linear task ${item.id}`);
        commands.push(command);
      }
      return true;
    });
    if (notifications.ready) emitJobReady(this.store);
    if (!accepted) return;
    try {
      for (const command of commands) this.bus.emit(command);
    } finally {
      if (deferred)
        await Promise.all(commands.map((command) => this.interruptItem(command.itemId)));
      else await this.interruptLinearSession(sessionId);
    }
    await this.flush();
  }

  private async assertReconciled(item: WorkItemRecord): Promise<void> {
    if (!(await this.admission.canDispatchDelegation(item.delegationId)))
      throw new LinearReconciliationPendingError(
        "Linear execution changes are still being reconciled",
      );
  }

  private async reconcileForMerge(item: WorkItemRecord, run: MergeRun): Promise<void> {
    if (await this.admission.canDispatchDelegation(item.delegationId)) return;
    const signal = this.live.get(`operation:${item.id}`)?.controller.signal;
    if (signal && this.options.publicationReady) {
      this.options.journal?.(
        `item ${item.linearIdentifier}: a merge attempt reconciles pending Linear changes`,
      );
      await this.options.publicationReady(
        item.id,
        "merge",
        signal,
        mergeCandidate(item, run.payload),
      );
      signal.throwIfAborted();
    }
    await this.assertReconciled(item);
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
    await this.assertReconciled(item);
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
          const dependents = openTaskDependents(this.db, changes.delegationId, item.linearIssueId);
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
        if (item.state === "manual") {
          // Intake saved the new brief in this transaction. Human ownership keeps its fence.
          cancelItemQuestions(this.db, itemId, this.now(), "criteria");
          if (
            !canReportSessionProgress(
              this.db,
              changes.sessionId,
              getLinearSessionGeneration(this.db, changes.sessionId),
            )
          )
            continue;
          const revision = itemSpecificationRevision(this.db, itemId) ?? 0;
          enqueueOutboxOnce(this.db, {
            target: "linear",
            op: "activity",
            orderingKey: changes.sessionId,
            idempotencyKey: `criteria-changed:${item.id}:manual:${revision}`,
            payload: {
              sessionId: changes.sessionId,
              kind: "thought",
              body: `${item.linearIdentifier} changed in Linear. The updated criteria are saved; ownership remains manual and automation will not resume.`,
            },
            now: this.now(),
          });
          continue;
        }
        cancelItemQuestions(this.db, itemId, this.now());
        if (item.state === "failed") {
          clearItemRecovery(this.db, itemId);
          resetAwakeTime(this.db, itemId);
        }
        if (item.state === "paused") {
          cancelOpenJobs(this.db, { itemId, reason: "Linear criteria changed", now: this.now() });
          bumpItemVersion(this.db, itemId);
          continue;
        }
        restart(this.db, item, {
          reason: "follow_up",
          body: "The task criteria changed in Linear. Read the updated issue and finish the work from its branch.",
          now: this.now(),
        });
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
    const now = () => this.now();
    const paused = await this.store.transaction(function* (q) {
      const item = yield* getWorkItemSteps(q, itemId);
      if (!canAct() || item?.state !== "running" || item.cancelRequested) return false;
      yield* applyWorkItemEventSteps(q, itemId, "pause");
      yield* cancelOpenJobsSteps(q, { itemId, reason: "Paused by a workspace member", now: now() });
      yield* loseActiveItemRunsSteps(q, itemId, now());
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
    if ((await this.store.run((q) => getWorkItemSteps(q, itemId)))?.state !== "paused")
      return false;
    await this.joinChangedItems([itemId]);
    const resumed = await this.store.transaction((q) =>
      this.resumeItemSteps(q, itemId, canAct, onCommitted),
    );
    if (resumed) await this.reconcileExecution();
    return resumed;
  }

  private *resumeItemSteps(
    q: Q,
    itemId: string,
    canAct: () => boolean,
    onCommitted?: () => void,
  ): Steps<boolean> {
    const item = yield* getWorkItemSteps(q, itemId);
    if (!canAct() || item?.state !== "paused" || item.cancelRequested) return false;
    const session = item.sessionKey ? yield* getLinearSessionSteps(q, item.sessionKey) : null;
    if (session?.stoppedAt != null)
      yield* advanceLinearSessionGenerationSteps(q, session.sessionId, { now: this.now() });
    cancelItemQuestions(this.db, item.id, this.now());
    restart(this.db, item, {
      reason: "follow_up",
      body: "Continue the task from its branch.",
      now: this.now(),
    });
    onCommitted?.();
    return true;
  }

  deliverInstanceCommands(): number {
    const self = this.options.instanceId;
    if (self === undefined) return 0;
    return drainInstanceCommands(
      this.db,
      self,
      ({ command, stoppedAtVersion }) => {
        const live = [...this.live.values()].filter((entry) => entry.itemId === command.itemId);
        const stopped = live.filter((entry) => entry.version < stoppedAtVersion);
        if (stopped.length === 0) return;
        if (stopped.length < live.length) {
          for (const entry of stopped) entry.controller.abort();
          return;
        }
        void this.interruptItem(command.itemId).catch((error) => {
          journalCaught(error, "orchestrator.deliverInstanceCommands", command.itemId);
        });
      },
      this.now(),
    );
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
    for (const itemId of affected)
      if ((await this.store.run((q) => getConversationSteps(q, itemId))).blocked)
        throw new Error("ACP process cleanup could not be verified");
    const failure = joined.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  }

  invalidateGitHubAuthorization(scope: { sessionId?: string; issueId?: string } = {}): void {
    this.githubAuth?.invalidate(scope);
  }

  async reconcileExecution(): Promise<void> {
    await this.dispatch();
  }

  async recoverStalledCloseout(): Promise<void> {
    await recoverStalledCloseout(this.db, {
      now: this.now(),
      cancel: (id) => this.joinChangedItems([id]),
      journal: this.options.journal ?? journal,
    });
  }

  async checkPolicyBlocks(): Promise<void> {
    for (const { itemId } of await policyBlockedRepositories(this.store)) {
      const item = await this.store.run((q) => getWorkItemSteps(q, itemId));
      if (!item) continue;
      await this.fetchUpstreamMain(item).catch((caughtError) =>
        journalCaught(
          caughtError,
          "orchestrator.checkPolicyBlocks",
          itemId,
          undefined,
          this.options.journal,
        ),
      );
    }
  }

  async sweepWorktrees(signal: AbortSignal): Promise<void> {
    await sweepCheckpointRefs({
      store: this.store,
      signal,
      remove: (repository, ref) => {
        const github = this.githubForRepository(repository);
        if (!github)
          return Promise.reject(
            new Error(`No GitHub App binding for ${repository.owner}/${repository.repo}`),
          );
        return deleteHiddenRef({
          client: github.client,
          owner: repository.owner,
          repo: repository.repo,
          ref,
          ...this.gitHubCredentials(github),
          signal,
        });
      },
    });
    const busy = (itemId: string) =>
      this.jobContexts.has(itemId) ||
      [...this.live.values()].some((live) => live.itemId === itemId);
    return sweepWorktrees({
      store: this.store,
      pawsRoot: this.options.pawsRoot,
      now: this.now(),
      signal,
      runnerBacked: this.options.remoteExecution !== undefined,
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

  async dependencyHandoff(itemId: string): Promise<string | undefined> {
    return await this.store.run((q) => this.dependencyHandoffSteps(q, itemId));
  }

  private *dependencyHandoffSteps(q: Q, itemId: string): Steps<string | undefined> {
    const item = yield* getWorkItemSteps(q, itemId);
    if (!item) return undefined;
    const blockers = yield* landedTaskBlockersSteps(q, item.delegationId, item.linearIssueId);
    const active = new Set<string>();
    for (const id of yield* listItemIdsSteps(q, false))
      if ((yield* getWorkItemSteps(q, id))?.delegationId === item.delegationId) active.add(id);
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

  private async dispatch(): Promise<void> {
    const ownerHasRunner = this.options.ownerHasRunner;
    let config: ReturnType<typeof loadConfigFile> | null = null;
    try {
      this.reconcileAgentSettings();
      if (ownerHasRunner || this.options.itemRunners)
        config = loadConfigFile(join(this.options.pawsRoot, "config.toml"));
    } catch (caughtError15) {
      journalCaught(
        caughtError15,
        "orchestrator.dispatch.loadConfigFile",
        null,
        undefined,
        this.options.journal,
      );
      config = null;
    }
    await dispatch(this.db, {
      store: this.store,
      now: this.now(),
      admission: this.admission,
      ...(this.options.journal ? { log: this.options.journal } : {}),
      handoffForItem: (q, itemId) => this.dependencyHandoffSteps(q, itemId),
      sessionFor: (q, itemId) => this.itemSessionSteps(q, itemId),
      ...this.options.scheduling?.(),
      onWaiting: (itemIds) => this.noteQueued(itemIds),
      onWaits: (waits) => this.noteWaits(waits),
      ...(this.options.itemRunners
        ? {
            itemRunners: (itemId: string) => {
              const item = getWorkItem(this.db, itemId);
              return item && config
                ? this.options.itemRunners!(
                    itemId,
                    this.implementerProfile(item, config),
                    this.now(),
                  )
                : null;
            },
          }
        : {}),
      ...(ownerHasRunner && config
        ? {
            ownerHasRunner: (q: Q, itemId: string) =>
              this.ownerHasRunnerSteps(q, itemId, ownerHasRunner, config),
            onRunnerSetup: (itemIds: readonly string[]) =>
              this.noteRunnerSetup(
                itemIds.filter((id) => !this.awaitsAdmissionLabels(id, config)),
                (item) => this.implementerAgent(item, config),
              ),
            ...(this.options.onRunnerHostRefusals
              ? { onRunnerHostRefusals: this.options.onRunnerHostRefusals }
              : {}),
          }
        : {}),
    });
  }

  private implementerAgent(item: WorkItemRecord, config: ReturnType<typeof loadConfigFile>) {
    return implementerAgentFor(config, this.repositoryForItem(item), this.knownProfileLabels(item));
  }

  private implementerProfile(item: WorkItemRecord, config: ReturnType<typeof loadConfigFile>) {
    const repository = this.repositoryForItem(item);
    return resolveAgentProfiles(
      config,
      repository ? `${repository.owner}/${repository.repo}` : undefined,
      this.knownProfileLabels(item),
    ).implementer;
  }

  private *itemSessionSteps(q: Q, itemId: string): Steps<string | null> {
    const item = yield* getWorkItemSteps(q, itemId);
    return item ? this.activitySession(item) : null;
  }

  private *ownerHasRunnerSteps(
    q: Q,
    itemId: string,
    ownerHasRunner: NonNullable<OrchestratorOptions["ownerHasRunner"]>,
    config: ReturnType<typeof loadConfigFile>,
  ): Steps<boolean | null> {
    const item = yield* getWorkItemSteps(q, itemId);
    if (!item) return null;
    const repository = yield* getWorkItemRepositorySteps(q, item.id);
    return ownerHasRunner(
      itemId,
      implementerAgentFor(config, repository, this.knownProfileLabels(item)),
      this.now(),
    );
  }

  /** The labels read for this queue entry, or else the ones the last run used. */
  private knownProfileLabels(item: WorkItemRecord): ProfileLabels | undefined {
    return (
      this.keptAdmissionLabels(item)?.labels ??
      (item.currentRunId ? this.readProfileSnapshot(item.currentRunId)?.profileLabels : undefined)
    );
  }

  private admissionLabelsFile(itemId: string): string {
    return join(runDir(this.options.pawsRoot, itemId), "admission-labels.json");
  }

  private keptAdmissionLabels(item: WorkItemRecord): { labels?: ProfileLabels } | null {
    const file = this.admissionLabelsFile(item.id);
    if (!existsSync(file)) return null;
    try {
      const kept = JSON.parse(readFileSync(file, "utf8")) as {
        version: number;
        labels?: ProfileLabels;
      };
      return kept.version === item.version ? kept : null;
    } catch (error) {
      journalCaught(
        error,
        "orchestrator.keptAdmissionLabels",
        item.id,
        undefined,
        this.options.journal,
      );
      return null;
    }
  }

  /**
   * Admission is synchronous and picks the agent before a run exists. An item about to be held
   * for a runner may carry a label that names an agent its owner can use, so its labels are read
   * once per queue entry, and the scheduler looks again. Returns whether that read is under way.
   * Without presets a label can't change the agent, and nothing is read.
   */
  private awaitsAdmissionLabels(
    itemId: string,
    config: ReturnType<typeof loadConfigFile>,
  ): boolean {
    if (this.admissionLabelReads.has(itemId)) return true;
    const item = getWorkItem(this.db, itemId);
    if (
      !item ||
      !this.tracker?.issueRepositoryHints ||
      Object.keys(readAgentSettings(config).presets ?? {}).length === 0 ||
      this.keptAdmissionLabels(item)
    )
      return false;
    this.admissionLabelReads.add(itemId);
    void this.readAdmissionLabels(item);
    return true;
  }

  private async readAdmissionLabels(item: WorkItemRecord): Promise<void> {
    try {
      const previous = item.currentRunId ? this.readProfileSnapshot(item.currentRunId) : null;
      const labels = await this.forItem({ itemId: item.id }, () =>
        this.readProfileLabels(item, previous?.profileLabels, previous?.defaultRoles),
      );
      mkdirSync(runDir(this.options.pawsRoot, item.id), { recursive: true, mode: 0o700 });
      writeFileSync(
        this.admissionLabelsFile(item.id),
        JSON.stringify({ version: item.version, labels }),
        { mode: 0o600 },
      );
      this.admissionLabelReads.delete(item.id);
      if (!this.shuttingDown) await this.dispatch();
    } catch (error) {
      this.admissionLabelReads.delete(item.id);
      journalCaught(
        error,
        "orchestrator.readAdmissionLabels",
        item.id,
        undefined,
        this.options.journal,
      );
    }
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
      settled(clearQueueWait(sqliteDb(this.db), item.id));
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

  private noteWaits(waits: readonly ItemWait[]): void {
    const current = new Set(waits.map((wait) => wait.itemId));
    for (const itemId of this.waitFaces.keys())
      if (!current.has(itemId)) this.waitFaces.delete(itemId);
    for (const wait of waits) {
      const round = wait.kind === "runner" && wait.restart ? fixRounds(this.db, wait.itemId) : 0;
      const face = JSON.stringify([wait, round]);
      if (this.waitFaces.get(wait.itemId) === face) continue;
      const item = getWorkItem(this.db, wait.itemId);
      if (!item || item.version !== wait.version || item.sessionKey !== wait.sessionId) continue;
      const mode = getTaskMode(this.db, item.id);
      const progress = this.sessionProgress(item, isResponseTaskMode(mode) ? mode : "code");
      if (!progress) continue;
      const name = item.linearIdentifier;
      if (wait.kind === "blocked") {
        const blockers = wait.blockers.length ? wait.blockers.join(", ") : "a blocking issue";
        progress.wait(`Wait for ${blockers}`, `${name}: waiting for ${blockers}`);
      } else if (wait.kind === "overlap") {
        progress.wait(
          `Wait for ${wait.blocker} to merge`,
          `${name} held: ${overlapLine(wait.blocker, wait.files, wait.start)}`,
        );
      } else if (wait.kind === "runner" && wait.restart) {
        const limit = this.fixAttemptLimit(item, wait.restart);
        const restarted = latestRestartEvent(this.db, item.id);
        if (restarted) progress.restart(wait.restart, round, restarted.version, limit);
        progress.restartWait(
          `${name}: waiting for a runner to ${
            wait.restart === "ci"
              ? `fix CI (${round} of ${limit})`
              : wait.restart === "review"
                ? `address the review (${round} of ${limit})`
                : wait.restart === "conflict"
                  ? "resolve a merge conflict"
                  : `fix Closeout findings (${round} of ${limit})`
          }`,
        );
      } else if (wait.kind === "runner")
        progress.wait(
          "Wait for a runner",
          wait.noRunner
            ? `${name}: ${wait.noRunner}`
            : `${name}: ${ordinal(wait.position)} in line for a runner`,
        );
      else if (wait.kind === "paused")
        progress.status(`${name}: paused by ${wait.by ?? "a workspace member"}`);
      else progress.status(`${name}: recovering an interrupted turn`);
      this.waitFaces.set(wait.itemId, face);
    }
  }

  private noteQueued(itemIds: readonly string[]): void {
    const now = this.now();
    const hours = this.queueStartTimeoutHours();
    for (const id of itemIds) {
      const item = getWorkItem(this.db, id);
      if (!item || item.state !== "queued" || item.cancelRequested) continue;
      if (hasOpenItemJob(this.db, JOB_KIND.start, item.id)) continue;
      const name = item.linearIdentifier ?? "this issue";
      if (
        now - settled(queueWaitSince(sqliteDb(this.db), item.id, item.version, now)) >=
        hours * 3_600_000
      ) {
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
      const position = settled(getQueuePosition(sqliteDb(this.db), item.id));
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

  private async ensureRun(item: WorkItemRecord): Promise<{ id: string }> {
    if (item.currentRunId !== null) {
      const existing = await this.store.run((q) => getRunSteps(q, item.currentRunId!));
      if (existing && (existing.status === "active" || existing.status === "ended")) {
        this.reconcileAgentSettings();
        await this.store.run((q) => markRunSteps(q, existing.id, "active", this.now()));
        await this.claimRun(existing.id);
        return existing;
      }
      // A runner-setup hold stopped this run before any work. The resume continues it, so the
      // task keeps one run.
      if (
        existing?.status === "lost" &&
        (await this.store.run((q) => takeRunnerSetupResumeSteps(q, item.id, existing.id)))
      ) {
        this.reconcileAgentSettings();
        await this.store.run((q) => markRunSteps(q, existing.id, "active", this.now()));
        await this.claimRun(existing.id);
        return existing;
      }
    }
    const repository = this.repositoryForItem(item);
    // A new run, including a retry, uses the profiles saved in Settings now (PAS-831).
    const config = loadConfigFile(join(this.options.pawsRoot, "config.toml"));
    const repoName = repository ? `${repository.owner}/${repository.repo}` : undefined;
    const previous = item.currentRunId ? this.readProfileSnapshot(item.currentRunId) : null;
    const defaultRoles = previous?.defaultRoles;
    const profileLabels = await this.readProfileLabels(item, previous?.profileLabels, defaultRoles);
    const profiles = withoutLabelProblems(resolveAgentProfiles(config, repoName, profileLabels));
    const run = await this.store.run((q) =>
      insertRunSteps(q, {
        itemId: item.id,
        now: this.now(),
        status: "active",
        kind: "implement",
        agent: profiles.implementer.agent,
        freshSession: true,
        ownerInstance: this.options.instanceId ?? null,
      }),
    );
    // Only an unannounced switch carries over, while it still changes the agent. A changed
    // Implementer label that changes the agent is announced the same way.
    const pending = previous?.settingsSwitch;
    const settingsSwitch =
      pending && pending.previousAgent !== profiles.implementer.agent
        ? pending
        : previous &&
            previous.profileLabels?.implementer !== profileLabels?.implementer &&
            previous.profiles.implementer.agent !== profiles.implementer.agent
          ? { id: randomUUID(), previousAgent: previous.profiles.implementer.agent }
          : undefined;
    mkdirSync(runDir(this.options.pawsRoot, run.id), { recursive: true, mode: 0o700 });
    writeFileSync(
      join(runDir(this.options.pawsRoot, run.id), "agent-profile.json"),
      JSON.stringify({ profiles, profileLabels, defaultRoles, settingsSwitch }),
      { mode: 0o600 },
    );
    await this.store.run((q) => setCurrentRunSteps(q, item.id, run.id));
    return run;
  }

  /** The issue's Implementer and Reviewer labels now, or `fallback` when Linear can't say. */
  private async readProfileLabels(
    item: WorkItemRecord,
    fallback: ProfileLabels | undefined,
    defaultRoles: readonly ProfileRole[] = [],
  ): Promise<ProfileLabels | undefined> {
    let labels = fallback;
    const tracker = this.tracker;
    if (tracker?.issueRepositoryHints) {
      try {
        const hints = await linearCaller("repository-hints", () =>
          tracker.issueRepositoryHints!(item.linearIssueId, {
            signal: this.signalForItem(item.id),
          }),
        );
        labels = hints.profileLabels;
      } catch (error) {
        journalCaught(
          error,
          "orchestrator.readProfileLabels",
          item.id,
          "Linear is unavailable; using the previous run's labels, or none",
          this.options.journal,
        );
      }
      this.assertJobCurrent(item.id);
    }
    if (labels === undefined) return undefined;
    const kept = { ...labels };
    for (const role of defaultRoles) delete kept[role];
    return kept;
  }

  /**
   * A run never starts on a guessed profile: an unusable label asks a person first. Returns
   * whether the run may go on. "Use the default" drops that role's label for this item.
   */
  private async checkProfileLabels(item: WorkItemRecord, runId: string): Promise<boolean> {
    const saved = this.readProfileSnapshot(runId);
    if (!saved) return true;
    const config = loadConfigFile(join(this.options.pawsRoot, "config.toml"));
    const repository = this.repositoryForItem(item);
    const repo = repository ? `${repository.owner}/${repository.repo}` : undefined;
    let resolved = resolveAgentProfiles(config, repo, saved.profileLabels);
    let answered = false;
    const question = saved.profileQuestion ? getQuestion(this.db, saved.profileQuestion) : null;
    if (resolved.labelProblems?.length && question?.status === "answered") {
      answered = true;
      if (question.answer === USE_THE_DEFAULT) {
        const roles = resolved.labelProblems.map((problem) => problem.role);
        saved.defaultRoles = [...new Set([...(saved.defaultRoles ?? []), ...roles])];
        for (const role of roles) delete saved.profileLabels?.[role];
      } else {
        saved.profileLabels = await this.readProfileLabels(
          item,
          saved.profileLabels,
          saved.defaultRoles,
        );
      }
      delete saved.profileQuestion;
      resolved = resolveAgentProfiles(config, repo, saved.profileLabels);
    }
    const problems = resolved.labelProblems ?? [];
    if (answered || problems.length > 0) saved.profiles = withoutLabelProblems(resolved);
    const snapshot = join(runDir(this.options.pawsRoot, runId), "agent-profile.json");
    if (problems.length > 0) {
      const body = profileLabelQuestion(
        problems,
        Object.keys(readAgentSettings(config).presets ?? {}),
      );
      const sessionId = this.activitySession(item);
      if (sessionId === null) {
        await this.fail(item, "profile_labels", body);
        return false;
      }
      this.assertJobCurrent(item.id);
      saved.profileQuestion = immediate(this.db, () => {
        const { question: asked } = ask(
          this.db,
          { itemId: item.id, runId, sessionId },
          "agent",
          body,
          { options: [USE_THE_DEFAULT, "I fixed the label"], now: this.now() },
        );
        closeActiveRun(this.db, runId, this.now());
        return asked.id;
      });
      writeFileSync(snapshot, JSON.stringify(saved), { mode: 0o600 });
      await this.flush();
      return false;
    }
    if (answered) writeFileSync(snapshot, JSON.stringify(saved), { mode: 0o600 });
    const sources = Object.entries(saved.profileLabels ?? {}).map(
      ([role, label]) => `${role === "implementer" ? "Implementer" : "Reviewer"}: ${label} (label)`,
    );
    if (sources.length > 0)
      this.post(item, "thought", sources.join("\n"), `${runId}:profile-labels`);
    return true;
  }

  private async continueAfterRateLimit(item: WorkItemRecord, retryAfterMs: number): Promise<void> {
    const key = `linear-rate-limit:${item.id}:${item.version}`;
    await enqueueJobOnceAsync(this.store, {
      queue: item.state === "running" ? JOB_KIND.resume : JOB_KIND.reverify,
      jobKey: key,
      payload: { itemId: item.id, reason: "linear-rate-limit" },
      runAt: this.now() + Math.max(retryAfterMs, RATE_LIMIT_RETRY_MS),
      now: this.now(),
    });
  }

  private async fail(
    item: WorkItemRecord,
    reason: string,
    text: string,
    cause?: unknown,
  ): Promise<void> {
    if (!(this.jobContexts.get(item.id)?.isCurrent() ?? true)) return;
    const current = (await this.store.run((q) => getWorkItemSteps(q, item.id))) ?? item;
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
      const failed = await this.store.transaction((q) =>
        failWorkItemSteps(q, current, reason, text, this.now()),
      );
      if (
        failed &&
        current.currentRunId &&
        (await this.store.run((q) => runnerWorkHasResultSteps(q, current.currentRunId!)))
      )
        await this.store.run((q) => releaseRunCapacitySteps(q, current.currentRunId!, this.now()));
    } else {
      this.post(current, "error", text, `fail:${current.id}:${current.version}:${reason}`);
    }
    await this.dispatch();
  }

  private planHook(
    item: WorkItemRecord,
    progress: { plan(steps: readonly SessionPlanStep[]): void } | null,
  ): UpdatePlanHook | undefined {
    if (!progress) return undefined;
    return {
      update: async (steps) => {
        if (this.stopped(item.id)) throw new Error("Plan updates are closed for this run");
        progress.plan(steps);
        await this.flush();
      },
    };
  }

  private agentCloseoutHook(item: WorkItemRecord, runId: string): CloseoutProgressHook {
    return {
      record: async (progress) => {
        if (this.stopped(item.id)) return;
        await this.store.transaction((q) =>
          recordAgentCloseoutSteps(q, runId, item.id, progress, this.now()),
        );
      },
    };
  }

  private savedDraft(itemId: string): PullRequestDraft | undefined {
    const draft = getPullRequestDraft(this.db, itemId);
    return draft ? { title: draft.title, body: draft.body } : undefined;
  }

  private pullRequestHook(item: WorkItemRecord): PullRequestHook {
    return {
      update: async (description) => {
        if (this.stopped(item.id)) throw new Error("Pull request updates are closed for this run");
        const previous = await this.store.run((q) => getPullRequestDraftSteps(q, item.id));
        await this.store.run((q) => savePullRequestDraftSteps(q, item.id, description, this.now()));
        const repository = this.repositoryForItem(item);
        const signal = this.signalForItem(item.id);
        await applyPullRequestDraft({
          store: this.store,
          itemId: item.id,
          issue: item.linearIdentifier,
          draft: description,
          previous,
          stopped: () => this.stopped(item.id),
          ...(signal ? { signal } : {}),
          repository,
          github: repository ? this.githubForRepository(repository) : null,
          now: this.now(),
          status: (line) => {
            for (const live of this.live.values())
              if (live.itemId === item.id) live.progress = line;
          },
          ...(this.options.journal ? { journal: this.options.journal } : {}),
        });
      },
    };
  }

  private updateHook(item: WorkItemRecord): PostUpdateHook {
    return {
      post: async (text, origin) => {
        if (!this.canReportProgress(item.id))
          throw new Error("Progress updates are closed for this run");
        const allowed = this.updates.take(item.id);
        if (allowed.posted) {
          const line = publicToolText(text);
          for (const live of this.live.values()) if (live.itemId === item.id) live.progress = line;
          const key = origin
            ? `update:${item.id}:${origin.runId}:${origin.generation}:${origin.sequence}`
            : `update:${item.id}:${this.now()}`;
          this.post(item, "thought", line, key);
          await this.flush();
        }
        return allowed;
      },
    };
  }

  private replyHook(item: WorkItemRecord): ReplyHook {
    return {
      post: async (text, origin) => {
        if (this.activitySession(item) === null)
          return { posted: false, reason: "this item has no Linear session" };
        const turn = origin ? `${origin.runId}:${origin.generation}` : (item.currentRunId ?? "");
        const sent = this.replies.get(item.id);
        const count = sent?.turn === turn ? sent.count : 0;
        if (count >= REPLIES_PER_TURN)
          return { posted: false, reason: `at most ${REPLIES_PER_TURN} replies per turn` };
        this.replies.set(item.id, { turn, count: count + 1 });
        const key = origin
          ? `reply:${item.id}:${origin.runId}:${origin.generation}:${origin.sequence}`
          : this.activityKey(`reply:${item.id}`);
        this.post(item, "response", publicToolText(text), key, {}, "ordered");
        await this.flush();
        return { posted: true };
      },
    };
  }

  private sessionProgress(item: WorkItemRecord, mode: TaskMode = "code") {
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

  /**
   * The outbox key for an agent update. An update read from a runner event is keyed by that event,
   * so a replay after a restart finds its earlier row. Any other update takes the next number
   * after the keys already stored, so a key from before a restart is not reused.
   */
  private activityKey(prefix: string, origin?: ActivityOrigin): string {
    if (origin)
      return `${prefix}:${origin.runId}:${origin.generation}:${origin.sequence}:${origin.part}`;
    const next = (this.activitySeqs.get(prefix) ?? lastOutboxSequence(this.db, `${prefix}:`)) + 1;
    this.activitySeqs.set(prefix, next);
    return `${prefix}:${next}`;
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
    const sessionId = this.activitySession(current);
    if (sessionId === null || body.trim() === "") return;
    if (
      !this.canReportProgress(item.id) &&
      (kind === "thought" || kind === "action" || this.hasPublishedPullRequest(sessionId)) &&
      !(kind === "response" && AFTER_PULL_REQUEST_RESPONSE.test(key))
    )
      return;
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

  /**
   * The ephemeral keepalive. The outbox does not store a line that repeats the session's last
   * thought, so the next line is tried, and the session still hears from Paws in time.
   */
  private postKeepalive(
    item: WorkItemRecord,
    key: string,
    lines: readonly (string | null | undefined)[],
  ): void {
    const tried = new Set<string>();
    for (const line of lines) {
      if (!line?.trim() || tried.has(line)) continue;
      const idempotencyKey = tried.size === 0 ? key : `${key}:${tried.size}`;
      tried.add(line);
      const id = this.post(item, "thought", line, idempotencyKey, { ephemeral: true }, "critical");
      if (id === undefined || getOutbox(this.db, id)?.idempotencyKey === idempotencyKey) return;
    }
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
    return hasPublishedPullRequest(
      this.db,
      sessionId,
      getLinearSessionGeneration(this.db, sessionId),
    );
  }

  /** The item opened a pull request in some generation of its session. A new turn starts a new generation. */
  private async hasOpenedPullRequest(itemId: string): Promise<boolean> {
    const prefix = `pull-request-ready:${itemId}:`;
    return await this.store.run((q) => linearOutboxKeyedSteps(q, prefix));
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
      const resolveProfiles = () => {
        this.reconcileAgentSettings();
        const currentRunId = getWorkItem(this.db, itemId)?.currentRunId;
        if (!currentRunId)
          return { profile: options.profile, fallbackProfile: options.fallbackProfile };
        const profiles = this.profileSnapshot(currentRunId);
        return {
          profile: profiles[options.role],
          fallbackProfile: options.role === "reviewer" ? profiles.reviewerFallback : undefined,
        };
      };
      const result = await runner({
        ...options,
        ...resolveProfiles(),
        resolveProfiles,
        onEvent: async (event, origin) => {
          const profile = resolveProfiles().profile;
          if (
            !options.prepareOnly &&
            options.role === "implementer" &&
            profile &&
            event.type === "session_started"
          )
            await this.reportSettingsSwitch(itemId, profile, event.identity?.model);
          await options.onEvent?.(event, origin);
        },
      });
      this.assertJobCurrent(itemId);
      return result;
    };
  }

  private mergeTurnTaken(itemId: string): boolean {
    const held = this.jobContexts.get(itemId);
    if (!held) {
      this.mergeTurnNotes.delete(itemId);
      return false;
    }
    const owner = this.leasedJobs.get(itemId);
    const holder = owner ? `${owner.queue} job ${owner.id}` : "worktree sweep";
    if (!held.isCurrent()) {
      this.jobContexts.delete(itemId);
      if (owner) this.leasedJobs.delete(itemId);
      this.mergeTurnNotes.delete(itemId);
      this.options.journal?.(
        `merge for item ${itemId} dropped the stale context of ${holder}, which is no longer running`,
      );
      return false;
    }
    const noted = this.mergeTurnNotes.get(itemId);
    if (noted === undefined || this.now() - noted >= MERGE_TURN_NOTE_MS) {
      this.mergeTurnNotes.set(itemId, this.now());
      this.options.journal?.(`merge for item ${itemId} waits for its turn behind ${holder}`);
    }
    return true;
  }

  private async runLeasedJob(
    job: Job,
    context: JobContext,
    operation: () => Promise<void>,
  ): Promise<void> {
    const itemId = readString(job.payload, "itemId");
    if (!itemId) return;
    if (this.jobContexts.has(itemId)) throw new Error("Task already has an owned job operation");
    if (!context.isCurrent()) throw context.signal.reason;
    this.jobContexts.set(itemId, context);
    this.leasedJobs.set(itemId, job);
    this.verifyingStops.delete(itemId);
    try {
      await this.loadProjectOverview(itemId, context.signal);
      await operation();
      if (!context.isCurrent()) throw context.signal.reason;
    } finally {
      if (this.jobContexts.get(itemId) === context) {
        this.jobContexts.delete(itemId);
        this.leasedJobs.delete(itemId);
      }
    }
  }

  private async runOwnedJob(payload: unknown, operation: () => Promise<void>): Promise<void> {
    const itemId = readString(payload, "itemId");
    if (!itemId) return;
    if (this.shuttingDown) throw new Error("Paws is shutting down");
    const key = `operation:${itemId}`;
    const live = await this.beginLive(itemId, key);
    try {
      this.conversations.set(
        itemId,
        await durableConversation(this.store, itemId, this.remoteAgentForItem(itemId)),
      );
      this.assertJobCurrent(itemId);
      await operation();
    } catch (error) {
      if (!live.controller.signal.aborted) throw error;
      journalCaught(
        error,
        "orchestrator.runOwnedJob.set",
        itemId,
        "cancellation may interrupt work",
        this.options.journal,
      );
    } finally {
      this.conversations.delete(itemId);
      this.live.delete(key);
      live.finish();
    }
  }

  private async beginLive(itemId: string, key: string) {
    const item = await this.store.run((q) => getWorkItemSteps(q, itemId));
    const sessionId = item === null ? null : this.activitySession(item);
    const generation =
      sessionId === null
        ? 0
        : await this.store.run((q) => getLinearSessionGenerationSteps(q, sessionId));
    if (this.live.has(key)) throw new Error("Run already has an owned live operation");
    const authority = this.jobContexts.get(itemId);
    const controller = new AbortController();
    const abort = () => controller.abort(authority?.signal.reason);
    authority?.signal.addEventListener("abort", abort, { once: true });
    if (authority && !authority.isCurrent()) abort();
    let finish!: () => void;
    const live = {
      itemId,
      version: item?.version ?? 0,
      sessionId,
      generation,
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

  private async repositoryGit(
    item: WorkItemRecord,
    repository: RepositoryBinding,
    signal: AbortSignal,
    access: "read" | "write",
  ) {
    if (!this.options.repositoryToken) return undefined;
    const generation = item.sessionKey
      ? await this.store.run((q) => getLinearSessionGenerationSteps(q, item.sessionKey!))
      : 0;
    return createRepositoryGit({
      remoteUrl: repository.remoteUrl,
      signal,
      ...(access === "write" ? { pushBranch: item.branchName } : {}),
      token: (ownedSignal) => this.options.repositoryToken!(item, repository, ownedSignal, access),
      onCleanupFailure: () => this.blockConversation(item.id),
      assert: async () => {
        signal.throwIfAborted();
        const current = await this.store.run((q) => getWorkItemSteps(q, item.id));
        if (
          !current ||
          this.stopped(item.id) ||
          current.currentRunId !== item.currentRunId ||
          (item.sessionKey &&
            (await this.store.run((q) => getLinearSessionGenerationSteps(q, item.sessionKey!))) !==
              generation)
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

  private async sessionPaused(sessionId: string): Promise<boolean> {
    return (await this.store.run((q) => workItemForSessionSteps(q, sessionId)))?.state === "paused";
  }

  private async resumeRedelegatedItem(
    issueId: string,
    session: StoredLinearSession,
  ): Promise<boolean> {
    const elsewhere = await this.store.run((q) =>
      issueOpenInOtherSessionSteps(q, issueId, session.sessionId),
    );
    if (!elsewhere || !this.tracker) return false;
    const snapshot = await this.tracker.loadEpic(issueId);
    const isCurrent = () => {
      const current = getLinearSession(this.db, session.sessionId);
      return (
        !this.shuttingDown &&
        current?.generation === session.generation &&
        current.stoppedAt === null &&
        this.options.authorizeLinearIntake?.(session.sessionId, snapshot) !== false
      );
    };
    await this.reconcilePreviousSessions([issueId], session.sessionId, isCurrent, {
      keepPullRequest: true,
    });
    const paused = await this.store.run((q) =>
      pausedStoppedSessionItemSteps(q, session.sessionId, issueId),
    );
    if (!paused) return false;
    await this.interruptLinearSession(paused.sessionKey);
    const resumed = immediate(this.db, () => {
      const item = getWorkItem(this.db, paused.id);
      if (item?.state !== "paused" || item.sessionKey !== paused.sessionKey || !isCurrent())
        return false;
      moveDelegationSession(this.db, {
        delegationId: paused.delegationId,
        from: paused.sessionKey,
        to: session.sessionId,
      });
      bindLinearSessionTask(this.db, session.sessionId, paused.delegationId);
      activateLinearItem(this.db, session.sessionId, item.id);
      cancelItemQuestions(this.db, item.id, this.now());
      restart(this.db, getWorkItem(this.db, item.id)!, {
        reason: "follow_up",
        body: "The issue was delegated again in Linear. Continue the task from its branch.",
        now: this.now(),
      });
      return true;
    });
    if (resumed) await this.reconcileExecution();
    await this.flush();
    return resumed;
  }

  private async resumeLinearSession(sessionId: string, talk = true): Promise<void> {
    const active = [...this.live.values()].filter((live) =>
      this.itemsForSession(sessionId).some((item) => item.id === live.itemId),
    );
    await this.stopTaskPlanning(sessionId);
    await Promise.all(active.map((live) => live.done));
    if (this.shuttingDown) throw new Error("Paws is shutting down; user update remains pending");
    let turns = await this.store.run((q) => listPendingLinearTurnsSteps(q, sessionId));
    if (!turns.length) return;
    if (talk && active.length === 0 && (await this.handToConversation(sessionId))) return;
    if (this.tracker === null)
      throw new Error("Linear is disconnected; user update remains pending");
    let session = await this.store.run((q) => getLinearSessionSteps(q, sessionId));
    if (!session?.issueId && this.tracker.getSession) {
      const recovered = await this.tracker.getSession(sessionId);
      session = await this.store.transaction((q) =>
        ensureLinearSessionSteps(q, {
          sessionId,
          issueId: recovered.issue?.id,
          appUserId: recovered.appUserId,
          creatorId: recovered.creatorId,
          now: this.now(),
        }),
      );
    }
    if (!session?.issueId)
      throw new Error("Linear session has no issue; user update remains pending");
    const routed = await this.store.run((q) => workItemForSessionSteps(q, sessionId));
    let item = routed ? await this.store.run((q) => getWorkItemSteps(q, routed.id)) : null;
    if (
      !item ||
      item.state === "completed" ||
      item.state === "merged" ||
      item.state === "cancelled"
    ) {
      let conversation: string | undefined;
      if (item) {
        await durableConversation(this.store, item.id);
        conversation = (await this.store.run((q) => getConversationSteps(q, item!.id))).entries;
        turns = await this.store.run((q) => listPendingLinearTurnsSteps(q, sessionId));
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
        const now = () => this.now();
        await this.store.transaction(function* (q) {
          yield* discardLinearTurnsSteps(q, sessionId, keys);
          yield* enqueueOutboxOnceSteps(q, {
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
            now: now(),
          });
        });
        await this.flush();
        return;
      }
      await this.store.transaction((q) =>
        bindLinearSessionTaskSteps(q, sessionId, result.delegation.id, {
          actorId: turns[0]!.actorId,
        }),
      );
      item = await this.store.run((q) => getWorkItemSteps(q, result.items[0]!.id));
      if (item)
        await this.store.transaction((q) => activateLinearItemSteps(q, sessionId, item!.id));
    }
    if (!item) throw new Error("Linear user update has no routed task");
    // The reply waits as a pending turn until the old agent is known to be gone.
    if (
      (await this.store.run((q) => getConversationSteps(q, item.id))).blocked &&
      !(await this.releaseCleanupBlock(item.id))
    ) {
      await this.tellCleanupBlocked(item.id, sessionId);
      return;
    }
    // Linear's "Fix merge conflicts" on the open pull request is a rebase-conflict return.
    const upstream =
      item.id === routed?.id &&
      (await this.hasOpenedPullRequest(item.id)) &&
      turns.some((turn) => isMergeConflictRequest(turn.body))
        ? await this.fetchUpstreamMain(item)
        : null;
    const conflict: RebaseConflict = { base: upstream, files: null };
    const rebase =
      upstream !== null && rebaseBudgetFor(this.db, item.id, conflict, this.now()).allowed;
    const generation = await this.store.run((q) => getLinearSessionGenerationSteps(q, sessionId));
    const jobKey = `linear-turn:${sessionId}:${generation}`;
    const before = await this.store.run((q) => getWorkItemSteps(q, item.id));
    const branchHead =
      (await this.store.run((q) => getItemBranchStateSteps(q, item.id)))?.head ?? null;
    const ci = rebase ? null : await this.followUpCi(item);
    await this.pullCloseoutEvidence(item);
    const retryBaseline = await snapshotRetryBaseline(itemPathId(item), this.options.pawsRoot);

    immediate(this.db, () => {
      const current = getWorkItem(this.db, item!.id);
      if (
        !current ||
        current.state === "cancelled" ||
        getLinearSessionGeneration(this.db, sessionId) !== generation ||
        (current.cancelRequested && !before?.cancelRequested)
      )
        return;
      const pending = listPendingLinearTurns(this.db, sessionId);
      if (!pending.length) return;
      const moved =
        current.version !== before?.version ||
        (getItemBranchState(this.db, item!.id)?.head ?? null) !== branchHead;
      const pull = getItemPullRequest(this.db, item!.id);
      const context =
        ci === null || pull === null
          ? null
          : moved
            ? unavailableCi(
                { number: pull.pullNumber, url: pull.pullUrl },
                ci.head,
                "the task changed while Paws read it",
              ).section
            : ci.section;
      const handoff = [...pending.map((turn) => turn.body), ...(context ? [context] : [])].join(
        "\n\n",
      );
      if (current.state === "paused") cancelItemQuestions(this.db, current.id, this.now());
      if (item!.cancelRequested || item!.state === "failed") clearItemRecovery(this.db, item!.id);
      startFreshBudget(this.db, {
        itemId: item!.id,
        sessionId,
        key: jobKey,
        maxAwakeMs: this.options.caps?.maxAwakeMs,
        limits: this.timeLimits(item!.id),
        now: this.now(),
      });
      const jobId = restart(this.db, getWorkItem(this.db, item!.id)!, {
        reason: rebase ? "conflict" : "follow_up",
        body: rebase ? `${REBASE_CONFLICT_INSTRUCTION}\n\n${handoff}` : handoff,
        jobKey,
        now: this.now(),
      });
      if (jobId !== null) saveHumanRetryWindow(this.db, item!.id, jobId, retryBaseline);
      if (rebase && jobId !== null)
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

  private async handToConversation(sessionId: string): Promise<boolean> {
    const routed = await this.store.run((q) => workItemForSessionSteps(q, sessionId));
    const item = routed ? await this.store.run((q) => getWorkItemSteps(q, routed.id)) : null;
    if (!item || !this.options.linearComments || !canConverse(item) || this.isLive(item.id))
      return false;
    const talk = await this.options.conversations?.();
    if (!talk || (await talk.lane(item.id)) === "closed") return false;
    await gatherLinearCommentsAsync(
      this.store,
      item.id,
      this.now(),
      { quietMs: 0, maxMs: 0 },
      `linear-turns:${item.id}:${(await this.store.run((q) => listPendingLinearTurnsSteps(q, sessionId)))[0]?.eventKey ?? ""}`,
    );
    return true;
  }

  private async followUpCi(item: WorkItemRecord): Promise<FollowUpCi | null> {
    const pull = await this.store.run((q) => getItemPullRequestSteps(q, item.id));
    if (pull === null) return null;
    const ref = { number: pull.pullNumber, url: pull.pullUrl };
    const repository = this.repositoryForItem(item);
    const github = repository ? this.githubForRepository(repository) : null;
    if (!repository || !github)
      return unavailableCi(ref, null, "GitHub is not connected for this repository");
    const target = { client: github.client, owner: repository.owner, repo: repository.repo };
    return followUpCi({
      pull: ref,
      readPull: () =>
        readPullMergeable({
          ...target,
          prNumber: pull.pullNumber,
          reads: 1,
          ...this.gitHubCredentials(github),
        }),
      readCi: (head) =>
        readPullCi({
          ...target,
          prNumber: pull.pullNumber,
          head,
          ...this.gitHubCredentials(github),
        }),
      now: () => this.now(),
      secrets: [github.privateKeyPem],
    });
  }

  /**
   * Fetch main into the item's worktree, or the bare mirror of a runner-backed item, as a merge
   * pass does before a rebase-conflict return. Returns main's commit, or null without either.
   */
  private async fetchUpstreamMain(item: WorkItemRecord): Promise<string | null> {
    const repository = this.repositoryForItem(item);
    const github = repository ? this.githubForRepository(repository) : null;
    const worktree = this.itemHead(item).repo;
    if (!repository || !github || !existsSync(worktree)) return null;
    const main = await fetchUpstreamMain({
      worktree,
      owner: repository.owner,
      repo: repository.repo,
      client: github.client,
      remoteUrl: repository.remoteUrl,
      ...this.gitHubCredentials(github),
    });
    await this.retryPolicyBlocks(item, main);
    return main;
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
    const item = await this.store.run((q) => getWorkItemSteps(q, live[0]!.itemId));
    if (item?.state !== "running" || !(await this.options.remoteFollowUp(item.id, turn.body)))
      return false;
    const now = () => this.now();
    await this.store.transaction(function* (q) {
      yield* applyLinearTurnsSteps(q, sessionId, [turn.eventKey], item.id);
      yield* enqueueOutboxOnceSteps(q, {
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
        now: now(),
      });
    });
    await this.flush();
    return true;
  }

  /**
   * Clears conversation blocks whose old agent is gone, as the runner it ran on reports, and
   * delivers the replies that waited on them.
   */
  releaseCleanupBlocks(): Promise<void> {
    if (this.releasingBlocks) return this.releasingBlocks;
    const releasing = (async () => {
      for (const { itemId } of await this.store.run((q) => listBlockedConversationsSteps(q)))
        if (await this.releaseCleanupBlock(itemId)) await this.deliverHeldReplies(itemId);
    })().finally(() => {
      if (this.releasingBlocks === releasing) this.releasingBlocks = null;
    });
    this.releasingBlocks = releasing;
    return releasing;
  }

  /**
   * A person vouches that the item's old agent is gone. Refused while Paws itself runs the item.
   * `onCommitted` runs inside the transaction that clears the block.
   */
  async clearStuckAgent(
    itemId: string,
    canAct: () => boolean = () => true,
    onCommitted?: () => void,
  ): Promise<boolean> {
    if (this.isLive(itemId)) return false;
    const cleared = await this.store.transaction(function* (q) {
      if (!canAct() || !(yield* getConversationSteps(q, itemId)).blocked) return false;
      onCommitted?.();
      return yield* clearConversationBlockSteps(q, itemId);
    });
    if (!cleared) return false;
    this.options.journal?.(`item ${itemId} conversation block cleared by a person`);
    await this.deliverHeldReplies(itemId);
    return true;
  }

  private async releaseCleanupBlock(itemId: string): Promise<boolean> {
    const gone = this.options.remoteExecution?.commandsGone;
    if (!gone || this.isLive(itemId)) return false;
    const cleared = await this.store.transaction(function* (q) {
      const { blockedAt } = yield* getConversationSteps(q, itemId);
      return (
        blockedAt !== null &&
        gone(itemId, blockedAt) &&
        (yield* clearConversationBlockSteps(q, itemId, blockedAt))
      );
    });
    if (cleared)
      this.options.journal?.(
        `item ${itemId} conversation block cleared: its runner no longer runs its commands`,
      );
    return cleared;
  }

  private async deliverHeldReplies(itemId: string): Promise<void> {
    const sessionId = (await this.store.run((q) => getWorkItemSteps(q, itemId)))?.sessionKey;
    if (
      !sessionId ||
      this.shuttingDown ||
      !(await this.store.run((q) => listPendingLinearTurnsSteps(q, sessionId))).length
    )
      return;
    // In line with the session's Linear events, so a reply arriving now is delivered once.
    const done = (this.sessionEvents.get(sessionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(() => this.resumeLinearSession(sessionId));
    this.sessionEvents.set(sessionId, done);
    try {
      await done;
    } catch (error) {
      journalCaught(
        error,
        "orchestrator.deliverHeldReplies.resumeLinearSession",
        itemId,
        undefined,
        this.options.journal,
      );
    } finally {
      if (this.sessionEvents.get(sessionId) === done) this.sessionEvents.delete(sessionId);
    }
  }

  private async tellCleanupBlocked(itemId: string, sessionId: string): Promise<void> {
    const { blockedAt } = await this.store.run((q) => getConversationSteps(q, itemId));
    await this.store.transaction((q) =>
      enqueueOutboxOnceSteps(q, {
        target: "linear",
        op: "activity",
        orderingKey: sessionId,
        idempotencyKey: `cleanup-blocked:${itemId}:${blockedAt ?? 0}`,
        payload: { sessionId, kind: "thought", body: CLEANUP_BLOCKED_NOTICE, id: randomUUID() },
        now: this.now(),
      }),
    );
    await this.flush();
  }

  private isLive(itemId: string): boolean {
    return [...this.live.values()].some((live) => live.itemId === itemId);
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
    const items: WorkItemRecord[] = [];
    for (const id of listItemIds(this.db, includeArchived)) {
      const item = getWorkItem(this.db, id);
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
    return itemParentTaskKey(this.db, item.id);
  }

  private async delegationIssueId(item: WorkItemRecord): Promise<string | null> {
    return await this.store.run((q) => itemDelegationIssueIdSteps(q, item.id));
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
        const ticked = await this.options.outbox.tick();
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
      current.state === "paused" ||
      current.cancelRequested
    );
  }

  /**
   * Why a finished Closeout result must not move the item, or null when it must. Unlike
   * {@link stopped}, an aborted live operation alone does not drop the result: an abort that
   * leaves the item in `verifying` would otherwise leave nobody to accept, restart or ask
   * (PAS-771). A drop that keeps the item in `verifying` is noted for {@link settleVerifying}.
   */
  private async closeoutStopped(itemId: string): Promise<string | null> {
    const current = await this.store.run((q) => getWorkItemSteps(q, itemId));
    if (current === null || current.state === "cancelled") return "the task was cancelled";
    if (!["running", "verifying", "merge_queue"].includes(current.state))
      return `the task is already ${current.state}`;
    const reason = this.shuttingDown
      ? "Paws is shutting down"
      : current.cancelRequested
        ? "the task is stopping"
        : this.signalForItem(itemId)?.reason === FOLLOW_UP_INTERRUPTION
          ? "a follow-up from Linear restarts it"
          : null;
    if (reason !== null && current.state === "verifying")
      this.verifyingStops.set(itemId, `Closeout result dropped: ${reason}`);
    return reason;
  }

  /**
   * An execution job that ends with its item still in `verifying` leaves nothing running for
   * it. Journal why, and ask for Closeout help unless other work still moves the item: a
   * re-verification, a Linear follow-up, an open question, a stop or a shutdown (PAS-771).
   */
  private async settleVerifying(job: Job, context: JobContext): Promise<void> {
    const itemId = readString(job.payload, "itemId");
    if (itemId === null) return;
    const note = this.verifyingStops.get(itemId);
    this.verifyingStops.delete(itemId);
    const reviewerFault = this.reviewerFaults.get(itemId);
    this.reviewerFaults.delete(itemId);
    const item = await this.store.run((q) => getWorkItemSteps(q, itemId));
    if (item?.state !== "verifying" || !context.isCurrent()) return;
    const reason = note ?? reviewerFault ?? "the job ended without a Closeout result";
    this.options.journal?.(
      `job ${job.id} ${job.queue} left item ${item.id} (${item.linearIdentifier ?? "-"}) in verifying: ${reason}`,
    );
    const sessionId = this.activitySession(item);
    const moving =
      this.shuttingDown ||
      item.cancelRequested ||
      sessionId === null ||
      findOpenQuestion(this.db, sessionId) !== null ||
      (await this.store.run((q) => listPendingLinearTurnsSteps(q, sessionId))).length > 0 ||
      (await this.store.run((q) => hasOpenItemJobSteps(q, JOB_KIND.reverify, item.id, job.id)));
    if (moving) return;
    const head = item.checkpoint?.wipCommit ?? "";
    const prior = closeoutFaults(job.payload);
    const seen = [...(prior?.head === head ? prior.reasons : []), reason];
    const reasons =
      reviewerFault === undefined ? seen : seen.slice(-CLOSEOUT_FAULT_DELAYS_MS.length);
    const delayMs = CLOSEOUT_FAULT_DELAYS_MS[reasons.length - 1];
    if (delayMs !== undefined && head !== "" && item.checkpoint?.phase === "verifying") {
      const reviewer =
        reviewerFault === undefined ? null : await this.reviewerHold(item, reviewerFault);
      await deferWorkItemAsync(this.store, item, {
        retry: reasons.length,
        delayMs,
        handoff: null,
        message: reviewer
          ? reviewer.alert
          : `Closeout stopped without a result; retrying in ${delayMs / 60_000} min.`,
        now: this.now(),
        closeoutFault: {
          head,
          reasons,
          jobId: job.id,
          ...(reviewer ? { reviewer: reviewer.key } : {}),
        },
      });
      return;
    }
    const faults =
      reasons.length > 1
        ? `\nCloseout stopped without a result ${reasons.length} times on this head:\n${reasons.map((entry) => `- ${entry}`).join("\n")}`
        : "";
    await this.askCloseoutHelp(
      item,
      undefined,
      `Closeout: blocked\nVerification stopped without moving the task on: ${reason}.${faults}`,
    );
  }

  private async reviewerHold(
    item: WorkItemRecord,
    fault: string,
  ): Promise<{ key: string; alert: string | null } | null> {
    if (item.currentRunId === null) return null;
    const { reviewer, reviewerFallback } = this.profileSnapshot(item.currentRunId);
    const key = createHash("sha256")
      .update(JSON.stringify({ reviewer, reviewerFallback }))
      .digest("hex")
      .slice(0, 16);
    if (
      await this.store.run((q) =>
        reviewerAlertedSinceSteps(q, key, this.now() - REVIEWER_ALERT_INTERVAL_MS),
      )
    )
      return { key, alert: null };
    const held = [
      item,
      ...reviewerFaultHolds(this.db, key).filter((entry) => entry.id !== item.id),
    ];
    const names = held.map((entry) => entry.linearIdentifier ?? entry.id).join(", ");
    return {
      key,
      alert: `The reviewer ${reviewer.agent} ${reviewer.model ?? "agent default"} can't run its review (${fault}). Closeout holds ${names} and retries every 15 min at most. Change the reviewer in Settings to re-verify them now.`,
    };
  }

  private async hydrateLinearContext(sessionId: string | null, signal: AbortSignal): Promise<void> {
    if (!sessionId) return;
    if (
      !(await this.store.run((q) => hasLinearSessionSnapshotContextSteps(q, sessionId))) &&
      this.tracker?.getSession
    ) {
      const session = await this.tracker.getSession(sessionId, { signal });
      signal.throwIfAborted();
      await this.store.transaction((q) =>
        ensureLinearSessionSteps(q, {
          sessionId,
          issueId: session.issue?.id,
          appUserId: session.appUserId,
          creatorId: session.creatorId,
          now: this.now(),
        }),
      );
      const linked = await this.store.run((q) => workItemForSessionSteps(q, sessionId));
      if (linked)
        await this.store.transaction((q) =>
          bindLinearSessionTaskSteps(q, sessionId, linked.delegationId),
        );
      await this.store.run((q) =>
        saveLinearSessionSnapshotContextSteps(
          q,
          sessionId,
          renderLinearSessionContext({
            promptContext: null,
            issue: session.issue,
            comment: session.sourceComment ?? session.comment,
            previousComments: [],
            guidance: [],
          }),
        ),
      );
    }
    const tracker = this.tracker;
    if (!tracker?.listSessionActivities) return;
    const generation = await this.store.run((q) => getLinearSessionGenerationSteps(q, sessionId));
    if ((await this.store.run((q) => linearActivitiesListedAtSteps(q, sessionId))) === generation)
      return;
    let activities;
    try {
      activities = await linearCaller("context", () =>
        tracker.listSessionActivities!(sessionId, { signal }),
      );
    } catch (error) {
      signal.throwIfAborted();

      if (
        error instanceof LinearRateLimitError &&
        (await this.store.run((q) => listLinearActivitySnapshotsSteps(q, sessionId))).length > 0
      ) {
        journalCaught(
          error,
          "orchestrator.hydrateLinearContext.linearCaller",
          null,
          undefined,
          this.options.journal,
        );
        return;
      }
      throw error;
    }
    signal.throwIfAborted();
    const listed = activities;
    await this.store.transaction(function* (q) {
      for (const activity of listed)
        yield* saveLinearActivitySnapshotSteps(q, {
          id: activity.id,
          sessionId,
          createdAt: activity.createdAt,
          snapshot: JSON.stringify(activity),
        });
      yield* markLinearActivitiesListedSteps(q, sessionId, generation);
    });
  }

  private async loadProjectOverview(itemId: string, signal: AbortSignal): Promise<void> {
    const item = await this.store.run((q) => getWorkItemSteps(q, itemId));
    const tracker = this.options.tracker;
    if (
      !item ||
      (await this.store.run((q) => getTaskLinearReadSteps(q, itemId, "project_overview"))) !==
        undefined
    )
      return;
    if (
      tracker?.issueMergeContext &&
      !(await this.store.run((q) => getTaskMergeSettingsSteps(q, itemId)))
    ) {
      await this.mergeSettingsFor(item, signal);
      return;
    }
    if (!tracker?.projectOverview) return;
    try {
      const overview = await tracker.projectOverview(item.linearIssueId, { signal });
      await this.store.run((q) =>
        keepTaskLinearReadSteps(
          q,
          itemId,
          "project_overview",
          projectOverviewText(overview),
          this.now(),
        ),
      );
    } catch (caughtError16) {
      signal.throwIfAborted();
      journalCaught(
        caughtError16,
        "orchestrator.loadProjectOverview.projectOverview",
        itemId,
        undefined,
        this.options.journal,
      );
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
    const repository = this.repositoryForItem(item);
    const template = resolveBriefTemplate(
      loadConfigFile(join(this.options.pawsRoot, "config.toml")),
      repository ? `${repository.owner}/${repository.repo}` : null,
    );
    return renderWorkContext(template, {
      brief: item.brief,
      projectOverview:
        (getTaskLinearRead(this.db, item.id, "project_overview") as string | undefined) ?? "",
      userUpdates: listLinearTurnsForItem(this.db, item.id).map((turn) => turn.body),
      taskContext: classification?.mode !== "clarify" ? (classification?.context ?? "") : "",
      sessionContext: item.sessionKey ? getLinearSessionContext(this.db, item.sessionKey) : "",
      activities,
    });
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
        this.visualReviewRequirements(item, this.itemHead(item).repo).some(
          (requirement) => requirement.id === checkId,
        ),
      ...(linear ? { linear } : {}),
      now: () => this.now(),
    });
  }

  /**
   * One thought per evidence check Closeout recorded at the verdict's head, with the file count
   * and a link to Paws. After the pull request response, the issue's evidence card instead.
   */
  private postEvidence(item: WorkItemRecord, verdict: GateResult): void {
    const link = this.options.evidence && evidenceSectionUrl(this.options.evidence.publicUrl, item);
    if (!link || !verdict.head) return;
    if (!this.canReportProgress(item.id)) return this.attachEvidence(item, verdict.head);
    const checkIds = (verdict.decision?.items ?? [])
      .filter((check) => check.kind === "evidence")
      .map((check) => check.id);
    for (const { key, body } of evidenceThoughts(this.db, {
      itemId: item.id,
      checkIds,
      head: verdict.head,
      link,
    }))
      this.post(item, "thought", body, key);
  }

  /** The issue's one "Closeout evidence" card once the pull request response exists. */
  private attachEvidence(item: WorkItemRecord, head: string): void {
    const sessionId = this.activitySession(item);
    const link = this.options.evidence && evidenceSectionUrl(this.options.evidence.publicUrl, item);
    if (!link || sessionId === null || !this.hasPublishedPullRequest(sessionId)) return;
    enqueueEvidenceCard(this.db, {
      sessionId,
      generation: getLinearSessionGeneration(this.db, sessionId),
      item,
      link,
      head,
      now: this.now(),
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

  /**
   * Opens the pending-human check of head S, bound to S and its files. An
   * open review of a head with the same patch against main stays open; a
   * different patch cancels it and asks again with the latest files.
   * Returns whether a review is open for S.
   */
  private async openVisualReviewCheck(
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
    const pending = pendingVisualReview(this.db, item);
    if (pending) {
      const reviewed = pending.review.headCommit;
      if (reviewed && (await samePatch(worktree, reviewed, head, base))) return true;
      cancelVisualReviewQuestion(this.db, pending.question.id, "head_moved", this.now());
    }
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
        this.evidenceStorage(),
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
            base,
            head,
            publicUrl: evidence.publicUrl,
            now: this.now(),
          })
        )
          return "none" as const;
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

  /**
   * Only pending-human checks are left on head S: the item waits in
   * awaiting_input on the open review and gives its runner back. Returns
   * false when every check is approved, so the evaluation can complete.
   */
  private async awaitVisualReview(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
  ): Promise<boolean> {
    if (pendingVisualReview(this.db, item) === null)
      await this.openVisualReviewCheck(item, worktree, base, head);
    const waiting = immediate(this.db, () => {
      const current = getWorkItem(this.db, item.id);
      if (
        !current ||
        current.cancelRequested ||
        (current.state !== "verifying" && current.state !== "merge_queue")
      )
        return true;
      const pending = pendingVisualReview(this.db, current);
      if (pending === null) return false;
      awaitQuestion(this.db, current, pending.question, this.now());
      if (current.currentRunId) releaseRunCapacity(this.db, current.currentRunId, this.now());
      return true;
    });
    await this.flush();
    return waiting;
  }

  /**
   * Another check failed on head S, so its pending-human check is moot.
   * Returns whether a review was open; its verdict thoughts were held back.
   */
  private cancelVisualReview(item: WorkItemRecord): boolean {
    const pending = pendingVisualReview(this.db, item);
    if (pending) cancelVisualReviewQuestion(this.db, pending.question.id, "cancelled", this.now());
    return pending !== null;
  }

  /**
   * The open visual review link ask stays open on head S when the commit it
   * asks about has the same patch against main, as after a rebase.
   */
  private async samePatchVisualReview(
    item: WorkItemRecord,
    worktree: string,
    base: string,
    head: string,
  ): Promise<string[]> {
    const pending = pendingVisualReview(this.db, item);
    const reviewed = pending?.review.headCommit;
    if (pending?.question.kind !== "link" || !reviewed || reviewed === head) return [];
    return (await samePatch(worktree, reviewed, head, base)) ? [pending.question.id] : [];
  }

  /** A decision made on the item page. `effects` are what an approval does per kind. */
  async decideLinkAsk(
    input: Omit<Parameters<typeof decideLinkAsk>[1], "now">,
    effects: LinkAskEffects = {},
  ): Promise<"answered" | "forbidden" | "rejected"> {
    const itemId = getQuestion(this.db, input.questionId)?.itemId;
    if (itemId && (await this.store.run((q) => getWorkItemSteps(q, itemId)))?.state === "paused")
      return "rejected";
    const outcome = await decideLinkAsk(
      this.db,
      { ...input, now: this.now() },
      {
        bypass: reverifyBypassedSteps,
        rule: reverifyBypassedSteps,
        ...effects,
      },
    );
    if (
      outcome === "answered" &&
      itemId &&
      (await this.store.run((q) => getWorkItemSteps(q, itemId)))?.state === "queued"
    ) {
      this.abortItem(itemId);
      await this.dispatch();
    }
    await this.flush();
    return outcome;
  }

  async answerFromPaws(input: {
    questionId: string;
    answer: string;
    answeredBy: string;
    answeredByName: string;
  }): Promise<"answered" | "rejected"> {
    const waiting = async () => {
      if (this.shuttingDown) return null;
      const open = getQuestion(this.db, input.questionId);
      const item = open ? await this.store.run((q) => getWorkItemSteps(q, open.itemId)) : null;
      if (open?.status !== "open" || !isPawsAnswerKind(open.kind) || item === null) return null;
      return findOpenQuestion(this.db, open.sessionId)?.id === open.id ? { open, item } : null;
    };
    const sessionId = (await waiting())?.open.sessionId;
    if (sessionId === undefined) return "rejected";
    const answered = (this.sessionEvents.get(sessionId) ?? Promise.resolve())
      .catch(() => undefined)
      .then(async () => {
        const current = await waiting();
        if (current === null) return false;
        const { open, item } = current;
        const dedupeKey = `paws-answer:${open.id}`;
        await this.store.run((q) =>
          deleteCancelledLinearTurnSteps(q, { sessionId: open.sessionId, eventKey: dedupeKey }),
        );
        const at = Math.max(this.now(), open.createdAt + 1);
        await this.handleLinearEvent({
          dedupeKey,
          deliveryId: null,
          source: "webhook",
          action: "prompted",
          sessionId: open.sessionId,
          issueId:
            (await this.store.run((q) => getLinearSessionSteps(q, open.sessionId)))?.issueId ??
            item.linearIssueId,
          activityId: null,
          actorId: input.answeredBy,
          activityCreatedAtMs: at,
          body: input.answer,
          signal: null,
          updatedAtMs: at,
          payload: JSON.stringify({ questionId: open.id, answeredBy: input.answeredBy }),
        });
        if (getQuestion(this.db, open.id)?.answerEventKey !== dedupeKey) return false;
        await this.store.transaction((q) =>
          enqueueOutboxOnceSteps(q, {
            target: "linear",
            op: "activity",
            orderingKey: open.sessionId,
            idempotencyKey: dedupeKey,
            delivery: "critical",
            payload: {
              id: crypto.randomUUID(),
              sessionId: open.sessionId,
              itemId: item.id,
              issueId: item.linearIssueId,
              kind: "response",
              body: pawsAnswerNote(input.answeredByName, input.answer),
            },
            now: this.now(),
          }),
        );
        await this.reconcileExecution();
        await this.flush();
        return true;
      });
    this.sessionEvents.set(sessionId, answered);
    try {
      return (await answered) ? "answered" : "rejected";
    } finally {
      if (this.sessionEvents.get(sessionId) === answered) this.sessionEvents.delete(sessionId);
    }
  }

  async requestVisualReviewChanges(input: {
    questionId: string;
    answeredBy: string;
    note: string;
    marks: readonly VisualReviewMark[];
    actor?: { workspaceId: string; userId: string; name: string };
  }): Promise<"answered" | "forbidden" | "rejected"> {
    const open = getQuestion(this.db, input.questionId);
    const review = open ? getVisualReview(this.db, open.id) : null;
    if (open?.status !== "open" || review?.kind !== "review") return "rejected";
    // A visual review asked with a link is decided like every link ask, with the marks.
    if (open.kind === "link")
      return input.actor
        ? this.decideLinkAsk({
            questionId: open.id,
            decision: "changes",
            note: input.note,
            answeredBy: input.answeredBy,
            actor: input.actor,
            marks: input.marks,
          })
        : "rejected";
    const item = await this.store.run((q) => getWorkItemSteps(q, open.itemId));
    if (item === null) return "rejected";
    if (!(await this.canAnswerVisualReview(item, input.answeredBy))) return "forbidden";
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
      // A pending-human check is answered while the other checks still run.
      const waiting =
        item?.state === "awaiting_input" ||
        (item?.state === "verifying" && review.kind === "review");
      if (
        item === null ||
        !waiting ||
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
    // Changes requested while the other checks ran restart the item: stop that evaluation.
    if (
      outcome === "answered" &&
      (await this.store.run((q) => getWorkItemSteps(q, open.itemId)))?.state === "queued"
    ) {
      this.abortItem(open.itemId);
      await this.dispatch();
    }
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
  private async canAnswerVisualReview(item: WorkItemRecord, actorId: string): Promise<boolean> {
    return canAnswer(
      {
        kind: "visual-review",
        delegatorId: await this.store.run((q) => delegatedLinearUserIdSteps(q, item.id)),
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
    const storage = this.evidenceStorage();
    if (!storage) return linear;
    const marks = createReviewMarkLoader({ db: this.db, storage, itemId: item.id, turnId });
    return async (input: { workspace: string; prompt: string; signal: AbortSignal }) => {
      const marked = await marks(input);
      if (!linear) return marked;
      const loaded = await linear({ ...input, prompt: marked.prompt });
      return { prompt: loaded.prompt, inputFiles: [...marked.inputFiles, ...loaded.inputFiles] };
    };
  }

  private closeoutEvidence(): EvidenceStorage | null {
    const objects = this.options.closeoutEvidenceObjects;
    return objects ? { root: join(this.options.pawsRoot, "closeout", "evidence"), objects } : null;
  }

  private async pullCloseoutEvidence(item: WorkItemRecord, strict = false): Promise<void> {
    const storage = this.closeoutEvidence();
    if (storage === null) return;
    const restored = hydrateCloseoutEvidence(this.db, storage, [itemPathId(item)], { strict });
    if (strict) await restored;
    else
      await restored.catch((error: unknown) =>
        journalCaught(error, "orchestrator.pullCloseoutEvidence", item.id),
      );
  }

  private async pushCloseoutEvidence(item: WorkItemRecord): Promise<void> {
    const storage = this.closeoutEvidence();
    if (storage === null) return;
    await publishCloseoutEvidence(this.db, storage, itemPathId(item));
  }

  private evidenceStorage(): EvidenceStorage | undefined {
    const evidence = this.options.evidence;
    return evidence?.root ? { root: evidence.root, objects: evidence.objects } : undefined;
  }

  private blockConversation(itemId: string): void {
    blockStoredConversation(this.db, itemId, this.now());
  }

  private async prepareConversation(item: WorkItemRecord) {
    const taskKey = this.parentTaskKey(item);
    const classification = taskKey
      ? await this.store.run((q) => getTaskClassificationSteps(q, taskKey))
      : null;
    const sourceItemId = classification?.mode !== "clarify" ? classification?.sourceItemId : null;
    const stored = await this.store.run((q) => getConversationSteps(q, item.id));
    if (sourceItemId && stored.entries === "[]" && !stored.transcript) {
      await durableConversation(this.store, sourceItemId);
      const { entries } = await this.store.run((q) => getConversationSteps(q, sourceItemId));
      await this.store.run((q) => saveConversationSteps(q, item.id, entries, null));
    }
    const backend = this.remoteAgentForItem(item.id) ?? runAgent;
    const runner = await durableConversation(this.store, item.id, async (input) => {
      const policy =
        (await this.store.run((q) => getTaskModeSteps(q, item.id))) === "code" &&
        input.role === "implementer" &&
        !input.prepareOnly
          ? await this.commitPolicy(item)
          : undefined;
      return backend({
        ...input,
        commitPolicy: policy,
        ...(await this.trustedRunInputs(item, input)),
      });
    });
    this.conversations.set(item.id, runner);
    const sessionKey = item.sessionKey;
    if (sessionKey && (await this.store.run((q) => getLinearSessionSteps(q, sessionKey)))) {
      const pending = await this.store.run((q) => listPendingLinearTurnsSteps(q, sessionKey));
      const eventKeys = pending.map((turn) => turn.eventKey);
      await this.store.transaction((q) => applyLinearTurnsSteps(q, sessionKey, eventKeys, item.id));
    }
    return runner;
  }

  private async commitPolicy(item: WorkItemRecord): Promise<GitCommitPolicy | undefined> {
    if (!this.options.commitPolicyForItem) return undefined;
    const current = await this.store.run((q) => getWorkItemSteps(q, item.id));
    if (!current?.currentRunId) throw new Error("Attribution run is missing");
    const prior =
      (await this.store.run((q) => getRunSteps(q, current.currentRunId!)))?.checkpoint
        ?.commitPolicy ?? (await this.store.run((q) => getItemRunCommitPolicySteps(q, item.id)));
    if (prior) {
      policyCoauthors(prior);
      await this.store.run((q) => saveRunCommitPolicySteps(q, current.currentRunId!, prior));
      return prior;
    }
    const resolved = await this.options.commitPolicyForItem(current);
    if (
      (await this.store.run((q) => getWorkItemSteps(q, item.id)))?.currentRunId !==
        current.currentRunId ||
      this.signalForItem(item.id)?.aborted
    )
      throw new Error("Attribution run changed while resolving identities");
    if (!resolved) throw new Error("Run attribution authority is unavailable");
    policyCoauthors(resolved);
    await this.store.run((q) => saveRunCommitPolicySteps(q, current.currentRunId!, resolved));
    return resolved;
  }

  private agentDeps(item: WorkItemRecord): AcpAgentDeps {
    const runId = item.currentRunId ?? item.id;
    const repository = this.repositoryForItem(item);
    const profiles = () => this.profileSnapshot(runId);
    return {
      repository: repository ? `${repository.owner}/${repository.repo}` : undefined,
      pawsRoot: this.options.pawsRoot,
      get profiles() {
        return profiles();
      },
      publishArtifact: this.artifactPublisher(item),
      prepareInputFiles: this.prepareInputFiles(item, runId),
      onCandidate: (identity) => {
        if (!this.signalForItem(item.id)?.aborted) this.saveCandidate(runId, identity);
      },
      onCleanupFailure: () => this.blockConversation(item.id),
      signal: this.signalForItem(item.id),
      promptRunner: async (input) => {
        const runner =
          this.conversations.get(item.id) ?? this.remoteAgentForItem(item.id) ?? runAgent;
        const policy =
          input.role === "implementer" && !input.prepareOnly
            ? await this.commitPolicy(item)
            : undefined;
        return runner({
          ...input,
          commitPolicy: policy,
          ...(await this.trustedRunInputs(item, input)),
        });
      },
      agentRunner: this.remoteAgentForItem(item.id),
      ...(this.options.home ? { home: this.options.home } : {}),
      launch: this.launchAgent.bind(this),
      brief: this.workContext(item),
    };
  }

  /**
   * Reply on the pull request to each comment the last fix turn was handed, and resolve the threads
   * it addressed. The head is on GitHub by now. A failure leaves the rest for the next publication
   * and does not hold the merge.
   */
  private async postReviewReplies(
    item: WorkItemRecord,
    github: GitHubBinding,
    repository: { owner: string; repo: string },
    pullNumber: number,
    head: string,
  ): Promise<void> {
    const access = {
      client: github.client,
      owner: repository.owner,
      repo: repository.repo,
      ...this.gitHubCredentials(github),
    };
    await postReviewReplies(
      this.store,
      { itemId: item.id, pullNumber, head, now: () => this.now() },
      {
        replyToReviewComment: (prNumber, commentId, body) =>
          replyToReviewComment({ ...access, prNumber, commentId, body }),
        commentOnPullRequest: (prNumber, body) =>
          commentOnPullRequest({ ...access, prNumber, body }),
        resolveReviewThread: (threadId) => resolveReviewThread({ ...access, threadId }),
      },
    ).catch((error: unknown) =>
      journalCaught(
        error,
        "orchestrator.postReviewReplies",
        item.id,
        undefined,
        this.options.journal,
      ),
    );
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
      journalCaught(
        error,
        "orchestrator.candidateForItem.candidateFor",
        item?.id,
        undefined,
        this.options.journal,
      );
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
    profiles: AgentProfiles;
    profileLabels?: ProfileLabels;
    profileQuestion?: string;
    defaultRoles?: ProfileRole[];
    candidate?: AgentIdentity;
    settingsSwitch?: { id: string; previousAgent: AgentProfile["agent"] };
  } | null {
    try {
      return JSON.parse(
        readFileSync(join(runDir(this.options.pawsRoot, runId), "agent-profile.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        journalCaught(
          error,
          "orchestrator.readProfileSnapshot.parse",
          null,
          "optional file may be absent",
          this.options.journal,
        );
        return null;
      }
      throw error;
    }
  }

  private reconcileAgentSettings(): void {
    const configPath = join(this.options.pawsRoot, "config.toml");
    if (!existsSync(configPath)) return;
    this.applyAgentSettingsToWaiting();
  }

  /** Synchronous with snapshot reads and runner admission in this process. */
  applyAgentSettingsToWaiting(): number {
    const config = loadConfigFile(join(this.options.pawsRoot, "config.toml"));
    let changedRuns = 0;
    for (const run of listWaitingProfileRuns(this.db, this.now())) {
      const saved = this.readProfileSnapshot(run.id);
      if (!saved) continue;
      const item = getWorkItem(this.db, run.itemId)!;
      const repository = this.repositoryForItem(item);
      const repoName = repository ? `${repository.owner}/${repository.repo}` : undefined;
      const profiles = withoutLabelProblems(
        resolveAgentProfiles(config, repoName, saved.profileLabels),
      );
      if (JSON.stringify(saved.profiles) === JSON.stringify(profiles)) continue;
      // Keep the original agent through repeated saves before the next turn.
      const previousAgent = saved.settingsSwitch?.previousAgent ?? saved.profiles.implementer.agent;
      const settingsSwitch =
        previousAgent !== profiles.implementer.agent
          ? { id: randomUUID(), previousAgent }
          : undefined;
      writeFileSync(
        join(runDir(this.options.pawsRoot, run.id), "agent-profile.json"),
        JSON.stringify({ ...saved, profiles, settingsSwitch }),
        { mode: 0o600 },
      );
      changedRuns += 1;
      const reviewers = (entry: AgentProfiles) =>
        JSON.stringify([entry.reviewer, entry.reviewerFallback]);
      if (reviewers(saved.profiles) !== reviewers(profiles))
        releaseReviewerFaultHolds(this.db, run.itemId, this.now());
    }
    return changedRuns;
  }

  private async reportSettingsSwitch(
    itemId: string,
    profile: AgentProfile,
    model?: string,
  ): Promise<void> {
    const item = await this.store.run((q) => getWorkItemSteps(q, itemId));
    if (!item?.currentRunId) return;
    const saved = this.readProfileSnapshot(item.currentRunId);
    if (!saved?.settingsSwitch || saved.profiles.implementer.agent !== profile.agent) return;
    const posted = this.post(
      item,
      "thought",
      `Switched to ${profile.agent} ${model ?? profile.model ?? "agent default"} ${saved.profileLabels?.implementer ? `from the Implementer label ${saved.profileLabels.implementer}` : "as set in Settings"}.`,
      `settings-agent-switch:${saved.settingsSwitch.id}`,
    );
    if (posted === undefined) return;
    delete saved.settingsSwitch;
    writeFileSync(
      join(runDir(this.options.pawsRoot, item.currentRunId), "agent-profile.json"),
      JSON.stringify(saved),
      { mode: 0o600 },
    );
  }

  private profileSnapshot(runId: string): AgentProfiles {
    const saved = this.readProfileSnapshot(runId);
    if (saved) return saved.profiles;
    const config = loadConfigFile(join(this.options.pawsRoot, "config.toml"));
    const run = getRun(this.db, runId);
    const item = run === null ? null : getWorkItem(this.db, run.itemId);
    const repository = item === null ? null : this.repositoryForItem(item);
    const repoName = repository ? `${repository.owner}/${repository.repo}` : undefined;
    const profiles = resolveAgentProfiles(config, repoName);
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
      JSON.stringify({ ...this.readProfileSnapshot(runId), profiles, candidate }),
      { mode: 0o600 },
    );
  }

  private async preflight(
    item: WorkItemRecord,
    runId: string,
    profiles: AgentProfiles,
    signal: AbortSignal,
    onRemoteEvent: (event: AcpEvent) => void,
  ): Promise<void> {
    const originalProfiles = JSON.stringify(profiles);
    const repository = this.repositoryForItem(item);
    if (repository === null) throw new Error("The work item has no repository");
    await ensureBareMirror({
      ...repository,
      pawsRoot: this.options.pawsRoot,
      networkGit: await this.repositoryGit(item, repository, signal, "write"),
    });
    const startRef = worktreeStartRef(item);
    const placement = {
      ...repository,
      itemId: itemPathId(item),
      pawsRoot: this.options.pawsRoot,
      ...(startRef ? { startRef } : {}),
    };
    // A runner-backed item gets its candidate ref in the mirror, not a worktree.
    const worktree = this.options.remoteExecution
      ? {
          path: this.runnerWorkspace(runId),
          repo: await this.ensureRecordedCandidate(item, placement, signal),
        }
      : await createWorktree({
          ...placement,
          checkoutExclusions: this.runCheckout(item).agent,
        }).then((created) => ({ path: created.path, repo: created.path }));
    const required = (this.options.reviewRequirements ?? reviewRequirements)(
      worktree.repo,
      this.options.home,
      this.options.closeoutPolicyRoot?.(repository),
    );
    if (!required.ok)
      throw required.message.startsWith("origin/main is unavailable") &&
        isTransientGitError(required.message)
        ? new PolicyFetchError(required.message)
        : new Error(required.message);
    const requirements = required.items.filter(
      (check) =>
        check.gate === "beforePR" &&
        !check.paths?.length &&
        !(check.minChangedLines !== undefined && check.minChangedLines > 0),
    );
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
        ...(role === "reviewer" && profiles.reviewerFallback
          ? { fallbackProfile: profiles.reviewerFallback }
          : {}),
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
    const latest = this.readProfileSnapshot(runId);
    if (latest && JSON.stringify(latest.profiles) !== originalProfiles) {
      Object.assign(profiles, latest.profiles);
      return;
    }
    profiles.implementer.model ??= identities[0]!.model;
    const preparedReviewer =
      identities[1]!.provider === providerFor(profiles.reviewer.agent)
        ? profiles.reviewer
        : profiles.reviewerFallback;
    if (preparedReviewer) preparedReviewer.model ??= identities[1]!.model;
    writeFileSync(
      join(runDir(this.options.pawsRoot, runId), "agent-profile.json"),
      JSON.stringify({ ...this.readProfileSnapshot(runId), profiles }),
      { mode: 0o600 },
    );
  }

  /** The Closeout policy and the runtime list, both read from origin/main and never the work tree. */
  private async trustedRunInputs(
    item: WorkItemRecord,
    input: RunAgentOptions,
  ): Promise<
    Pick<
      RunAgentOptions,
      | "closeoutPolicy"
      | "runtimes"
      | "githubRead"
      | "ciRerun"
      | "suggestedFindings"
      | "reviewFindings"
    >
  > {
    const repository = this.repositoryForItem(item);
    if (input.prepareOnly || !repository) return {};
    const mirror = !!this.options.remoteExecution;
    const repo = mirror ? this.itemHead(item).repo : input.worktreePath;
    const runtimes = {
      runtimes: () => this.runtimeList(item, repo, mirror ? "mirror" : "checkout"),
    };
    if (input.role !== "implementer") return runtimes;
    const { home, policyRoot } = this.closeoutHome(item);
    const pull = await this.store.run((q) => getItemPullRequestSteps(q, item.id));
    const github = pull ? this.githubForRepository(repository) : null;
    const suggested = input.readOnly ? [] : await waitingSuggestions(this.store, item.id);
    const failed = input.readOnly ? [] : reviewFindingGroups(await this.failedReviewFindings(item));
    return {
      ...runtimes,
      ...(suggested.length ? { suggestedFindings: suggested } : {}),
      ...(failed.length ? { reviewFindings: failed } : {}),
      ...(!input.readOnly && this.agentReadAllowed(item, `${repository.owner}/${repository.repo}`)
        ? { githubRead: { prompt: GITHUB_READ_PROMPT } }
        : {}),
      ...(pull && github && !input.readOnly
        ? {
            ciRerun: (reason: string) =>
              rerunItemCi({
                db: this.db,
                itemId: item.id,
                label: item.linearIdentifier,
                reason,
                github: {
                  client: github.client,
                  owner: repository.owner,
                  repo: repository.repo,
                  prNumber: pull.pullNumber,
                  ...this.gitHubCredentials(github),
                },
                now: () => this.now(),
                journal: this.options.journal,
              }),
          }
        : {}),
      closeoutPolicy: async () => {
        const load = trustedPolicyFiles(repo, home, policyRoot);
        // The runner parses the policy with its own release: say which keys it would leave out.
        if (load.ok && !load.absent)
          await checkPolicyRunners(this.store, {
            repository: `${repository.owner}/${repository.repo}`,
            digest: load.digest,
            files: load.files,
            now: this.now(),
          });
        return load.ok && !load.absent
          ? { ...load, published: publishedEvidence(this.db, item.id) }
          : load;
      },
    };
  }

  private async failedReviewFindings(item: WorkItemRecord): Promise<ReviewFindings[]> {
    try {
      await this.pullCloseoutEvidence(item);
      return await failedReviewFindings(this.store, item.id, this.options.pawsRoot);
    } catch (caught) {
      journalCaught(caught, "orchestrator.failedReviewFindings", item.id);
      return [];
    }
  }

  private agentReadAllowed(item: WorkItemRecord, repository: string): boolean {
    try {
      return agentReadAllowed(
        loadConfigFile(join(this.options.pawsRoot, "config.toml")),
        repository,
      );
    } catch (error) {
      journalCaught(
        error,
        "orchestrator.agentReadAllowed.loadConfigFile",
        item.id,
        undefined,
        this.options.journal,
      );
      return false;
    }
  }

  private async runtimeList(
    item: WorkItemRecord,
    repo: string,
    source: "checkout" | "mirror",
  ): Promise<RuntimeList> {
    const runId =
      (await this.store.run((q) => getWorkItemSteps(q, item.id)))?.currentRunId ?? item.id;
    return this.runtimeLists.read(item.id, runId, repo, source);
  }

  /**
   * What the item's current run leaves out of its checkouts, pinned on the run the first time it
   * is read: `agent` for the agent's worktree and snapshot, `checks` for Closeout and review,
   * which Closeout folds into its policy digest. A `paws:full-checkout` label on the issue when
   * the task started leaves nothing out.
   */
  private runCheckout(item: WorkItemRecord): CheckoutExclusions {
    const resolve = (): CheckoutExclusions => {
      const repository = this.repositoryForItem(item);
      if (!repository) return { agent: [], checks: [] };
      return checkoutExclusionsFor(
        loadConfigFile(join(this.options.pawsRoot, "config.toml")).checkoutProjects,
        `${repository.owner}/${repository.repo}`,
        issueLabels(getTaskMergeSettings(this.db, item.id)?.resolved.labels),
      );
    };
    const runId = getWorkItem(this.db, item.id)?.currentRunId ?? null;
    return runId === null ? resolve() : pinRunCheckout(this.db, runId, resolve);
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
    return getWorkItemRepository(this.db, item.id);
  }

  /**
   * Where the item's head lives. A runner-backed item keeps no worktree on the control plane: its
   * head is its candidate ref in the bare mirror. Local execution reads the worktree's HEAD.
   */
  private itemHead(item: WorkItemRecord): { repo: string; ref: string } {
    const repository = this.repositoryForItem(item);
    return this.options.remoteExecution && repository
      ? {
          repo: mirrorPath(this.options.pawsRoot, repository.owner, repository.repo),
          ref: candidateRef(itemPathId(item)),
        }
      : { repo: worktreePath(this.options.pawsRoot, itemPathId(item)), ref: "HEAD" };
  }

  private async ensureRecordedCandidate(
    item: WorkItemRecord,
    placement: Parameters<typeof ensureCandidateRef>[0] & { remoteUrl: string },
    signal: AbortSignal,
  ): Promise<string> {
    await this.restoreCandidate(item, signal);
    const candidate = await ensureCandidateRef(placement);
    if (!(await this.store.run((q) => getItemCandidateSteps(q, item.id))))
      await this.store.run((q) =>
        recordItemCandidateSteps(q, {
          itemId: item.id,
          sha: candidate.head,
          branch: item.branchName,
          recordedAt: this.now(),
        }),
      );
    return candidate.mirrorPath;
  }

  private async restoreCandidate(item: WorkItemRecord, signal?: AbortSignal): Promise<void> {
    const repository = this.repositoryForItem(item);
    const recorded = await this.store.run((q) => getItemCandidateSteps(q, item.id));
    if (!this.options.remoteExecution || !repository || !recorded) return;
    const owned = signal ?? AbortSignal.timeout(120_000);
    const networkGit = await this.repositoryGit(item, repository, owned, "read");
    const baseSha = item.checkpoint?.baseSha;
    await restoreCandidateRef({
      ...repository,
      itemId: itemPathId(item),
      pawsRoot: this.options.pawsRoot,
      sha: recorded.sha,
      signal: owned,
      ...(baseSha ? { baseSha } : {}),
      ...(networkGit ? { networkGit } : {}),
    });
  }

  private async legacyItemHead(item: WorkItemRecord): Promise<{ repo: string; ref: string }> {
    const repository = this.repositoryForItem(item);
    if (this.options.remoteExecution && repository)
      await adoptLegacyCandidate({
        ...repository,
        itemId: itemPathId(item),
        pawsRoot: this.options.pawsRoot,
      });
    await this.restoreCandidate(item, this.signalForItem(item.id));
    return this.itemHead(item);
  }

  /** Where a runner-backed run stages the agent's input files; it is no checkout. */
  private runnerWorkspace(runId: string): string {
    const path = join(runDir(this.options.pawsRoot, runId), "workspace");
    mkdirSync(path, { recursive: true, mode: 0o700 });
    return path;
  }

  private async selectRepository(
    item: WorkItemRecord,
    access: "read" | "write" = "write",
  ): Promise<boolean> {
    if ((await this.store.run((q) => getConversationSteps(q, item.id))).blocked)
      throw new Error("Prior ACP process cleanup could not be verified");
    const bound = await this.store.run((q) => getWorkItemRepositorySteps(q, item.id));
    if (bound !== null && access === "write") return true;
    const liveKey = `repository:${item.id}`;
    const live = await this.beginLive(item.id, liveKey);
    const controller = live.controller;
    const auth = this.authorization(item);
    const generation = item.sessionKey
      ? await this.store.run((q) => getLinearSessionGenerationSteps(q, item.sessionKey!))
      : 0;
    const current = async () =>
      !this.stopped(item.id) &&
      (!item.sessionKey ||
        (await this.store.run((q) => getLinearSessionGenerationSteps(q, item.sessionKey!))) ===
          generation);
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
      const catalog = (await this.store.run((q) => listRepositoryCatalogSteps(q))).map(
        ({ owner, repo, remoteUrl }) => ({
          owner,
          repo,
          remoteUrl,
        }),
      );
      const configured = await this.store.run((q) =>
        listRepositoryCandidatesSteps(q, item.sessionKey, this.options.repositories ?? []),
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
      const savedAnswer = await this.store.run((q) => getWorkItemRepositoryAnswerSteps(q, item.id));
      const remembered = await this.store.run((q) => getWorkItemRepositoryChoiceSteps(q, item.id));
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
        if (!(await current())) return false;
        if (
          savedAnswer &&
          !(await this.store.transaction((q) =>
            rememberWorkItemRepositoryChoiceSteps(q, item.id, savedAnswer.questionId, selected!),
          ))
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
          await this.store.transaction((q) => bindWorkItemRepositorySteps(q, item.id, selected!));
          if (savedAnswer)
            await this.store.transaction((q) =>
              enqueueOutboxOnceSteps(q, {
                target: "linear",
                op: "linear.repository_label",
                orderingKey: this.activitySession(item) ?? item.id,
                idempotencyKey: `repository-label:${item.id}`,
                payload: {
                  issueId: item.linearIssueId,
                  repository: `${selected.owner}/${selected.repo}`,
                },
                now: this.now(),
              }),
            );
          return true;
        }
        candidates.splice(selectedIndex, 1);
      }
      if (candidates.length === 0) {
        await this.fail(item, "no_repository", "No configured GitHub repository is accessible.");
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
        if (!(await current())) return false;
        if (!accessible) {
          await this.fail(item, "no_repository", "No configured GitHub repository is accessible.");
          return false;
        }
        await this.store.transaction((q) =>
          bindWorkItemRepositorySteps(q, item.id, candidates[0]!),
        );
        return true;
      }
      const recent = await this.store.run((q) => recentRepositoryNamesSteps(q, 50));
      const recency = (candidate: RepositoryBinding) => {
        const index = recent.indexOf(`${candidate.owner}/${candidate.repo}`.toLowerCase());
        return index === -1 ? Number.MAX_SAFE_INTEGER : index;
      };
      candidates.sort((left, right) => recency(left) - recency(right));
      let hinted: ReturnType<typeof hintedRepository> = null;
      if (this.tracker?.issueRepositoryHints) {
        try {
          const kept = (await this.store.run((q) =>
            getTaskLinearReadSteps(q, item.id, "repository_hints"),
          )) as RepositoryHints | undefined;
          const hints =
            kept ??
            (await linearCaller("repository-hints", () =>
              this.tracker!.issueRepositoryHints!(item.linearIssueId, {
                signal: controller.signal,
              }),
            ));
          if (kept === undefined)
            await this.store.run((q) =>
              keepTaskLinearReadSteps(q, item.id, "repository_hints", hints, this.now()),
            );
          hinted = hintedRepository(candidates, hints);
        } catch (error) {
          journalCaught(
            error,
            "orchestrator.selectRepository.getTaskLinearRead",
            live.itemId,
            undefined,
            this.options.journal,
          );
          controller.signal.throwIfAborted();
        }
      }
      const best = new Map<string, RepositorySuggestion>();
      const pool = hinted && "ask" in hinted ? hinted.ask : candidates;
      const poolNames = pool.map((candidate) =>
        `${candidate.owner}/${candidate.repo}`.toLowerCase(),
      );
      const keptSuggestions = (await this.store.run((q) =>
        getTaskLinearReadSteps(q, item.id, "repository_suggestions"),
      )) as { pool: string[]; suggestions: RepositorySuggestion[] } | undefined;
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
          journalCaught(
            error,
            "orchestrator.selectRepository.linearCaller",
            live.itemId,
            undefined,
            this.options.journal,
          );
          controller.signal.throwIfAborted();

          if (attempt < 3)
            await this.waitWithoutAwake(item.id, "backoff", attempt * 500, controller.signal);
        }
      }
      if (suggested)
        await this.store.run((q) =>
          keepTaskLinearReadSteps(
            q,
            item.id,
            "repository_suggestions",
            { pool: poolNames, suggestions: [...best.values()] },
            this.now(),
          ),
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
        if (!(await current())) return false;
        if (accessible) {
          await this.store.transaction((q) => bindWorkItemRepositorySteps(q, item.id, choice.bind));
          // A runner posts its own start line naming the repository.
          if (!this.options.remoteExecution)
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
          { itemId: item.id, runId: null, sessionId, version: item.version },
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
      });
      await this.flush();
      return false;
    } catch (error) {
      if (
        !controller.signal.aborted &&
        (await this.store.run((q) => getWorkItemSteps(q, item.id)))?.state === "running"
      )
        await restartAsync(
          this.store,
          (await this.store.run((q) => getWorkItemSteps(q, item.id)))!,
          {
            reason: "follow_up",
            body: "Retry repository selection.",
            now: this.now(),
          },
        );
      throw error;
    } finally {
      this.live.delete(liveKey);
      live.finish();
    }
  }

  private githubForRepository(repository: RepositoryBinding): GitHubBinding | null {
    return this.options.githubForRepository?.(repository) ?? null;
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
    } catch (caughtError17) {
      journalCaught(
        caughtError17,
        "orchestrator.launchAgent.loadConfigFile",
        input.itemId,
        undefined,
        this.options.journal,
      );
      return launched;
    }
  };

  private now(): number {
    return (this.options.clock ?? systemClock).now();
  }

  private async claimRun(runId: string): Promise<void> {
    const instanceId = this.options.instanceId;
    if (instanceId !== undefined) await this.store.run((q) => claimRunSteps(q, runId, instanceId));
  }

  private async waitWithoutAwake(
    itemId: string,
    reason: "ci" | "runner" | "backoff",
    ms: number,
    signal?: AbortSignal,
    sleep?: (ms: number) => Promise<void>,
  ): Promise<void> {
    const clock = this.options.clock ?? systemClock;
    const job = this.leasedJobs.get(itemId);
    if (job) await markJobAwakeWaitAsync(this.store, job, true, clock.mono(), clock.now(), reason);
    try {
      if (sleep) await sleep(ms);
      else await delay(ms, undefined, signal ? { signal } : {});
    } finally {
      if (job)
        await markJobAwakeWaitAsync(this.store, job, false, clock.mono(), clock.now(), reason);
    }
  }

  /** Records awake time up to this instant, under the item's category before the next wait. */
  private settleItemAwake(itemId: string): void {
    const clock = this.options.clock ?? systemClock;
    accrueAwake(this.db, itemId, clock.mono(), clock.now());
  }
}

/** The next turn after a handover that failed once the agent stopped. */
const HANDOVER_FAILED_PROMPT =
  "Paws asked to move this session to another runner, but the move failed after your turn was stopped, so it stays here. Your work so far is committed. Continue where you left off.";

const PUSH_CONFLICT_RESTARTED =
  "Your commits conflict with the branch on GitHub, so Paws starts a new turn to resolve that. End your turn now without further changes.";
const ACCEPTED_ON_REMOTE =
  "The branch on GitHub already has the work Closeout accepted, so Paws sent it to the merge queue. End your turn now without further changes.";
const LINEAR_RATE_LIMITED = /Linear GraphQL: RATELIMITED/;
const RATE_LIMIT_RETRY_MS = 5_000;
const OUTBOX_WAIT_MS = 30_000;
const FIRST_ACTIVITY_HOLD_MS = 5_000;
const CHECKS_RATE_LIMIT_RETRY_MS = 60_000;
const CHECKS_RATE_LIMIT_WAIT_MS = 60 * 60_000;

const RESPONSE_COMMENT_TURNS = 3;

const RESPONSE_COMMENT_PROMPT: Record<string, string> = {
  answer:
    "These comments arrived while you answered. Take them into account and give your complete answer again in your final message.",
  plan: "These comments arrived while you planned. Take them into account and give your complete plan again in your final message.",
  artifact:
    "These comments arrived while you worked. Take them into account, publish any changed deliverables with publish_artifact, and give your complete final response with the published file links again.",
};

export function attachOrchestrator(options: OrchestratorOptions): Orchestrator {
  return new Orchestrator(options);
}

function implementerAgentFor(
  config: ReturnType<typeof loadConfigFile>,
  repository: RepositoryBinding | null,
  labels: ProfileLabels | undefined,
): string {
  return resolveAgentProfiles(
    config,
    repository ? `${repository.owner}/${repository.repo}` : undefined,
    labels,
  ).implementer.agent;
}

function* closeActiveRunSteps(
  q: Q,
  runId: string,
  now: number,
  status: "ended" | "lost" = "ended",
): Steps<void> {
  const run = yield* getRunSteps(q, runId);
  if (run && run.status === "active") yield* markRunSteps(q, runId, status, now);
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

function mergeCandidate(
  item: WorkItemRecord,
  payload: unknown,
): { sha: string; baseSha: string } | undefined {
  const priorVerification = ciWaitVerification(payload);
  if (priorVerification) return { sha: priorVerification.head, baseSha: priorVerification.base };
  return item.checkpoint?.wipCommit && item.checkpoint.baseSha
    ? { sha: item.checkpoint.wipCommit, baseSha: item.checkpoint.baseSha }
    : undefined;
}

function retryCount(payload: unknown): number {
  const retry = (payload as { retry?: unknown } | null)?.retry;
  return typeof retry === "number" ? retry : 0;
}

const CLOSEOUT_FAULT_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000];
const MERGE_TURN_NOTE_MS = 10 * 60_000;
const REVIEWER_ALERT_INTERVAL_MS = 60 * 60_000;

function closeoutFaults(payload: unknown): CloseoutFaults | null {
  const faults = (payload as { closeoutFaults?: unknown } | null)?.closeoutFaults;
  if (typeof faults !== "object" || faults === null) return null;
  const { head, reasons } = faults as { head?: unknown; reasons?: unknown };
  if (typeof head !== "string" || !Array.isArray(reasons)) return null;
  return { head, reasons: reasons.filter((entry) => typeof entry === "string") };
}

function readString(payload: unknown, key: string): string | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function readBoolean(payload: unknown, key: string): boolean | null {
  if (typeof payload !== "object" || payload === null) return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "boolean" ? value : null;
}

function sameRepository(left: RepositoryBinding, right: RepositoryBinding): boolean {
  return (
    left.owner === right.owner && left.repo === right.repo && left.remoteUrl === right.remoteUrl
  );
}

function brokenRuleOf(report: string | undefined): string | undefined {
  try {
    const parsed = JSON.parse(report ?? "null") as {
      pending?: unknown;
      blocked?: unknown;
      rules?: { id?: unknown; result?: { exitCode?: unknown; timedOut?: unknown } }[];
    } | null;
    if (!Array.isArray(parsed?.pending) || parsed.pending.length > 0) return undefined;
    if (typeof parsed.blocked !== "string" || !Array.isArray(parsed.rules)) return undefined;
    const broken = parsed.rules.find(
      (rule) =>
        typeof rule.id === "string" &&
        typeof rule.result?.exitCode === "number" &&
        rule.result.exitCode !== 0 &&
        rule.result.timedOut !== true,
    );
    return typeof broken?.id === "string" ? broken.id : undefined;
  } catch (caughtError) {
    journalCaught(caughtError, "orchestrator.brokenRuleOf.parse", null);
    return undefined;
  }
}

function listsChecks(report: string): boolean {
  try {
    const parsed = JSON.parse(report) as { required?: unknown; rules?: unknown };
    return (
      (Array.isArray(parsed.required) && parsed.required.length > 0) ||
      (Array.isArray(parsed.rules) && parsed.rules.length > 0)
    );
  } catch (caughtError18) {
    journalCaught(caughtError18, "orchestrator.listsChecks.parse", null);
    return false;
  }
}

/** The issue labels kept with the task's merge settings when it started. */
type ProfileRole = "implementer" | "reviewer";
type ProfileLabels = Partial<Record<ProfileRole, string>>;

const USE_THE_DEFAULT = "Use the default";

/** Label problems decide whether a run starts; they are not part of its saved profiles. */
function withoutLabelProblems(
  resolved: AgentProfiles & { labelProblems?: unknown },
): AgentProfiles {
  const { labelProblems: _problems, ...profiles } = resolved;
  return profiles;
}

function profileLabelQuestion(
  problems: readonly AgentLabelProblem[],
  presets: readonly string[],
): string {
  const lines = problems.map((problem) => {
    const role = problem.role === "implementer" ? "Implementer" : "Reviewer";
    const reason =
      problem.reason === "unknown_preset"
        ? "no preset has this name"
        : "it would review with the same agent and model that implement";
    return `- ${role} label "${problem.label}": ${reason}.`;
  });
  return [
    "The agent profile labels on this issue can't be used, so the run hasn't started:",
    ...lines,
    `Available presets: ${presets.length > 0 ? presets.join(", ") : "none"}.`,
    "Use the default profile for this item, or fix the label in Linear and say so.",
  ].join("\n");
}

function issueLabels(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((label) => typeof label === "string") : [];
}

function repositoryRefusedIn(error: unknown): RunnerRepositoryRefused | null {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current instanceof RunnerRepositoryRefused) return current;
    current = current.cause;
  }
  return null;
}

function capacityWaitIn(error: unknown): RunnerCapacityWait | null {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current instanceof RunnerCapacityWait) return current;
    current = current.cause;
  }
  return null;
}

/** A temporary owner conflict preserves the reverify request without spending attempts. */
class VerificationHeld extends Error {
  constructor() {
    super("Verification is held by another operation or runner lease");
  }
}

const VERIFICATION_OWNER_WAIT_MS = 20 * 60_000;
const VERIFICATION_OWNER_POLL_MS = 5_000;

const SLOTS_BUSY_RETRY_MS = 60_000;

function slotsBusy(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; depth++) {
    if (current instanceof RunnerSlotsBusyError) return true;
    current = current.cause;
  }
  return false;
}

function usageResetAt(error: unknown): number | null {
  if (!(error instanceof Error) || error.name !== "UsageLimitPause") return null;
  const resumeAt = (error as Error & { resumeAt?: unknown }).resumeAt;
  return typeof resumeAt === "number" && Number.isFinite(resumeAt) ? resumeAt : null;
}
