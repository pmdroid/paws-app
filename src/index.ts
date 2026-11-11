import {
  createFindingGrouping,
  registerFindingGrouping,
  workspaceGroupingSources,
} from "./finding-groups";
import { shutdownPaws, stopPawsComponents } from "./shutdown";
import { journalCaught } from "./journal";
import { startBrowserOnboarding } from "./onboarding-start";
import { createBrowserOnboarding } from "./onboarding";
import { runRunnerCli } from "./runner-cli";
import { createAccountManagement } from "./account-management";
import { dirname, join } from "node:path";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { createOnboardingReadiness } from "./onboarding-readiness";
import {
  createMemberVmHttp,
  createMemberVmProvisioning,
  registerMemberVmDeleteJob,
  registerMemberVmJob,
} from "./member-vm";
import {
  createExeDev,
  exeDevTokenReader,
  tailscaleAuthKeyReader,
  latestRunnerRelease,
  type ExeDev,
  type ExeDevBootstrap,
} from "./provisioning";
import { createSlackIdentityReads, loginSlack, readSlackApp } from "./slack";
import {
  collectProbes,
  keepCandidates,
  parseProbesArgs,
  readStoredFindings,
  type ProbesCommand,
} from "./probe-collector";
import { envelopeSubkey, importCredentialFile, loadSecretKey, readSecretFile } from "./credentials";
import type { Database } from "bun:sqlite";
import {
  ArtifactRejectedError,
  commitCheckpointSync,
  git,
  mirrorFiles,
  runAgent,
  worktreePath,
} from "./acp";
import { policyCheckPaths } from "./closeout";
import {
  createEvidenceStore,
  EvidenceRejectedError,
  uploadLocalCloseoutEvidence,
  uploadLocalEvidence,
  type EvidenceObjects,
} from "./evidence";
import {
  createS3RunFileObjects,
  createS3RunnerFileObjects,
  withSealedRunFileObjects,
} from "./run-files";
import {
  closeoutPolicyRoot,
  describeDatabaseUrl,
  POSTGRES_NOT_YET,
  redactDatabaseUrl,
  DEFAULT_COMMENT_WAIT,
  DEFAULT_IGNORED_COMMENT_BOTS,
  ensureLayout,
  ignoredCommentBots,
  ignoredCommentMarkers,
  LINEAR_WORKSPACE_REQUIRED,
  loadRuntime,
  resolveAgentProfiles,
  loadEnv,
  loadConfigFile,
  resolveTimeLimits,
  loadRunnerControl,
  pawsPaths,
  readMergeSettings,
  readQueueSettings,
  describeOverriddenSections,
  overriddenConfigSections,
  useSavedSettingsReader,
  useSettingsStore,
  type EnvSource,
  type PawsEnv,
  type PawsPaths,
  type RuntimeConfig,
  sweepTmpDir,
} from "./config";
import { type LinearCommand, type GitCommitPolicy, type Clock, isTransient } from "./core";
import {
  workspaceMemberUsable,
  enqueueCommandSteps,
  getWorkItemSteps,
  getItemRunCommitPolicySteps,
  listRepositoryCandidatesSteps,
  journal,
  getWorkItemRepositoryChoiceSteps,
  getWorkItemRepositoryAnswerSteps,
  getTaskModeSteps,
  taskRequiresRepositorySteps,
  listWorkItemsSteps,
  listReviewEscapesSteps,
  countLinearRequest,
  linearBudgetStore,
  migrate,
  openDatabase,
  checkPostgres,
  checkSqlite,
  connectPostgres,
  type PostgresConnection,
  readSavedSettings,
  readSettingSteps,
  updateSettingSteps,
  CONFIG_SETTINGS_KEY,
  setAsideLegacyDatabase,
  prepareShutdown,
  COMMAND_DELIVERY_MS,
  bindInstance,
  INSTANCE_HEARTBEAT_MS,
  MEMBERSHIP_BACKSTOP_MS,
  roleRunsJobs,
  RUN_TAKEOVER_JOB,
  RUN_TAKEOVER_MS,
  listRepositoryCatalogSteps,
  incrementalVacuum,
  refreshRepositoryCatalog,
  startLoops,
  submitCommand,
  type JobLoop,
  type WorkItemRecord,
  type Q,
  runnerHasCapacitySteps,
  workspaceMemberSteps,
  sqliteDb,
  enabledRunnerIdsSteps,
  listWorkspaceIds,
  missingSnapshotTargetsSteps,
  applyLinearIssueProjectSteps,
  applyLinearUserChangeSteps,
  commandInstance,
  delegatedLinearUserIdSteps,
  enqueueJobOnce,
  getLinearSessionAccessSteps,
  getLinearSessionInstallationSteps,
  getLinearSessionSteps,
  getPullRequestDraftSteps,
  getWorkItemRepositorySteps,
  getWorkspaceSteps,
  listSkillsSteps,
  openDelegationWorkspaceIdSteps,
  submitCommandSteps,
  workItemForSessionSteps,
  workspaceForOrganizationSteps,
  workspaceLinearMemberSteps,
  latestCloseoutProgressMarkerSteps,
  listWorkspaceMembersSteps,
  syncSteps,
  workspaceUserLinearIdSteps,
  type Db,
  clearUsagePausesSteps,
  emitJobReady,
  heartbeatInstanceSteps,
  isLinearAppRevokedSteps,
  jobInstanceElsewhereSteps,
  recoverOnStartupSteps,
  registerInstanceSteps,
  runPendingJobNowSteps,
  stopInstanceSteps,
  takeOverGoneRunsSteps,
  type Steps,
} from "./db";
import { doctorChecks, formatDoctor, realProbe } from "./doctor";
import { installHostMain } from "./install-host";
import { runInstallCli } from "./installer";
import {
  createGitHubTokenProvider,
  createGitHubInstallationCheck,
  createWorkspaceGitHubActivation,
  type ActiveGitHubApp,
  type GitHubTokenProvider as AuthTokenProvider,
} from "./auth";
import {
  checkRepositoryWriteAccess,
  checkRepositoryReadAccess,
  createFetchGitHubClient,
  repositoriesWithMergeQueue,
  repositoriesRequiringUpToDate,
  listAppRepositories,
  createGitHubApp,
  revokeInstallationToken,
  githubHttpsUrl,
  useGitTempDirectory,
  usePublicationRepositories,
  type GitHubBinding,
  type GitHubTokenProvider,
} from "./github";
import { startHost, createLagWatchdog } from "./host";
import { recoverRunnerWorkStall } from "./runner-work";
import {
  checkRedelegation,
  createInboxStore,
  REDELEGATION_CHECK_DELAY_MS,
  linearBudgetIsLow,
  linearCaller,
  linearCallerFor,
  linearItem,
  openLinear,
  importLinearTokenFile,
  readStoredToken,
  parseLinearAdministration,
  parseLinearIssueClosed,
  parseLinearIssueProjectChange,
  parseLinearUndelegation,
  parseLinearUserChange,
  cacheLinearMemberships,
  sessionCreatedKey,
  type AcceptedLinearEvent,
  type IntakeDecision,
  POLL_DUE_CURSOR,
  POLL_INTERVAL_FAILING_MS,
  type LinearRunning,
} from "./linear";
import {
  acceptGitHubDelivery,
  type PullCommentFilter,
  attachOrchestrator,
  createLinearArtifactReader,
  createRepositoryGit,
  itemPathId,
  repositoryAnswer,
  LinearTaskAccess,
  authorizeLinearTask,
  handleLinearAdministration,
  closeClosedIssueTasks,
  FAILED_ISSUE_SWEEP_JOB,
  FAILED_ISSUE_SWEEP_MS,
  sweepFailedIssues,
  stopUndelegatedIssue,
  refreshLinearNotificationContext,
  type Orchestrator,
  type OrchestratorOptions,
  type RepositoryBinding,
  type GitHubDenial,
  type GitHubIntegration,
  teamMemberDenialSteps,
  teamRepositoryDenial,
  riskGateOn,
  RISK_GATE_NEEDS_PUBLIC_URL,
  highRiskPathsFileAt,
  backfillReviewFindings,
  REVIEW_FINDINGS_BACKFILL_JOB,
  POLICY_BLOCK_CHECK_JOB,
  POLICY_BLOCK_CHECK_MS,
} from "./loop";
import {
  formatReviewScore,
  readReviewEscapesFile,
  REVIEW_ESCAPES_FILE,
  scoreReview,
} from "./review-score";
import { handleLinkAskAnswer, handleQuestionAnswer } from "./questions";
import { createFindingIssueRoute } from "./finding-issues";
import { dashboardUrl } from "./dashboard-links";
import {
  BLOCKED_RELATIONS_POLL_MS,
  createBlockerCheckRoute,
  createItemReconciler,
  createRelationsPolls,
  createParentDelegations,
  createPublicationReadiness,
  RELATIONS_POLL_MS,
} from "./intake";
import { createExecutionControls } from "./execution-controls";
import { createAdmission, registerScheduler, saveSchedulingContextSteps } from "./scheduler";
import {
  createRunnerPlacement,
  createRunnerPlacementBrowser,
  itemOwnerEligibleRunnerSteps,
  itemOwnerHasEligibleRunnerSteps,
  itemRunnerVerdictsSteps,
  createRunnerHostRefusals,
  itemOwnerRunnerSetupNeedSteps,
  itemRepositoryAllowedOnSteps,
  itemRepositoryRefusalsSteps,
  itemRepositoryRunnerSteps,
} from "./runner-placement";
import { releaseVersionFromPath } from "./runner-protocol";
import { startServer } from "./server";
import { activeRunnerReadiness } from "./settings";
import {
  createRetroDispatcher,
  createRetroPreviewHttp,
  createRetroReviewHttp,
  createRetroScheduleHttp,
  createRetroScheduler,
  createRetroSettingsHttp,
  retroReaderAccessSteps,
  RETRO_DISPATCH_JOB,
  RETRO_DISPATCH_TIMING,
  RETRO_SCHEDULE_JOB,
  RETRO_SCHEDULE_TICK_MS,
  type RetroDispatcher,
} from "./retros";
import {
  createImprovementsHttp,
  startImprovementDeliveries,
  startImprovementOutcomeSync,
} from "./improvements";
import { itemReviews } from "./dashboard";
import { createSkillResolver, createSkillUpdates, SKILL_UPDATE_INTERVAL } from "./skills";
import { createAgentCatalog, createNpmRegistry } from "./agent-catalog";
import { loadPublicTls, validatePublicTls, PUBLIC_TLS_RESTART_EXIT } from "./deployment";
import {
  canAct,
  isWorkspaceAdmin,
  startWorkspaceAccess,
  delegatorCommitCredit,
  createWorkspaceAssignments,
  type WorkspacePrincipal,
} from "./workspace";
import {
  initializeRunnerCoordinator,
  openRunnerCoordinator,
  type RunnerCoordinator,
  type RunnerRepositoryAccessOptions,
} from "./runner-coordinator";
import { createRunnerSessionMoves } from "./runner-control";
import { cacheRepositoryCredentials } from "./runner-repository-access";
import { rebaseCommitTitle, rebaseOnRunner } from "./runner-repository-commands";
import {
  encryptRunnerEvents,
  loadRunnerEventKey,
  pruneRunnerEvents,
  RUNNER_EVENT_ENCRYPT_JOB,
  RUNNER_EVENT_KEY_FILE,
  RUNNER_EVENT_PRUNE_EVERY_MS,
  RUNNER_EVENT_PRUNE_JOB,
} from "./runner-work";
import {
  encryptRunnerTranscripts,
  loadRunnerTranscriptKey,
  RUNNER_TRANSCRIPT_ENCRYPT_JOB,
  RUNNER_TRANSCRIPT_KEY_FILE,
  type RunnerTranscriptObjects,
} from "./runner-transcripts";
import {
  AGENT_SESSION_KEY_FILE,
  createLocalAgentSessionObjects,
  createS3AgentSessionObjects,
  loadAgentSessionKey,
  withLocalAgentSessionFallback,
} from "./agent-sessions";
import {
  loadRunnerTranscriptStores,
  loadRunnerTranscriptS3,
  runRunnerTranscriptStorageCli,
} from "./runner-transcript-config";
import {
  createRemoteAgentRunner,
  createConversationTurns,
  createRemoteSessionAgentRunner,
  createFindingGroupHelper,
  fetchRunnerCandidate,
  remoteCommandsGoneSteps,
} from "./runner-backend";

const ACCEPTED: IntakeDecision = { outcome: "accepted" };
const MEMBERS_ONLY: IntakeDecision = {
  outcome: "refused",
  reason: "Only active members of the Paws workspace can work with Paws.",
};

export type PawsProcess = {
  env: PawsEnv;
  paths: PawsPaths;
  db: Database;
  /** The async `Db` over `db`, the one handle every holder of `db` gets beside it. */
  store: Db;
  server: Bun.Server<undefined>;
  catchUp: () => Promise<void>;
  ready: Promise<void>;
  stop: () => Promise<void>;
};

export type StartOptions = {
  server?: Bun.Server<undefined>;
  hostClock?: Clock;
  commitPolicyForItem?: (item: WorkItemRecord) => Promise<GitCommitPolicy>;
  runnerRepositoryAccess?: RunnerRepositoryAccessOptions;
  runnerTranscriptObjects?: RunnerTranscriptObjects;
  evidenceObjects?: EvidenceObjects;
  refreshRepositories?: boolean;
  /** Read npm once a day for the coding agent version catalog. Off in tests. */
  refreshAgentCatalog?: boolean;
  /** Replaces the exe.dev client and VM bootstrap behind Create VM. Tests pass the fakes. */
  memberVm?: { exeDev: ExeDev; bootstrap: ExeDevBootstrap; pollMs?: number };
};

const LOOPBACK = "127.0.0.1";
const SKILL_UPDATES_KEY = "skills.updates";
const SETTINGS_REFRESH_MS = 5_000;

/** Open ~/.paws, migrate, recover in-flight work, and listen on 127.0.0.1. */
export async function startPaws(source?: EnvSource, options?: StartOptions): Promise<PawsProcess> {
  const envSource = source ?? process.env;
  const execution = envSource.PAWS_EXECUTION;
  if (execution === "local") throw new Error("Paws places work on a remote runner.");
  if (execution !== undefined && execution !== "remote")
    throw new Error("PAWS_EXECUTION must be remote.");
  const runtime = loadRuntime(envSource);
  if (runtime.configError !== null) throw new Error(runtime.configError);
  if (runtime.databaseUrl !== null) throw new Error(POSTGRES_NOT_YET);
  const publicDashboard = envSource.PAWS_PUBLIC_DASHBOARD === "1";
  const tls = publicDashboard ? validatePublicTls(envSource) : loadPublicTls(envSource);
  const runnerConfig = loadRunnerControl(envSource, runtime.env);
  let repositoryAccess = options?.runnerRepositoryAccess;
  const remotePlacementReady = runnerConfig !== null;
  if (execution === "remote" && !remotePlacementReady)
    throw new Error("Remote execution requires runner HTTPS and GitHub App repository access.");
  if (runnerConfig !== null && (!publicDashboard || tls === undefined))
    throw new Error("Runner control requires the public HTTPS dashboard.");
  if (publicDashboard) {
    const origin = runtime.publicUrl === null ? null : new URL(runtime.publicUrl);
    if (
      origin === null ||
      origin.protocol !== "https:" ||
      origin.username !== "" ||
      origin.password !== "" ||
      origin.pathname !== "/" ||
      origin.search !== "" ||
      origin.hash !== ""
    )
      throw new Error("Public dashboard requires an HTTPS origin in PAWS_PUBLIC_URL.");
  }
  const placeOnRunner = remotePlacementReady;
  const transcriptStorage = options?.runnerTranscriptObjects
    ? { objects: options.runnerTranscriptObjects, stores: [options.runnerTranscriptObjects] }
    : placeOnRunner
      ? loadRunnerTranscriptStores(runtime.env.home)
      : undefined;
  const transcriptObjects = transcriptStorage?.objects;
  const env = { ...runtime.env, host: publicDashboard ? runtime.env.host : LOOPBACK };
  const paths = pawsPaths(env.home);
  setAsideLegacyDatabase(paths.db, envSource);
  ensureLayout(paths);
  sweepTmpDir(paths);
  useGitTempDirectory(paths.tmpDir);
  usePublicationRepositories(paths.publicationDir);
  const db = openDatabase(paths.db);
  const store = sqliteDb(db);
  migrate(db);
  await importLinearTokenFile(store, paths.secretsDir, runtime.linearTokenFile);
  await importCredentialFile(
    store,
    paths.secretsDir,
    "slack",
    join(paths.secretsDir, "slack-oauth.json"),
  );
  await store.run(clearUsagePausesSteps);
  const linearRevoked = () =>
    store.run((q) =>
      isLinearAppRevokedSteps(q, {
        oauthClientId: runtime.linearClientId,
        appUserId: runtime.linearViewerId,
      }),
    );
  if (
    publicDashboard &&
    ((await linearRevoked()) ||
      (runtime.linearAccessToken === null &&
        (await readStoredToken(store, paths.secretsDir)) === null))
  ) {
    const reconnect = await linearRevoked();
    db.close();
    return startBrowserOnboarding(
      runtime,
      tls!,
      (server) => startPaws(envSource, { ...options, server }),
      envSource,
      reconnect,
    );
  }
  if (publicDashboard && runtime.linearClientId === null) {
    db.close();
    throw new Error("Public dashboard requires the Linear app OAuth client.");
  }
  const instance = await store.run((q) =>
    registerInstanceSteps(q, {
      role: runtime.role,
      host: hostname(),
      version: installedPawsVersion(),
      now: Date.now(),
      pid: process.pid,
    }),
  );
  bindInstance(store, instance.id);
  const savedSettings = await useSettingsStore(paths.configFile, {
    read: () => store.run((q) => readSettingSteps(q, CONFIG_SETTINGS_KEY)),
    update: (change) =>
      store.transaction((q) => updateSettingSteps(q, CONFIG_SETTINGS_KEY, change)),
  });
  const settingsTimer = setInterval(() => {
    void savedSettings
      .refresh()
      .catch((error: unknown) => journalCaught(error, "index.startPaws.refreshSettings", null));
  }, SETTINGS_REFRESH_MS);
  settingsTimer.unref?.();
  const releaseSettings = () => {
    clearInterval(settingsTimer);
    savedSettings.release();
  };
  const overriddenSections = overriddenConfigSections(paths.configFile);
  if (overriddenSections.length > 0) journal(describeOverriddenSections(overriddenSections));
  const reconnectLinear = publicDashboard
    ? createBrowserOnboarding({
        db,
        home: paths.home,
        origin: runtime.publicUrl!,
        clientId: runtime.linearClientId,
        clientSecret: runtime.linearClientSecret,
        expectedOrganizationId: runtime.linearOrganizationId,
        reconnect: true,
        installed() {},
      })
    : null;
  const appActivation = createWorkspaceGitHubActivation(store, runtime.env.home, envSource);
  const resolveApp = (repository: string) => appActivation.resolve(repository);
  repositoryAccess ??= runnerRepositoryAccess(runtime, resolveApp);
  const commentFilter = pullCommentFilter(runtime, paths.configFile, resolveApp);
  const recoveryWake = { armed: false };
  const recoveredAt = Date.now();
  await store.transaction((q) =>
    recoverOnStartupSteps(q, recoveredAt, undefined, instance.id, recoveryWake),
  );
  if (recoveryWake.armed) emitJobReady(store);
  const abort = new AbortController();
  let orchestrator: Orchestrator | null = null;
  let reconciler: ReturnType<typeof createItemReconciler> | null = null;
  let blockerChecks: ReturnType<typeof createBlockerCheckRoute> | null = null;
  let publication: ReturnType<typeof createPublicationReadiness> | null = null;
  let executionControls: ReturnType<typeof createExecutionControls> | null = null;
  const repositories = runtime.repos
    .map(repositoryBinding)
    .filter((value): value is RepositoryBinding => value !== null);
  const listCatalog = async () => {
    const client = createFetchGitHubClient();
    const lists = await Promise.all(
      (await appActivation.installations()).map((app) =>
        listAppRepositories({
          client,
          appId: app.appId,
          installationId: app.installationId!,
          privateKeyPem: app.privateKeyPem,
          signal: abort.signal,
        }),
      ),
    );
    return lists.flat();
  };
  const periodic: {
    queue: string;
    everyMs: number;
    atStartup?: boolean;
    startup?: () => Promise<void>;
    run: (signal: AbortSignal) => Promise<unknown>;
  }[] = [];
  if (options?.refreshRepositories)
    periodic.push({
      queue: "repository.catalog.refresh",
      everyMs: 600_000,
      atStartup: true,
      run: () => refreshRepositoryCatalog(store, listCatalog),
    });
  if (options?.refreshAgentCatalog) {
    const agentCatalog = createAgentCatalog({ store, registry: createNpmRegistry() });
    // Hourly checks keep the daily read on schedule across sleep and restarts.
    periodic.push({
      queue: "agent.catalog.refresh",
      everyMs: 60 * 60 * 1000,
      atStartup: true,
      run: (signal) => agentCatalog.refreshIfDue(AbortSignal.any([signal, abort.signal])),
    });
  }
  const skillUpdates = createSkillUpdates({
    store: {
      read: async () =>
        JSON.parse(
          (await store.run((q) => readSettingSteps(q, SKILL_UPDATES_KEY))) ?? "{}",
        ) as Record<string, string>,
      write: (commits) =>
        store.transaction((q) =>
          updateSettingSteps(q, SKILL_UPDATES_KEY, () => JSON.stringify(commits)),
        ),
    },
  });
  periodic.push({
    queue: "skills.updates.check",
    everyMs: SKILL_UPDATE_INTERVAL,
    run: async () => skillUpdates.check(await store.run(listSkillsSteps)),
  });
  const webhooks = runtime.webhooks;
  const inbox = createInboxStore(store);

  const followUp = async (event: AcceptedLinearEvent): Promise<void | boolean> => {
    if (orchestrator === null) throw new Error("loop is not attached");
    const accepted = await orchestrator.onLinearEvent(event);
    const known = event.sessionId ? orchestrator.takeIntakeReads(event.sessionId) : undefined;
    if (accepted !== false && reconciler && event.sessionId) {
      const sessionId = event.sessionId;
      const session = await store.run((q) => getLinearSessionSteps(q, sessionId));
      const linked = await store.run((q) => workItemForSessionSteps(q, sessionId));
      if (linked && session?.organizationId && session.stoppedAt === null) {
        const organizationId = session.organizationId;
        const workspaceId = await store.run((q) =>
          openDelegationWorkspaceIdSteps(q, organizationId, linked.delegationId),
        );
        if (workspaceId)
          await reconciler.reconcile({
            itemId: linked.id,
            workspaceId,
            signal: abort.signal,
            known: event.action === "created" ? known : undefined,
          });
        await orchestrator.reconcileExecution();
      }
    }
    return accepted;
  };
  function* submitSteps(q: Q, command: LinearCommand): Steps<void> {
    if (orchestrator === null) {
      const { inserted } = yield* enqueueCommandSteps(q, command);
      if (inserted) emitJobReady(store);
      return;
    }
    const bus = orchestrator.bus;
    yield* submitCommandSteps(
      q,
      command,
      (c) => bus.emit(c),
      () => emitJobReady(store),
      commandInstance(store),
    );
  }
  const submitAsync = async (command: LinearCommand): Promise<void> => {
    if (orchestrator === null) {
      const { inserted } = await store.run((q) => enqueueCommandSteps(q, command));
      if (inserted) emitJobReady(store);
      return;
    }
    await submitCommand(store, orchestrator.bus, command);
  };

  let linearTaskAccess: LinearTaskAccess | null = null;
  const invalidateAuthorization = async (
    scope: { sessionId?: string; issueId?: string } = {},
  ): Promise<void> => {
    linearTaskAccess?.invalidate(scope);
    await orchestrator?.invalidateGitHubAuthorization(scope);
  };
  let workspace: ReturnType<typeof startWorkspaceAccess> | undefined;
  let assignments: ReturnType<typeof createWorkspaceAssignments> | undefined;
  let members: ReturnType<typeof cacheLinearMemberships> | null = null;
  function* stopLinearSessionSteps(q: Q, sessionId: string): Steps<void> {
    for (const item of yield* listWorkItemsSteps(q)) {
      if (item.sessionKey !== sessionId) continue;
      if (["cancelled", "completed", "merged"].includes(item.state)) continue;
      yield* submitSteps(q, {
        type: "cancel",
        source: "linear",
        itemId: item.id,
        requestedAt: Date.now(),
      });
    }
  }

  const linear = await openLinear({
    db,
    store,
    signal: abort.signal,
    countItemRequest: async (itemId, caller) =>
      await countLinearRequest(sqliteDb(db), itemId, caller),
    budget: linearBudgetStore(sqliteDb(db), runtime.linearClientId ?? "linear"),
    secretsDir: paths.secretsDir,
    isAuthorized: async () => !(await linearRevoked()),
    beforeEvent: async (event, request) => {
      members?.invalidate(event);
      const userChange = parseLinearUserChange(event);
      if (userChange) {
        if (
          await store.transaction((q) =>
            applyLinearUserChangeSteps(q, { ...userChange, now: Date.now() }),
          )
        )
          await invalidateAuthorization();
        return false;
      }
      const issueEvent = acceptedIssueChange(event);
      if (issueEvent) await invalidateAuthorization({ issueId: issueEvent.issueId });
      const projectChange = parseLinearIssueProjectChange(event);
      if (projectChange)
        await store.run((q) =>
          applyLinearIssueProjectSteps(q, projectChange.issueId, projectChange.project),
        );
      const undelegation = parseLinearUndelegation(event, runtime.linearViewerId);
      if (undelegation)
        await stopUndelegatedIssue(store, undelegation, {
          notify: (command) => {
            if (orchestrator === null) throw new Error("The loop is not attached.");
            orchestrator.bus.emit(command);
          },
          interrupt: async (sessionId) => {
            if (orchestrator === null) throw new Error("The loop is not attached.");
            await orchestrator.interruptLinearSession(sessionId);
          },
        });
      const closedIssue = parseLinearIssueClosed(event);
      if (closedIssue) {
        await closeClosedIssueTasks(store, closedIssue, {
          notify: (command) => {
            if (orchestrator === null) throw new Error("The loop is not attached.");
            orchestrator.bus.emit(command);
          },
          interrupt: async (sessionId) => {
            if (orchestrator === null) throw new Error("The loop is not attached.");
            await orchestrator.interruptLinearSession(sessionId);
          },
        });
        if (event.source === "poll") return false;
      }
      if (issueEvent && reconciler) {
        const targets = await reconciler.issueChanged(issueEvent);
        if (targets.length > 0) await orchestrator?.reconcileExecution();
        return false;
      }
      if (
        await handleLinearAdministration(store, event, {
          oauthClientId: runtime.linearClientId,
          appUserId: runtime.linearViewerId,
          interrupt: async (sessionId) => {
            if (orchestrator === null) throw new Error("The loop is not attached.");
            await orchestrator.interruptLinearSession(sessionId);
          },
          revalidate: async (sessionIds) => {
            if (linearTaskAccess === null) throw new Error("Linear is not connected.");
            for (const sessionId of sessionIds) await invalidateAuthorization({ sessionId });
            await linearTaskAccess.revalidateSessions(sessionIds);
          },
          reconcile: (notification) =>
            linearCaller("notifications", async () => {
              if (notification.action === "issueAssignedToYou") {
                await inbox.setCursor(
                  `delegated:${notification.issueId}`,
                  notification.createdAtMs,
                );
                await enqueueJobOnce(store, {
                  queue: "linear.redelegation",
                  jobKey: `linear.redelegation:${notification.issueId}:${notification.createdAtMs}`,
                  payload: {
                    issueId: notification.issueId,
                    delegatedAtMs: notification.createdAtMs,
                  },
                  runAt: Date.now() + REDELEGATION_CHECK_DELAY_MS,
                  now: Date.now(),
                });
              }
              if (linearTaskAccess === null) throw new Error("Linear is not connected.");
              if (reconciler)
                await reconciler.issueChanged({
                  issueId: notification.issueId,
                  organizationId: notification.organizationId,
                });
              await invalidateAuthorization({ issueId: notification.issueId });
              await linearTaskAccess.reconcile(notification.issueId);
              await orchestrator?.reconcileExecution();
              await refreshLinearNotificationContext(store, linear?.tracker ?? null, notification);
            }),
          notify: (command) => {
            if (orchestrator === null) throw new Error("The loop is not attached.");
            orchestrator.bus.emit(command);
          },
        })
      ) {
        const administration = parseLinearAdministration(event);
        if (administration?.kind === "revoked" || administration?.kind === "teams")
          await invalidateAuthorization();
        if (
          workspace !== undefined &&
          administration?.kind === "teams" &&
          administration.oauthClientId === runtime.linearClientId &&
          (runtime.linearViewerId === null ||
            administration.appUserId === runtime.linearViewerId) &&
          administration.organizationId === (await workspace.access).organizationId
        )
          await workspace.refresh();
        return false;
      }
      const sessionId = event.sessionId;
      if (
        sessionId !== null &&
        (await store.run((q) => getLinearSessionAccessSteps(q, sessionId))) === "revoked"
      )
        return false;
      if (linearTaskAccess === null) throw new Error("Linear is not connected.");
      return linearTaskAccess.accept(event, request);
    },
    env: linearEnv(runtime, envSource),
    followUp,
    progressReporter: (event) => {
      if (orchestrator === null) throw new Error("loop is not attached");
      return orchestrator.sessionProgressReporter(event);
    },
    submitCommand: submitAsync,
  });

  if (linear !== null)
    linearTaskAccess = new LinearTaskAccess(store, {
      access: linear.access && linearCallerFor(linear.access, "task-access"),
      lifecycle: linear.issueLifecycle && linearCallerFor(linear.issueLifecycle, "task-access"),
      oauthClientId: runtime.linearClientId,
      appUserId: runtime.linearViewerId,
      stopSession: stopLinearSessionSteps,
      interruptSession: async (sessionId) => {
        if (orchestrator === null) throw new Error("The loop is not attached.");
        await orchestrator.interruptLinearSession(sessionId);
      },
    });

  const exeDevToken = exeDevTokenReader(paths.home);
  // Create VM is offered only once an exe.dev token is in ~/.paws/secrets.
  const createVmAvailable = async () =>
    options?.memberVm !== undefined || (await exeDevToken()) !== null;
  if (linear?.memberships) members = cacheLinearMemberships(linear.memberships);
  if (publicDashboard) {
    if (linear?.memberships === null || linear?.memberships === undefined) {
      releaseSettings();
      await store.run((q) => stopInstanceSteps(q, instance.id, Date.now()));
      db.close();
      throw new Error("Public dashboard requires a connected Linear app installation.");
    }
    try {
      if (!linear.issueLifecycle || !linearTaskAccess || !linear.tracker)
        throw new Error("Public workspace assignments require verified Linear task access.");
      {
        assignments = createWorkspaceAssignments({
          store,
          origin: runtime.publicUrl!,
          clientId: runtime.linearClientId!,
          memberships: members!,
          resumeMemberships: linear.memberships,
          lifecycle: linear.issueLifecycle,
          tracker: linear.tracker,
          accept: (event, signal) => linearTaskAccess!.accept(event, { signal }),
          continue: followUp,
        });
      }
      workspace = startWorkspaceAccess({
        onMemberRevoked: async () => {
          const coordinator = await runnerReady;
          await coordinator?.control.expireConnections();
        },
        interruptItem: async (itemId) => {
          await orchestrator?.interruptItem(itemId);
        },
        assignments,
        onboardingReadiness: createOnboardingReadiness(store),
        createVmAvailable,
        githubAttributionClient: (() => {
          try {
            const { clientId, clientSecret } = appActivation.template();
            return { clientId, clientSecret };
          } catch (caughtError2) {
            journalCaught(caughtError2, "index.startPaws.template", null);
            return undefined;
          }
        })(),
        slackIdentities: await createSlackIdentityReads({ home: paths.home, db }),
        store,
        publicUrl: runtime.publicUrl!,
        clientId: runtime.linearClientId!,
        memberships: linear.memberships,
        verifyTeam: (id, signal) => linear.access!.team(id, { signal }),
        readTeams: (signal) => linear.access!.teams!({ signal }),
        retryable: isTransient,
        refreshIntervalMs: null,
        onError: () => console.error("Paws workspace access refresh failed."),
      });
    } catch (error) {
      abort.abort();
      releaseSettings();
      await store.run((q) => stopInstanceSteps(q, instance.id, Date.now()));
      db.close();
      throw error;
    }
    periodic.push({
      queue: "workspace.memberships.refresh",
      everyMs: MEMBERSHIP_BACKSTOP_MS,
      run: async () => workspace?.refresh(),
    });
  }
  const commitPolicyForItem = async (
    item: WorkItemRecord,
    chosen?: RepositoryBinding | null,
  ): Promise<GitCommitPolicy> => {
    const selected =
      chosen === undefined
        ? await store.run((q) => getWorkItemRepositorySteps(q, item.id))
        : chosen;
    if (!selected) throw new Error("Attribution repository is missing");
    const bot = await authProvider(runtime, selected, "read", resolveApp)?.botIdentity?.();
    if (!bot) throw new Error("Attribution App bot authority is unavailable");
    const policy = options?.commitPolicyForItem
      ? await options.commitPolicyForItem(item)
      : { bot, credit: await delegatorCommitCredit(store, item.id) };
    if (
      bot.appId !== policy.bot.appId ||
      bot.id !== policy.bot.id ||
      bot.login !== policy.bot.login
    )
      throw new Error("Attribution App bot authority changed");
    return policy;
  };
  // Snapshots go to the transcript S3 bucket when one is configured; local chunks still read.
  const agentSessionObjects = () => {
    const local = createLocalAgentSessionObjects(join(paths.home, "agent-sessions"));
    const s3 = options?.runnerTranscriptObjects ? null : loadRunnerTranscriptS3(runtime.env.home);
    return s3 ? withLocalAgentSessionFallback(local, createS3AgentSessionObjects(s3)) : local;
  };
  const runnerFileObjects = () => {
    const s3 = options?.runnerTranscriptObjects ? null : loadRunnerTranscriptS3(runtime.env.home);
    return s3
      ? {
          objects: createS3RunnerFileObjects(s3),
          key: loadSecretKey(join(paths.secretsDir, "runner-file.key"), "Runner file"),
        }
      : undefined;
  };
  const evidenceObjects: EvidenceObjects =
    options?.evidenceObjects ??
    (() => {
      const s3 = options?.runnerTranscriptObjects ? null : loadRunnerTranscriptS3(runtime.env.home);
      if (!s3) return null;
      const key = envelopeSubkey(paths.secretsDir, "paws-evidence-objects");
      return withSealedRunFileObjects(createS3RunFileObjects("evidence", s3), key);
    });
  void uploadLocalEvidence(store, { root: paths.evidenceDir, objects: evidenceObjects }).catch(
    (error: unknown) => journalCaught(error, "index.startPaws.uploadLocalEvidence", null),
  );
  const closeoutEvidence = {
    root: join(paths.home, "closeout", "evidence"),
    objects: evidenceObjects,
  };
  void uploadLocalCloseoutEvidence(store, closeoutEvidence).catch((error: unknown) =>
    journalCaught(error, "index.startPaws.uploadLocalCloseoutEvidence", null),
  );
  const catalogRepositories = async () =>
    (await store.run(listRepositoryCatalogSteps)).map((entry) => `${entry.owner}/${entry.repo}`);
  let runner: RunnerCoordinator | undefined;
  if (runnerConfig !== null)
    periodic.push(
      {
        queue: "runner.models.refresh",
        everyMs: 15_000,
        atStartup: true,
        run: async () => (await runnerReady)?.models.refresh(),
      },
      {
        queue: "runner.signin.refresh",
        everyMs: 15_000,
        atStartup: true,
        run: async () => (await runnerReady)?.health.refresh(),
      },
    );
  let runnerStopping = false;
  let retroDispatcher: RetroDispatcher | undefined;
  const retroCatalog = (q: Q, principal: { workspaceId: string; userId: string }) =>
    runner ? runner.models.readSteps(q, principal) : syncSteps(() => null);
  const retroScheduler = createRetroScheduler({
    store,
    artifactRoot: join(paths.home, "retros"),
    catalogs: retroCatalog,
  });
  const runnerHostRefusals = createRunnerHostRefusals();
  const runnerReady =
    runnerConfig === null
      ? Promise.resolve(undefined)
      : openRunnerCoordinator({
          db,
          hostWarnings: runnerHostRefusals.lines,
          discoverModels: false,
          checkSignIn: false,
          root: runnerConfig.root,
          hostname: runnerConfig.hostname,
          port: runnerConfig.port,
          tls: tls!,
          repositoryAccess,
          transcripts: transcriptObjects && {
            objects: transcriptObjects,
            key: loadRunnerTranscriptKey(join(paths.secretsDir, RUNNER_TRANSCRIPT_KEY_FILE)),
          },
          runnerFiles: runnerFileObjects(),
          eventKey: loadRunnerEventKey(join(paths.secretsDir, RUNNER_EVENT_KEY_FILE)),
          agentSessions: placeOnRunner
            ? {
                objects: agentSessionObjects(),
                key: loadAgentSessionKey(join(paths.secretsDir, AGENT_SESSION_KEY_FILE)),
              }
            : undefined,
          skillsRoot: paths.skillsDir,
          publicUrl: runtime.publicUrl,
          repositories: catalogRepositories,
          onError: () => console.error("Paws runner connection failed."),
          retros: () => retroDispatcher?.fetch,
        }).then(async (value) => {
          if (runnerStopping) {
            await value.stop();
            throw new Error("Runner control is stopping.");
          }
          runner = value;
          retroDispatcher = createRetroDispatcher({
            store,
            artifactRoot: join(paths.home, "retros"),
            sign: value.signRetroCommand,
          });
          return value;
        });
  if (runnerConfig !== null)
    void runnerReady.catch((caughtError1) => {
      journalCaught(caughtError1, "index.startPaws", null);
      return undefined;
    });
  const tailscaleAuthKey = tailscaleAuthKeyReader(paths.home);
  const memberVmExeDev = createExeDev({ readToken: exeDevToken });
  const MEMBER_VM_STOP_WAIT_MS = 15_000;
  const memberVmSize = () => loadConfigFile(paths.configFile).memberVm ?? {};
  const memberVmProvisioning = createMemberVmProvisioning({
    readToken: exeDevToken,
    tailscaleAuthKey,
    size: memberVmSize,
    ...(options?.memberVm
      ? { exeDev: options.memberVm.exeDev, bootstrap: options.memberVm.bootstrap }
      : {}),
    installer: () => {
      try {
        return readFileSync(new URL("../deploy/linux/install-runner.sh", import.meta.url), "utf8");
      } catch (caughtError3) {
        journalCaught(
          caughtError3,
          "index.installer.readFileSync",
          null,
          "optional file may be absent",
        );
        return null;
      }
    },
    publicUrl: runtime.publicUrl,
    repositories: catalogRepositories,
    latestRelease: () => latestRunnerRelease(),
    runnerControl: async () => {
      const coordinator = await runnerReady;
      if (!coordinator) return null;
      return {
        port: coordinator.port,
        serverVersion: coordinator.control.serverVersion(),
        mintEnrollment: async (member, input) =>
          coordinator.control.createEnrollment(
            {
              workspaceId: member.workspaceId,
              userId: member.userId,
              role:
                (await store.run((q) => workspaceMemberSteps(q, member.workspaceId, member.userId)))
                  ?.role ?? "member",
              authenticatedAt: Date.now(),
              teamIds: [],
            },
            input,
          ),
      };
    },
  });
  // A delegated parent runs each sub-issue in its own Linear session.
  const parents =
    workspace && linear?.tracker && linear.issueLifecycle
      ? createParentDelegations({
          store,
          tracker: linear.tracker,
          lifecycle: linear.issueLifecycle,
          ...(linear.startSession && runtime.publicUrl
            ? { startSession: linear.startSession }
            : {}),
          resumeSession: async (sessionId) => {
            const event = await linear.webhook.store.get(sessionCreatedKey(sessionId));
            if (!event || !linear.webhook.onEvent)
              throw new Error("Wait for Linear to refresh this sub-issue session.");
            if ((await linear.webhook.onEvent(event)) === false)
              throw new Error("Sub-issue session admission is awaiting access.");
          },
          origin: runtime.publicUrl ?? "http://127.0.0.1:8787",
        })
      : null;
  const placement = linear
    ? createRunnerPlacement({
        store,
        ...(parents ? { sessionActorSteps: parents.actorSteps } : {}),
      })
    : undefined;
  const placementBrowser = createRunnerPlacementBrowser({ store });
  const accountManagement = createAccountManagement();
  const sessionMovesStop = new AbortController();
  const memberVmHttp = createMemberVmHttp({
    store,
    available: createVmAvailable,
    size: memberVmSize,
    exeDev: options?.memberVm?.exeDev ?? memberVmExeDev,
  });
  const remote = placeOnRunner
    ? runnerReady.then((coordinator) => {
        if (!coordinator?.transcripts) throw new Error("Remote transcript storage is unavailable.");
        if (!placement) throw new Error("Remote execution requires current Linear ownership.");
        return {
          agents: createRemoteAgentRunner({
            store,
            ...coordinator,
            fetchCandidate: fetchRunnerCandidate,
            checkpointBot: repositoryAccess?.checkpointBot,
            placement,
            instanceId: instance.id,
          }),
          sessions: createRemoteSessionAgentRunner({
            store,
            helpers: coordinator.helpers,
            placement,
          }),
        };
      })
    : undefined;
  void remote?.catch((caughtError4) => {
    journalCaught(caughtError4, "index.startPaws", null);
  });
  const findingGrouping = linear?.findingIssues
    ? await createFindingGrouping({
        store,
        issues: linear.findingIssues,
        helper: createFindingGroupHelper({
          store,
          helpers: async () => {
            const coordinator = await runnerReady;
            if (!coordinator) throw new Error("A paired runner is required for finding grouping.");
            return coordinator.helpers;
          },
          profile: () => resolveAgentProfiles(loadConfigFile(paths.configFile)).implementer,
        }),
        sources: (workspaceId) => {
          if (!runtime.linearClientId) return [];
          return workspaceGroupingSources(store, workspaceId, runtime.linearClientId);
        },
      })
    : null;
  const remoteExecution: OrchestratorOptions["remoteExecution"] = remote
    ? {
        cancelItem: async (itemId) => {
          const backend = await remote;
          await backend.agents.cancelItem(itemId);
        },
        commandsGone: (q, itemId, since) => remoteCommandsGoneSteps(q, itemId, since),
        runInProgress: async (runId) => (await remote).agents.runInProgress(runId),
        slotFree: () =>
          store.run(function* (q) {
            const now = Date.now();
            for (const host of yield* enabledRunnerIdsSteps(q))
              if (yield* runnerHasCapacitySteps(q, host.id, now)) return true;
            return false;
          }),
        agentForItem: (itemId) => async (input) => {
          input.signal?.throwIfAborted();
          await ready;
          const backend = await remote;
          input.signal?.throwIfAborted();
          return backend.agents.forItem(itemId)(input);
        },
        agentForSession: (sessionId, purpose) => async (input) => {
          input.signal?.throwIfAborted();
          await ready;
          const backend = await remote;
          input.signal?.throwIfAborted();
          return backend.sessions.forSession(sessionId, purpose)(input);
        },
      }
    : unavailableRemoteExecution();
  // Move to another runner on the runner card: the runner hands the session over and the
  // failover in `forItem` resumes it on another eligible runner.
  const sessionMoves = remote
    ? createRunnerSessionMoves({
        store,
        signal: sessionMovesStop.signal,
        handOver: async (itemId, signal) => (await remote).agents.handOverItem(itemId, signal),
      })
    : undefined;
  async function stopRunner() {
    runnerStopping = true;
    sessionMovesStop.abort();
    await runnerReady.catch((caughtError5) => {
      journalCaught(caughtError5, "index.stopRunner", null);
    });
    await runner?.stop();
  }
  const ready = Promise.all([workspace?.access, runnerReady, remote]).then(() => {
    if (runnerStopping) throw new Error("Paws is stopping.");
  });
  void ready.catch((caughtError6) => {
    journalCaught(
      caughtError6,
      "index.startPaws.ready",
      null,
      runnerStopping &&
        caughtError6 instanceof Error &&
        caughtError6.message === "Paws is stopping."
        ? "shutdown interrupted startup"
        : undefined,
    );
  });
  let jobLoop: JobLoop | null = null;
  let server: Bun.Server<undefined>;
  try {
    server = startServer({
      server: options?.server,
      linearUsage: linear === null ? undefined : () => linear.usage(),
      riskApproval: async (itemId) => orchestrator?.riskDisplay(itemId) ?? null,
      riskSettingsChanged: () => orchestrator?.refreshRiskDisplaySettings(),
      onboarding: async (request, client) =>
        reconnectLinear &&
        !new URL(request.url).pathname.startsWith("/webhooks/") &&
        (await linearRevoked())
          ? reconnectLinear(request, client)
          : null,
      ...(linear?.findingIssues ? { findingGroups: { issues: linear.findingIssues } } : {}),
      hostname: env.host,
      retros: (() => {
        const settings = createRetroSettingsHttp({ store, catalog: retroCatalog });
        const schedule = createRetroScheduleHttp({
          store,
          scheduler: retroScheduler,
          catalog: retroCatalog,
        });
        const review = createRetroReviewHttp({ store, artifactRoot: join(paths.home, "retros") });
        const preview = createRetroPreviewHttp({ store, artifactRoot: join(paths.home, "retros") });
        return async (
          request: Request,
          principal: WorkspacePrincipal,
          sessionIds: readonly string[],
        ) =>
          (await settings(request, principal)) ??
          (await preview(request, principal, sessionIds)) ??
          (await review(request, principal, sessionIds)) ??
          schedule(request, principal);
      })(),
      blockerChecks: async (request, _principal, sessionIds) =>
        blockerChecks?.(request, sessionIds) ??
        Response.json({ error: "Blocker checks are starting." }, { status: 503 }),
      improvements: createImprovementsHttp({
        store,
        ...(linear?.improvementIssues ? { lookup: linear.improvementIssues } : {}),
        ...(linear?.improvementDelivery ? { linear: linear.improvementDelivery } : {}),
        ...(linear?.startSession ? { startSession: linear.startSession } : {}),
        dashboardUrl: dashboardUrl(runtime.publicUrl ?? "http://127.0.0.1:8787"),
        retroEvidence: function* (q, principal, sessionIds, retroId) {
          return (
            (yield* retroReaderAccessSteps(
              q,
              join(paths.home, "retros"),
              principal,
              sessionIds,
              retroId,
            ))?.readable ?? null
          );
        },
      }),
      executionControls: async (...args) =>
        executionControls?.handle(...args) ??
        Response.json({ error: "Execution controls are starting." }, { status: 503 }),
      ...(tls ? { tls } : {}),
      ...(workspace
        ? {
            workspaceAccess:
              runnerConfig === null
                ? workspace.access
                : Promise.all([workspace.access, runnerReady]).then(([access]) => access),
          }
        : {}),
      ...(runnerConfig === null
        ? {}
        : {
            runnerHostEnrollment: (request: Request) =>
              runner
                ? runner.hostEnrollment(request)
                : Promise.resolve(
                    Response.json({ error: "Runner control is starting." }, { status: 503 }),
                  ),
            runnerControl: async (
              request: Request,
              principal: WorkspacePrincipal,
              sessionIds: readonly string[],
            ) =>
              (await memberVmHttp(request, principal)) ??
              (await accountManagement(request, principal)) ??
              (await placementBrowser(request, principal)) ??
              (await sessionMoves?.fetch(request, principal)) ??
              (runner
                ? await runner.browser(request, principal, sessionIds)
                : Response.json({ error: "Runner control is starting." }, { status: 503 })),
          }),
      port: env.port,
      linearWebhookSecret: env.linearWebhookSecret,
      githubWebhookSecret: env.githubWebhookSecret,
      githubWebhook: {
        accept: (delivery) => acceptGitHubDelivery(store, delivery, Date.now(), commentFilter),
      },
      slackSigningSecret:
        envSource.SLACK_SIGNING_SECRET ?? readSlackApp(paths.home)?.signingSecret ?? null,
      linearWebhook: linear?.webhook ?? (webhooks ? { store: inbox } : undefined),
      webhooks: webhooks || env.githubWebhookSecret !== null,
      db,
      store,
      jobLoop: roleRunsJobs(runtime.role) ? () => jobLoop?.liveness() ?? null : undefined,
      instanceId: instance.id,
      healthDisk: { paths: { tmpdir: tmpdir(), pawsHome: paths.home } },
      statusEnv: envSource,
      closeoutHome: paths.home,
      evidenceDir: paths.evidenceDir,
      evidenceObjects,
      closeoutEvidence,
      visualReviewChanges: async (input) =>
        orchestrator ? orchestrator.requestVisualReviewChanges(input) : "rejected",
      linkAsks: (request, principal, sessionIds) =>
        handleLinkAskAnswer(request, {
          store,
          principal,
          sessionIds,
          submit: async (input) => (orchestrator ? orchestrator.decideLinkAsk(input) : "rejected"),
        }),
      questionAnswers: (request, principal, sessionIds) =>
        handleQuestionAnswer(request, {
          store,
          principal,
          sessionIds,
          submit: async (input) => (orchestrator ? orchestrator.answerFromPaws(input) : "rejected"),
        }),
      findingIssues: createFindingIssueRoute({
        db,
        reviews: (itemId) => itemReviews(store, itemId, paths.home, envSource),
        // Linear is called only when someone files an issue, never when the page loads.
        file: linear?.tracker?.fileFindingIssue
          ? (request, fileOptions) => linear.tracker!.fileFindingIssue!(request, fileOptions)
          : undefined,
      }),
      readLinearArtifact: createLinearArtifactReader({ store, secretsDir: paths.secretsDir }),
      ...(linear?.startSession ? { startLinearSession: linear.startSession } : {}),
      skillSettings: {
        root: paths.skillsDir,
        resolver: createSkillResolver(),
        updates: skillUpdates,
      },
      agentSettings: {
        applyToWaiting: async () => (await orchestrator?.applyAgentSettingsToWaiting()) ?? 0,
        runnerReadiness: (agent) => activeRunnerReadiness(store, agent),
        ...(linear?.tracker?.readBriefIssue
          ? {
              readIssue: (identifier: string, signal: AbortSignal) =>
                linear.tracker!.readBriefIssue!(identifier, { signal }),
            }
          : {}),
        configPath: paths.configFile,
        repos: repositories.map((value) => `${value.owner}/${value.repo}`),
        checkoutFacts: async (name: string) => {
          const [owner, repo] = name.split("/");
          if (!owner || !repo) return null;
          const mirror = await mirrorFiles({ owner, repo, pawsRoot: paths.home });
          if (!mirror) return null;
          const policy = policyCheckPaths(mirror.mirror, mirror.commit);
          return { files: mirror.files, checks: policy.ok ? policy.checks : [] };
        },
        highRiskFile: async (name: string) => {
          const [owner, repo] = name.split("/");
          if (!owner || !repo) return null;
          const mirror = await mirrorFiles({ owner, repo, pawsRoot: paths.home });
          if (!mirror) return null;
          return {
            commit: mirror.commit,
            paths: await highRiskPathsFileAt(
              (args) => git(["--git-dir", mirror.mirror, ...args]),
              mirror.commit,
            ),
          };
        },
        ...(linear?.tracker?.mergeChoices
          ? {
              mergeChoices: (signal: AbortSignal) => linear.tracker!.mergeChoices!({ signal }),
            }
          : {}),
        githubQueues: (signal: AbortSignal) =>
          repositoriesWithMergeQueue({
            repositories,
            client: createFetchGitHubClient(),
            signal,
            token: async (candidate) =>
              (await authProvider(runtime, candidate, "read", resolveApp)?.token()) ?? null,
          }),
        riskGate: riskGateOn(runtime.publicUrl)
          ? { on: true }
          : { on: false, reason: RISK_GATE_NEEDS_PUBLIC_URL },
        upToDateRules: (signal: AbortSignal) =>
          repositoriesRequiringUpToDate({
            repositories,
            client: createFetchGitHubClient(),
            signal,
            token: async (candidate) =>
              (await authProvider(runtime, candidate, "read", resolveApp)?.token()) ?? null,
          }),
      },
    });
  } catch (error) {
    abort.abort();
    releaseSettings();
    await store.run((q) => stopInstanceSteps(q, instance.id, Date.now()));
    if (runnerConfig !== null)
      void Promise.all([workspace?.stop(), stopRunner()]).then(() => db.close());
    else if (workspace === undefined) db.close();
    else void workspace.stop().then(() => db.close());
    throw error;
  }

  let running: LinearRunning = linear ? await linear.start() : down();
  if (linear)
    periodic.push({
      queue: "linear.catch-up",
      everyMs: POLL_INTERVAL_FAILING_MS,
      atStartup: true,
      startup: () => inbox.setCursor(POLL_DUE_CURSOR, 0),
      run: () => running.pollDue(),
    });

  const tracker = linear?.tracker ?? null;
  const managed = Boolean(workspace && linear?.tracker && linear.issueLifecycle);
  if (!managed) journal(LINEAR_WORKSPACE_REQUIRED);
  const admission = createAdmission({ db: store, workspace: managed });
  const enqueueMissingSnapshots = async () => {
    const targets = await store.run(missingSnapshotTargetsSteps);
    for (const target of targets)
      await enqueueJobOnce(store, {
        queue: "linear.item.reconcile",
        jobKey: `linear.item.reconcile:${target.itemId}`,
        payload: target,
        now: Date.now(),
      });
  };
  let commentAccess: Awaited<NonNullable<typeof workspace>["access"]> | null = null;
  void workspace?.access
    .then((access) => {
      commentAccess = access;
    })
    .catch((caughtError) => {
      journalCaught(caughtError, "index.commentAccess", null);
    });
  const improvementDelivery = linear?.improvementDelivery;
  if (improvementDelivery && workspace) {
    const access = workspace.access;
    startImprovementDeliveries({
      store,
      owner: `paws:${process.pid}:${crypto.randomUUID()}`,
      signal: abort.signal,
      linearFor: async (workspaceId) =>
        (await store.run((q) => getWorkspaceSteps(q, workspaceId)))?.organizationId ===
        (await access).organizationId
          ? improvementDelivery
          : null,
      sourceUrl: (improvementId) =>
        dashboardUrl(
          runtime.publicUrl ?? "http://127.0.0.1:8787",
          `/improvements/${encodeURIComponent(improvementId)}`,
        ),
    });
    startImprovementOutcomeSync({
      store,
      signal: abort.signal,
      linearFor: async (workspaceId) =>
        (await store.run((q) => getWorkspaceSteps(q, workspaceId)))?.organizationId ===
        (await access).organizationId
          ? improvementDelivery
          : null,
    });
  }
  const loops = await startLoops({
    db,
    store,
    instanceId: instance.id,
    role: runtime.role,
    signal: abort.signal,
    async prepare(created) {
      // A crashed instance's runs move to a live one without waiting for a restart.
      created.jobs.register(RUN_TAKEOVER_JOB, async () => {
        const wake = { armed: false };
        const now = Date.now();
        await store.transaction((q) => takeOverGoneRunsSteps(q, instance.id, now, wake));
        if (wake.armed) emitJobReady(store);
      });
      await enqueueJobOnce(store, {
        queue: RUN_TAKEOVER_JOB,
        jobKey: RUN_TAKEOVER_JOB,
        recurringEveryMs: RUN_TAKEOVER_MS,
        now: Date.now(),
      });
      void assignments
        ?.register(created.jobs)
        .catch((error: unknown) => journalCaught(error, "index.startPaws.assignments", null));
      void parents
        ?.register(created.jobs)
        .catch((error: unknown) => journalCaught(error, "index.startPaws.parents", null));
      registerMemberVmJob(created.jobs, {
        provision: memberVmProvisioning,
        secrets: () => [exeDevToken(), tailscaleAuthKey()],
        ...(options?.memberVm?.pollMs === undefined ? {} : { pollMs: options.memberVm.pollMs }),
      });
      registerMemberVmDeleteJob(created.jobs, {
        exeDev: options?.memberVm?.exeDev ?? memberVmExeDev,
        stopTask: async (itemId) => {
          if (orchestrator === null) throw new Error("Paws is still starting. Retry the delete.");
          await submitCommand(store, orchestrator.bus, {
            type: "stop",
            source: "dashboard",
            itemId,
            requestedAt: Date.now(),
          });
          await Promise.race([
            orchestrator.interruptItem(itemId).catch((caughtError7) => {
              journalCaught(caughtError7, "index.stopTask.interruptItem", itemId);
            }),
            Bun.sleep(MEMBER_VM_STOP_WAIT_MS),
          ]);
        },
        disconnect: () =>
          void runnerReady
            .then((coordinator) => coordinator?.control.expireConnections())
            .catch((caughtError8) => {
              journalCaught(caughtError8, "index.disconnect.then", null);
            }),
        secrets: () => [exeDevToken(), tailscaleAuthKey()],
      });
      const attached = attachOrchestrator({
        store,
        instanceId: instance.id,
        jobs: created.jobs,
        outbox: created.outbox,
        pawsRoot: paths.home,
        closeoutPolicyRoot: ({ owner, repo }) =>
          closeoutPolicyRoot(runtime.file, paths.home, `${owner}/${repo}`),
        tracker,
        linearTaskModes: true,
        remoteExecution,
        ...(placeOnRunner
          ? {
              remoteFollowUp: async (itemId: string, body: string) =>
                (await runnerReady)?.results.deliverFollowUp(itemId, body) ?? false,
              conversations: async () => {
                const coordinator = await runnerReady;
                return coordinator
                  ? createConversationTurns({ store, helpers: coordinator.helpers })
                  : null;
              },
              ownerHasRunner: (q: Q, itemId: string, agent: string, now: number) =>
                itemOwnerHasEligibleRunnerSteps(q, { itemId, agent, now }),
              itemRunners: (
                q: Q,
                itemId: string,
                profile: { agent: string; model?: string | null },
                now: number,
              ) => itemRunnerVerdictsSteps(q, store, { itemId, ...profile, now }),
              onRunnerHostRefusals: runnerHostRefusals.report,
              runnerSetupNeed: (itemId: string, agent: string, now: number) =>
                store.run((q) => itemOwnerRunnerSetupNeedSteps(q, { itemId, agent, now })),
              eligibleRunner: (itemId: string, agent: string, now: number) =>
                store.run((q) => itemOwnerEligibleRunnerSteps(q, { itemId, agent, now })),
              repositoryRefusals: (itemId: string, now: number) =>
                store.run((q) => itemRepositoryRefusalsSteps(q, { itemId, now })),
              repositoryAllowedOn: (itemId: string, runnerId: string, now: number) =>
                store.run((q) => itemRepositoryAllowedOnSteps(q, { itemId, runnerId, now })),
              runnerRebase: async (
                item: WorkItemRecord,
                heads: { head: string; main: string },
                signal: AbortSignal,
              ) => {
                const now = Date.now();
                const target = await store.run((q) =>
                  itemRepositoryRunnerSteps(q, { itemId: item.id, now }),
                );
                const repository = await store.run((q) => getWorkItemRepositorySteps(q, item.id));
                if (!target || !repository)
                  return { outcome: "failed" as const, reason: "no eligible runner" };
                const name = `${repository.owner}/${repository.repo}`;
                const bot = await repositoryAccess?.checkpointBot?.(name);
                if (!bot) return { outcome: "failed" as const, reason: "no GitHub App bot" };
                const title = rebaseCommitTitle(
                  (await store.run((q) => getPullRequestDraftSteps(q, item.id)))?.title ??
                    item.title,
                );
                return rebaseOnRunner(
                  store,
                  {
                    runnerId: target.id,
                    workspaceId: target.workspaceId,
                    itemId: item.id,
                    repository: {
                      owner: repository.owner,
                      repo: repository.repo,
                      remoteUrl: repository.remoteUrl,
                    },
                    branch: item.branchName,
                    head: heads.head,
                    main: heads.main,
                    bot,
                    ...(title ? { title } : {}),
                    now,
                  },
                  signal,
                );
              },
            }
          : {}),
        linearAccess: linearTaskAccess ?? undefined,
        admission,
        journal,
        runnersUrl: dashboardUrl(runtime.publicUrl ?? "http://127.0.0.1:8787", "/runners"),
        publicUrl: runtime.publicUrl,
        authorizeLinearIntake: function* (q, sessionId, spec) {
          return (
            (!parents || (yield* parents.authorizeIntakeSteps(q, sessionId, spec))) &&
            (!workspace ||
              !assignments ||
              (yield* assignments.authorizeIntakeSteps(q, sessionId, spec)))
          );
        },
        ...(parents
          ? {
              linearIntakeScope: parents.scopeSteps,
              linearIntakeActor: parents.actorSteps,
              onLinearIntake: parents.acceptedSteps,
              adoptLinearParent: parents.adoptParentSteps,
            }
          : {}),
        authorizeLinearEvent: async (event) => {
          if (!workspace) return ACCEPTED;
          if (!(await (await workspace.access).authorizeLinearEvent(event))) return MEMBERS_ONLY;
          return (
            (await parents?.authorizeEvent(event)) ??
            (assignments ? assignments.authorize(event) : ACCEPTED)
          );
        },
        linearComments: {
          appUserId: runtime.linearViewerId,
          get agents() {
            return loadConfigFile(paths.configFile).linearCommentAgents ?? [];
          },
          ...(workspace
            ? {
                authorize: async (actor: { id: string; teamId: string | null }) => {
                  commentAccess = await workspace!.access;
                  return commentAccess.authorizeLinearCommentActor(actor);
                },
                recheck: (q: Q, actor: { id: string; teamId: string | null }) =>
                  commentAccess?.recheckLinearCommentActorSteps(q, actor) ?? syncSteps(() => null),
              }
            : {}),
        },
        recheckLinearEvent: async (event) =>
          workspace
            ? (await (await workspace.access).recheckLinearEvent(event)) &&
              ((await parents?.recheckEvent(event)) ?? (await assignments?.recheck(event)) ?? true)
            : true,
        scheduling: async () => {
          await enqueueMissingSnapshots();
          return { ownerCap: ownerCap(paths.configFile) };
        },
        publicationReady: (
          ...args: Parameters<NonNullable<OrchestratorOptions["publicationReady"]>>
        ) => Promise.resolve(publication?.publicationReady(...args) ?? false),
        githubInstallation: createGitHubIntegration({
          runtime,
          env: envSource,
          resolveApp,
          repositoryForItem: (item) =>
            store.run(function* (q) {
              const bound = yield* getWorkItemRepositorySteps(q, item.id);
              if (bound) return bound;
              const answer = yield* getWorkItemRepositoryAnswerSteps(q, item.id);
              const selected =
                (yield* getWorkItemRepositoryChoiceSteps(q, item.id)) ??
                (answer ? repositoryAnswer(answer.answer, answer.candidates) : null);
              const configured = yield* listRepositoryCandidatesSteps(
                q,
                item.sessionKey,
                repositories,
              );
              return selected
                ? (configured.find(
                    (candidate) =>
                      candidate.owner === selected.owner &&
                      candidate.repo === selected.repo &&
                      candidate.remoteUrl === selected.remoteUrl,
                  ) ?? null)
                : configured.length === 1
                  ? configured[0]!
                  : null;
            }),
          accessForItem: (item) =>
            store.run(function* (q) {
              return (yield* getTaskModeSteps(q, item.id)) !== "code" &&
                (yield* taskRequiresRepositorySteps(q, item.id))
                ? "read"
                : "write";
            }),
          authorizeItem: async (item, signal, selectedRepository) => {
            const deny = <T>(result: T): T => {
              members?.forget();
              return result;
            };
            if (linearTaskAccess && !(await authorizeLinearTask(linearTaskAccess, item, signal)))
              return deny(false);
            if (!workspace) return true;
            const sessionKey = item.sessionKey;
            const session = sessionKey
              ? await store.run((q) => getLinearSessionInstallationSteps(q, sessionKey))
              : null;
            const organizationId = session?.organizationId;
            const currentWorkspace = organizationId
              ? await store.run((q) => workspaceForOrganizationSteps(q, organizationId))
              : null;
            const actorId = await store.run((q) => delegatedLinearUserIdSteps(q, item.id));
            if (!currentWorkspace || !actorId || !session?.teamId || !members) return deny(false);
            const member = await store.run((q) =>
              workspaceLinearMemberSteps(q, currentWorkspace.id, actorId),
            );
            const identity = await members
              .member(currentWorkspace.organizationId, actorId, signal)
              .catch((error: unknown) => {
                members?.forget();
                throw error;
              });
            const latest = await store.run((q) =>
              workspaceLinearMemberSteps(q, currentWorkspace.id, actorId),
            );
            const currentSession = sessionKey
              ? await store.run((q) => getLinearSessionInstallationSteps(q, sessionKey))
              : null;
            if (
              currentSession === null ||
              currentSession.organizationId !== session.organizationId ||
              currentSession.oauthClientId !== session.oauthClientId ||
              currentSession.appUserId !== session.appUserId ||
              currentSession.teamId !== session.teamId ||
              identity.organizationId !== currentWorkspace.organizationId ||
              identity.userId !== actorId
            )
              return deny(false);
            if (
              !canAct({ id: actorId, identity, member, teamId: session.teamId }, "github")
                .allowed ||
              !canAct({ id: actorId, identity, member: latest, teamId: session.teamId }, "github")
                .allowed
            )
              return deny(await store.run((q) => teamMemberDenialSteps(q, item)));
            const repositoryDenial = await teamRepositoryDenial(
              store,
              item,
              { workspaceId: currentWorkspace.id, teamId: session.teamId },
              selectedRepository,
            );
            return repositoryDenial ? deny(repositoryDenial) : true;
          },
          *currentIntegrationItem(q, item) {
            if (!workspace) return true;
            const session = item.sessionKey
              ? yield* getLinearSessionInstallationSteps(q, item.sessionKey)
              : null;
            const currentWorkspace = session?.organizationId
              ? yield* workspaceForOrganizationSteps(q, session.organizationId)
              : null;
            const actorId = yield* delegatedLinearUserIdSteps(q, item.id);
            if (!currentWorkspace || !actorId || !session?.teamId) return false;
            const member = yield* workspaceLinearMemberSteps(q, currentWorkspace.id, actorId);
            return (
              canAct({ id: actorId, member, teamId: session.teamId }, "github").allowed ||
              (yield* teamMemberDenialSteps(q, item))
            );
          },
          *integrationIdentity(q, item) {
            return JSON.stringify([
              yield* delegatedLinearUserIdSteps(q, item.id),
              (yield* getWorkItemRepositorySteps(q, item.id)) ??
                (yield* getWorkItemRepositoryChoiceSteps(q, item.id)),
              yield* latestCloseoutProgressMarkerSteps(q, item.id),
            ]);
          },
          *administratorsForItem(q, item) {
            const session = item.sessionKey
              ? yield* getLinearSessionSteps(q, item.sessionKey)
              : null;
            const currentWorkspace = session?.organizationId
              ? yield* workspaceForOrganizationSteps(q, session.organizationId)
              : null;
            if (!currentWorkspace) return [];
            const administrators: string[] = [];
            for (const member of yield* listWorkspaceMembersSteps(q, currentWorkspace.id)) {
              if (!workspaceMemberUsable(member) || !isWorkspaceAdmin(member.role)) continue;
              const linked = yield* workspaceUserLinearIdSteps(q, member.id);
              if (linked) administrators.push(linked);
            }
            return administrators;
          },
        }),
        commitPolicyForItem,
        files: linear?.files,
        secretsDir: paths.secretsDir,
        closeoutEvidenceObjects: evidenceObjects,
        evidence: runtime.publicUrl
          ? {
              publicUrl: runtime.publicUrl,
              root: paths.evidenceDir,
              objects: evidenceObjects,
              store: {
                save: (input) =>
                  createEvidenceStore({ store, root: paths.evidenceDir, objects: evidenceObjects })
                    .save(input)
                    .catch((error: unknown) => {
                      if (error instanceof EvidenceRejectedError)
                        throw new ArtifactRejectedError(error.message);
                      throw error;
                    }),
              },
            }
          : null,
        catchUp: async () => {
          await running.catchUp();
        },
        repositories,
        repositoryAccess: async (candidate, signal, access) => {
          const provider = authProvider(runtime, candidate, access, resolveApp);
          if (!provider) return false;
          return (access === "read" ? checkRepositoryReadAccess : checkRepositoryWriteAccess)({
            ...candidate,
            token: await provider.token(),
            app: provider.source === "app",
            signal,
          });
        },
        repositoryToken: async (_item, candidate, signal, access) => {
          signal.throwIfAborted();
          const provider = authProvider(runtime, candidate, access, resolveApp);
          if (!provider)
            throw new Error("The GitHub App installation does not cover this repository.");
          const token = await provider.token();
          signal.throwIfAborted();
          return token;
        },
        githubForRepository: (selected) =>
          githubBinding(authProvider(runtime, selected, "write", resolveApp)),
        caps: {
          maxAwakeMs: runtime.maxAwakeMs,
          limits: (projectId) =>
            resolveTimeLimits(loadConfigFile(paths.configFile), projectId, runtime.maxAwakeMs),
        },
      });
      orchestrator = attached;
      executionControls = createExecutionControls({
        db,
        bus: attached.bus,
        getPort: () => attached,
      });
      if (workspace && linear?.tracker && linear.issueLifecycle) {
        reconciler = createItemReconciler({
          store,
          tracker: linear.tracker,
          lifecycle: linear.issueLifecycle,
          ...(parents ? { scopeSnapshot: parents.scopeSnapshot } : {}),
          onChanges: function* (q, changes) {
            for (const { itemId, issue } of changes.issues)
              yield* saveSchedulingContextSteps(q, {
                itemId,
                ...("projectId" in issue ? { projectId: issue.projectId } : {}),
                ...("projectLeadId" in issue ? { projectLeadId: issue.projectLeadId } : {}),
                priority: issue.priority,
              });
            yield* attached.applyDelegationChangesSteps(q, changes);
          },
          afterChanges: (changes) => attached.finishDelegationChanges(changes),
        });
        publication = createPublicationReadiness({
          store,
          reconciler,
          canMerge: async (itemId) => (await admission.canMerge(itemId)).ok,
        });
        created.jobs.register("linear.redelegation", async (job) => {
          const lifecycle = linear?.issueLifecycle;
          const onEvent = linear?.webhook.onEvent;
          if (!lifecycle || !onEvent) return;
          await linearCaller("redelegation", () =>
            checkRedelegation(
              {
                db: store,
                store: inbox,
                appUserId: runtime.linearViewerId,
                inspect: (issueId) => lifecycle.inspect(issueId, { signal: abort.signal }),
                onEvent,
              },
              job.payload as { issueId: string; delegatedAtMs: number },
            ),
          );
        });
        created.jobs.register("linear.item.reconcile", async (job) => {
          const target = job.payload as { itemId: string; workspaceId: string };
          const item = await store.run((q) => getWorkItemSteps(q, target.itemId));
          const reconcile = () => reconciler?.reconcile({ ...target, signal: abort.signal });
          await linearCaller("item-reconcile", () =>
            item ? linearItem(item.linearIdentifier, reconcile, item.id) : reconcile(),
          );
          await attached.reconcileExecution();
        });
        created.jobs.register("linear.epics.reconcile", async () => {
          await linearCaller("epics-sweep", () => reconciler?.sweep({ signal: abort.signal }));
          await attached.reconcileExecution();
        });
        await enqueueJobOnce(store, {
          queue: "linear.epics.reconcile",
          jobKey: "linear.epics.reconcile",
          recurringEveryMs: 1_800_000,
          now: Date.now(),
        });
        const relations = createRelationsPolls({
          store,
          reconciler,
          lowBudget: async () =>
            linearBudgetIsLow((await linear?.usage())?.budget ?? null, Date.now()),
          reconcileExecution: () => attached.reconcileExecution(),
          read: (run) => linearCaller("relations-poll", run),
        });
        blockerChecks = createBlockerCheckRoute({
          store,
          polls: relations,
          blockedItemIds: reconciler.blockedItemIds,
          signal: abort.signal,
        });
        created.jobs.register("linear.relations.poll", async () => {
          await relations.all(abort.signal);
        });
        await enqueueJobOnce(store, {
          queue: "linear.relations.poll",
          jobKey: "linear.relations.poll",
          recurringEveryMs: RELATIONS_POLL_MS,
          now: Date.now(),
        });
        created.jobs.register("linear.relations.poll.blocked", async () => {
          await relations.blocked(abort.signal);
        });
        await enqueueJobOnce(store, {
          queue: "linear.relations.poll.blocked",
          jobKey: "linear.relations.poll.blocked",
          recurringEveryMs: BLOCKED_RELATIONS_POLL_MS,
          now: Date.now(),
        });
      }
      if (findingGrouping)
        await registerFindingGrouping(created.jobs, {
          groupingTime: runtime.file.findingsGroupingTime ?? "06:00",
          workspaces: () => listWorkspaceIds(sqliteDb(db)),
          run: (workspaceId, signal) =>
            findingGrouping.run(workspaceId, AbortSignal.any([signal, abort.signal])),
        });
      await registerScheduler(created.jobs, () => attached.reconcileExecution());
      // A conversation blocked on an unverified cleanup continues once its runner reports the
      // old command gone.
      created.jobs.register("conversation.block.release", () => attached.releaseCleanupBlocks());
      await enqueueJobOnce(store, {
        queue: "conversation.block.release",
        jobKey: "conversation.block.release",
        recurringEveryMs: 30_000,
        now: Date.now(),
      });
      const readIssueClosures = tracker?.readIssueClosures?.bind(tracker);
      if (readIssueClosures) {
        const sweepFailed = (signal: AbortSignal) =>
          sweepFailedIssues(store, {
            readIssueClosures,
            signal: AbortSignal.any([signal, abort.signal]),
            notify: (command) => attached.bus.emit(command),
            interrupt: (sessionId) => attached.interruptLinearSession(sessionId),
          });
        created.jobs.register(FAILED_ISSUE_SWEEP_JOB, async (_job, context) => {
          await sweepFailed(context.signal);
        });
        const sweep = await enqueueJobOnce(store, {
          queue: FAILED_ISSUE_SWEEP_JOB,
          jobKey: FAILED_ISSUE_SWEEP_JOB,
          recurringEveryMs: FAILED_ISSUE_SWEEP_MS,
          now: Date.now(),
        });
        if (
          roleRunsJobs(runtime.role) &&
          !(await store.run((q) => jobInstanceElsewhereSteps(q, instance.id, Date.now())))
        )
          await store.run((q) => runPendingJobNowSteps(q, sweep, Date.now()));
      }
      created.jobs.register(POLICY_BLOCK_CHECK_JOB, () => attached.checkPolicyBlocks());
      await enqueueJobOnce(store, {
        queue: POLICY_BLOCK_CHECK_JOB,
        jobKey: POLICY_BLOCK_CHECK_JOB,
        recurringEveryMs: POLICY_BLOCK_CHECK_MS,
        now: Date.now(),
      });
      created.jobs.register("closeout.stall", () => attached.recoverStalledCloseout());
      await enqueueJobOnce(store, {
        queue: "closeout.stall",
        jobKey: "closeout.stall",
        recurringEveryMs: 60_000,
        now: Date.now(),
      });
      created.jobs.register("worktree.sweep", (_job, context) =>
        attached.sweepWorktrees(context.signal),
      );
      await enqueueJobOnce(store, {
        queue: "worktree.sweep",
        jobKey: "worktree.sweep",
        recurringEveryMs: 3_600_000,
        now: Date.now(),
      });
      // Enqueued once by a migration; it seals transcript chunks stored before encryption. It is
      // registered without runner placement too, since an unhandled job is cancelled, not kept.
      created.jobs.register(RUNNER_TRANSCRIPT_ENCRYPT_JOB, (_job, context) =>
        encryptRunnerTranscripts({
          store,
          stores: (transcriptStorage ?? loadRunnerTranscriptStores(runtime.env.home)).stores,
          key: loadRunnerTranscriptKey(join(paths.secretsDir, RUNNER_TRANSCRIPT_KEY_FILE)),
          signal: AbortSignal.any([context.signal, abort.signal]),
        }).then(({ converted, skipped }) =>
          journal(
            `runner transcripts encrypted: ${converted} chunks sealed, ${skipped} unreadable`,
          ),
        ),
      );
      created.jobs.register(RUNNER_EVENT_ENCRYPT_JOB, (_job, context) =>
        encryptRunnerEvents({
          db,
          key: loadRunnerEventKey(join(paths.secretsDir, RUNNER_EVENT_KEY_FILE)),
          signal: AbortSignal.any([context.signal, abort.signal]),
        }).then(({ sealed }) => journal(`runner events encrypted: ${sealed} events sealed`)),
      );
      created.jobs.register(RUNNER_EVENT_PRUNE_JOB, (_job, context) =>
        pruneRunnerEvents({ store, signal: AbortSignal.any([context.signal, abort.signal]) }).then(
          ({ deleted }) => {
            if (!deleted) return;
            incrementalVacuum(db);
            journal(`runner events pruned: ${deleted} events deleted`);
          },
        ),
      );
      await enqueueJobOnce(store, {
        queue: RUNNER_EVENT_PRUNE_JOB,
        jobKey: RUNNER_EVENT_PRUNE_JOB,
        recurringEveryMs: RUNNER_EVENT_PRUNE_EVERY_MS,
        now: Date.now(),
      });
      // Enqueued once by a migration; it fills the Findings page from the review evidence of runs
      // Closeout accepted before the page stored findings.
      created.jobs.register(REVIEW_FINDINGS_BACKFILL_JOB, () =>
        backfillReviewFindings({ store, pawsRoot: paths.home }).then(({ runs, recorded, gone }) =>
          journal(
            `review findings backfilled: ${runs} accepted runs, ${recorded} findings, ${gone} gone`,
          ),
        ),
      );
      created.jobs.register(RETRO_SCHEDULE_JOB, async () => {
        await retroScheduler.tick();
      });
      await enqueueJobOnce(store, {
        queue: RETRO_SCHEDULE_JOB,
        jobKey: RETRO_SCHEDULE_JOB,
        recurringEveryMs: RETRO_SCHEDULE_TICK_MS,
        now: Date.now(),
      });
      created.jobs.register(RETRO_DISPATCH_JOB, async () => {
        await runnerReady;
        await retroDispatcher?.tick();
      });
      await enqueueJobOnce(store, {
        queue: RETRO_DISPATCH_JOB,
        jobKey: RETRO_DISPATCH_JOB,
        recurringEveryMs: RETRO_DISPATCH_TIMING.tickMs,
        now: Date.now(),
      });
      const alone = !(await store.run((q) =>
        jobInstanceElsewhereSteps(q, instance.id, Date.now()),
      ));
      for (const work of periodic) {
        created.jobs.register(work.queue, async (_job, context) => {
          await work.run(context.signal);
        });
        const id = await enqueueJobOnce(store, {
          queue: work.queue,
          jobKey: work.queue,
          recurringEveryMs: work.everyMs,
          runAt: work.atStartup ? undefined : Date.now() + work.everyMs,
          now: Date.now(),
        });
        if (work.atStartup && alone && roleRunsJobs(runtime.role)) {
          await work.startup?.();
          await store.run((q) => runPendingJobNowSteps(q, id, Date.now()));
        }
      }
      created.jobs.register("github.auth.recover", () => attached.recoverGitHubAuth());
      await enqueueJobOnce(store, {
        queue: "github.auth.recover",
        jobKey: "github.auth.recover",
        recurringEveryMs: 30_000,
        priority: 0,
        now: Date.now(),
      });
    },
  });
  jobLoop = loops.jobs;

  const lagTimer = setInterval(
    createLagWatchdog({
      recover: (lag, startedAt) => recoverRunnerWorkStall(store, startedAt, lag),
    }),
    1000,
  );
  lagTimer.unref();
  abort.signal.addEventListener("abort", () => clearInterval(lagTimer), { once: true });
  const host = startHost({
    store,
    clock: options?.hostClock,
    signal: abort.signal,
    stopAgent: (itemId) => {
      void orchestrator?.stopAgent(itemId).catch((caughtError9) => {
        journalCaught(caughtError9, "index.stopAgent", itemId);
        return undefined;
      });
    },
  });

  const instanceTimer = setInterval(() => {
    const now = Date.now();
    void store
      .run((q) => heartbeatInstanceSteps(q, instance.id, now))
      .catch((error: unknown) => journalCaught(error, "index.startPaws.heartbeatInstance", null));
  }, INSTANCE_HEARTBEAT_MS);
  instanceTimer.unref?.();
  const commandTimer = setInterval(() => {
    orchestrator
      ?.deliverInstanceCommands()
      .catch((error: unknown) =>
        journalCaught(error, "index.startPaws.deliverInstanceCommands", null),
      );
  }, COMMAND_DELIVERY_MS);
  commandTimer.unref?.();

  let stopping: Promise<void> | undefined;
  return {
    env,
    paths,
    db,
    store,
    server,
    ready,
    catchUp: async () => {
      await running.catchUp();
    },
    stop() {
      stopping ??= stopPawsComponents({
        groups: [
          [
            {
              name: "abort",
              stop: () => {
                runnerStopping = true;
                abort.abort();
              },
            },
            { name: "host", stop: () => host.stop() },
          ],
          [
            { name: "Linear", stop: () => running.stop() },
            { name: "server", stop: () => server.stop(true) },
            { name: "reconciler", stop: () => reconciler?.close() },
            { name: "orchestrator", stop: () => orchestrator?.shutdown() },
          ],
          [{ name: "job and outbox loops", stop: () => loops.stop() }],
          [{ name: "workspace", stop: () => workspace?.stop() }],
          [{ name: "runner", stop: stopRunner }],
        ],
        flush: () =>
          prepareShutdown(
            store,
            Date.now(),
            async (item) => {
              const policy = await store.run((q) => getItemRunCommitPolicySteps(q, item.id));
              if (policy)
                commitCheckpointSync(
                  worktreePath(paths.home, itemPathId(item)),
                  "wip: shutdown",
                  undefined,
                  policy,
                );
            },
            instance.id,
          ),
        close: async () => {
          releaseSettings();
          clearInterval(instanceTimer);
          clearInterval(commandTimer);
          try {
            await store.run((q) => stopInstanceSteps(q, instance.id, Date.now()));
          } finally {
            db.close();
          }
        },
      });
      return stopping;
    },
  };
}

function installedPawsVersion(): string | null {
  try {
    const release = releaseVersionFromPath(realpathSync(import.meta.dir));
    if (release !== null) return release;
    const head = Bun.spawnSync(["git", "-C", import.meta.dir, "rev-parse", "--short=12", "HEAD"], {
      stdout: "pipe",
      stderr: "ignore",
    });
    const revision = head.exitCode === 0 ? head.stdout.toString().trim() : "";
    return revision === "" ? null : `git:${revision}`;
  } catch (error) {
    journalCaught(error, "index.installedPawsVersion", null);
    return null;
  }
}

export function unavailableRemoteExecution(): NonNullable<OrchestratorOptions["remoteExecution"]> {
  const required = () => Promise.reject(new Error("A remote runner is required."));
  return {
    cancelItem: async () => {},
    agentForSession: () => required,
    agentForItem: () => required,
  };
}

/**
 * What keeps a pull request comment from the agent: the Paws App's own comments and the
 * repository's ignored bots. The App's bot login is read once per repository in the background,
 * so its comments are known by `performed_via_github_app` until then.
 */
function pullCommentFilter(
  runtime: RuntimeConfig,
  configFile: string,
  resolveApp: (repository: string) => Promise<ActiveGitHubApp>,
): PullCommentFilter {
  const logins = new Map<string, string | null>();
  return {
    async appId(repository) {
      try {
        return (await resolveApp(repository)).appId;
      } catch {
        return runtime.env.githubAppId;
      }
    },
    appLogin(repository) {
      const key = repository.toLowerCase();
      if (!logins.has(key)) {
        logins.set(key, null);
        const binding = repositoryBinding(repository);
        const provider = binding ? authProvider(runtime, binding, "read", resolveApp) : null;
        provider
          ?.botIdentity?.()
          .then((identity) => logins.set(key, identity.login))
          .catch(() => logins.delete(key));
      }
      return logins.get(key) ?? null;
    },
    ignoredBots(repository) {
      try {
        return ignoredCommentBots(readMergeSettings(loadConfigFile(configFile)), repository);
      } catch {
        return DEFAULT_IGNORED_COMMENT_BOTS.map((login) => login.toLowerCase());
      }
    },
    ignoredMarkers(repository) {
      try {
        return ignoredCommentMarkers(readMergeSettings(loadConfigFile(configFile)), repository);
      } catch (error) {
        journalCaught(error, "index.commentFilter.ignoredMarkers", null);
        return [];
      }
    },
    // Read on every delivery, so a change under Settings › Merging applies to the next comment.
    commentWait() {
      let wait = DEFAULT_COMMENT_WAIT;
      try {
        wait = readMergeSettings(loadConfigFile(configFile)).commentWait;
      } catch (error) {
        journalCaught(error, "index.commentFilter.commentWait", null);
        // A config.toml that does not parse keeps the defaults.
      }
      return { quietMs: wait.quietSeconds * 1000, maxMs: wait.maxWaitSeconds * 1000 };
    },
  };
}

function ownerCap(configFile: string): number | null {
  try {
    return readQueueSettings(loadConfigFile(configFile)).maxRunningPerOwner;
  } catch (caughtError11) {
    journalCaught(caughtError11, "index.ownerCap.readQueueSettings", null);
    return null;
  }
}

function down(): LinearRunning {
  return {
    catchUp: async () => undefined,
    pollDue: async () => undefined,
    stop: async () => undefined,
  };
}

function repositoryBinding(value: string | null): RepositoryBinding | null {
  if (value === null) return null;
  const slash = value.indexOf("/");
  if (slash <= 0 || slash !== value.lastIndexOf("/")) return null;
  const owner = value.slice(0, slash);
  const repo = value.slice(slash + 1);
  try {
    return { owner, repo, remoteUrl: githubHttpsUrl(owner, repo) };
  } catch (caughtError12) {
    journalCaught(caughtError12, "index.repositoryBinding.githubHttpsUrl", null);
    return null;
  }
}

function githubBinding(auth: AuthTokenProvider | null): GitHubBinding | null {
  if (auth === null) return null;
  return {
    appId: "",
    installationId: "",
    privateKeyPem: "",
    client: createFetchGitHubClient(),
    tokenProvider: gitHostToken(auth),
  };
}

export function runnerRepositoryAccess(
  runtime: RuntimeConfig,
  resolveApp?: (repository: string) => Promise<ActiveGitHubApp>,
): RunnerRepositoryAccessOptions | undefined {
  return cacheRepositoryCredentials({
    github: {
      async mintInstallationToken(input) {
        const before = await resolveApp?.(input.repository);
        if (!before || before.installationId !== input.installationId)
          throw new Error("GitHub integration unavailable.");
        const token = await createGitHubApp({
          client: createFetchGitHubClient(),
          appId: before.appId,
          privateKeyPem: before.privateKeyPem,
        }).mintInstallationToken(input);
        if (JSON.stringify(await resolveApp?.(input.repository)) !== JSON.stringify(before))
          throw new Error("GitHub integration replaced.");
        return token;
      },
    },
    installationForRepository: async (repository) => {
      try {
        return (await resolveApp?.(repository))?.installationId ?? null;
      } catch (caughtError13) {
        journalCaught(caughtError13, "index.installationForRepository.resolveApp", null);
        return null;
      }
    },
    revokeToken: (token) => revokeInstallationToken(createFetchGitHubClient(), token),
    async checkpointBot(repository) {
      const [owner, repo] = repository.split("/") as [string, string];
      const provider = authProvider(
        runtime,
        { owner, repo, remoteUrl: `https://github.com/${repository}.git` },
        "read",
        resolveApp,
      );
      if (!provider?.botIdentity) throw new Error("GitHub App bot authority is unavailable.");
      return provider.botIdentity();
    },
  });
}

export function authProvider(
  runtime: RuntimeConfig,
  repository: RepositoryBinding,
  access: "read" | "write" = "write",
  resolveApp?: (repository: string) => Promise<ActiveGitHubApp>,
): AuthTokenProvider | null {
  if (resolveApp) {
    const name = `${repository.owner}/${repository.repo}`;
    const provider = async () => {
      const active = await resolveApp(name);
      return {
        active,
        provider: createGitHubTokenProvider({
          auth: "app",
          repo: name,
          access,
          appId: active.appId,
          installationId: active.installationId,
          privateKeyPem: active.privateKeyPem,
        }),
      };
    };
    const perform = async <T>(operation: (current: AuthTokenProvider) => Promise<T>) => {
      const before = await provider();
      const result = await operation(before.provider);
      if (JSON.stringify(await resolveApp(name)) !== JSON.stringify(before.active))
        throw new Error("GitHub integration replaced.");
      return result;
    };
    return {
      source: "app",
      token: (purpose) => perform((current) => current.token(purpose)),
      user: () => perform((current) => current.user()),
      botIdentity: () => perform((current) => current.botIdentity!()),
    };
  }
  const env = runtime.env;
  let privateKeyPem: string | null = null;
  if (env.githubAppPrivateKeyPath !== null) {
    try {
      privateKeyPem = readSecretFile(env.githubAppPrivateKeyPath, false);
    } catch (caughtError14) {
      journalCaught(caughtError14, "index.authProvider.readSecretFile", null);
      return null;
    }
  }
  try {
    return createGitHubTokenProvider({
      access,
      repo: `${repository.owner}/${repository.repo}`,
      appId: env.githubAppId,
      installationId: env.githubAppInstallationId,
      privateKeyPem,
      client: createFetchGitHubClient(),
    });
  } catch (caughtError15) {
    journalCaught(caughtError15, "index.authProvider.createGitHubTokenProvider", null);
    return null;
  }
}

/**
 * The workspace GitHub App installation as the loop sees it: does the App cover the item's
 * repository with the access it needs, and may the delegating member still use it.
 */
export function createGitHubIntegration(input: {
  runtime: RuntimeConfig;
  env: EnvSource;
  resolveApp?: (repository: string) => Promise<ActiveGitHubApp>;
  repositoryForItem: (item: WorkItemRecord) => Promise<RepositoryBinding | null>;
  /** False, or a `GitHubDenial` with the reason the session ends with, cancels the item. */
  authorizeItem?: (
    item: WorkItemRecord,
    signal: AbortSignal,
    repository: RepositoryBinding,
  ) => Promise<boolean | GitHubDenial>;
  integrationIdentity: (q: Q, item: WorkItemRecord) => Steps<string>;
  currentIntegrationItem?: (q: Q, item: WorkItemRecord) => Steps<boolean | GitHubDenial>;
  administratorsForItem?: (q: Q, item: WorkItemRecord) => Steps<readonly string[]>;
  accessForItem?: (item: WorkItemRecord) => Promise<"read" | "write">;
}): GitHubIntegration {
  const installation = createGitHubInstallationCheck({
    home: input.runtime.env.home,
    env: input.env,
    ...(input.resolveApp ? { resolve: input.resolveApp } : {}),
  });
  return {
    recoveryUrl: dashboardUrl(
      input.runtime.publicUrl ?? "http://127.0.0.1:8787",
      "/settings/integrations",
    ),
    administrators: input.administratorsForItem ?? (() => syncSteps(() => [])),
    current: input.currentIntegrationItem ?? (() => syncSteps(() => true)),
    unavailableRetryMs: [2_000, 5_000, 10_000, 20_000, 30_000],
    identity: input.integrationIdentity,
    authorize: async (item: WorkItemRecord, signal: AbortSignal) => {
      const selected = await input.repositoryForItem(item);
      if (selected === null) return false;
      return input.authorizeItem ? input.authorizeItem(item, signal, selected) : true;
    },
    async check(item: WorkItemRecord, signal: AbortSignal) {
      const selected = await input.repositoryForItem(item);
      return (
        selected !== null &&
        (await installation(
          `${selected.owner}/${selected.repo}`,
          (await input.accessForItem?.(item)) ?? "write",
          signal,
        ))
      );
    },
  };
}

function linearEnv(runtime: RuntimeConfig, source: EnvSource): EnvSource {
  const next: EnvSource = { ...source };
  if (runtime.linearTeamId !== null) next.LINEAR_TEAM_ID = runtime.linearTeamId;
  else if (runtime.linearTeam !== null) next.LINEAR_TEAM = runtime.linearTeam;
  if (runtime.linearViewerId !== null) next.LINEAR_APP_USER_ID = runtime.linearViewerId;
  if (runtime.linearAccessToken !== null) next.LINEAR_ACCESS_TOKEN = runtime.linearAccessToken;
  if (runtime.linearRefreshToken !== null) next.LINEAR_REFRESH_TOKEN = runtime.linearRefreshToken;
  if (runtime.linearClientId !== null) next.LINEAR_CLIENT_ID = runtime.linearClientId;
  if (runtime.linearClientSecret !== null) next.LINEAR_CLIENT_SECRET = runtime.linearClientSecret;
  if (runtime.publicUrl !== null) next.PAWS_PUBLIC_URL = runtime.publicUrl;
  next.LINEAR_WEBHOOKS = runtime.webhooks ? "true" : "false";
  return next;
}

const CLI_HELP = `usage: paws

Commands:
  paws                          start Paws on 127.0.0.1:8787
  paws doctor                   check prerequisites, including the GitHub App
  paws db check                 connect to the database, apply migrations and report
  paws install                  set up the env file, config.toml and the user service
  paws install secrets          set the GitHub App, Linear, webhook and other secrets
  paws review-score [--since D] count review escapes, found after merge and after the PR
  paws login slack              connect Slack
  paws runner <command>         enroll and run a remote runner
  paws runner-authority init    create the runner command key
  paws public-tls validate      check the public HTTPS certificate
  paws probes collect <owner/repo>
                                draft Closeout probe rules into probes.proposed.yaml

GitHub access uses the GitHub App only. See docs/github-app.md.`;

async function doctorMain(): Promise<number> {
  const checks = doctorChecks(await realProbe(process.env));
  console.log(formatDoctor(checks));
  return checks.every((item) => item.ok) ? 0 : 1;
}

export async function dbCheckMain(
  source: EnvSource,
  connect: (url: string) => PostgresConnection = connectPostgres,
  print: (line: string) => void = console.log,
  fail: (line: string) => void = console.error,
): Promise<number> {
  const runtime = loadRuntime(source);
  if (runtime.configError !== null) {
    fail(`paws db check failed: ${runtime.configError}`);
    return 1;
  }
  const url = runtime.databaseUrl;
  if (url === null) {
    const path = pawsPaths(runtime.env.home).db;
    print("SQLite is in use: neither [database] url nor PAWS_DATABASE_URL is set.");
    try {
      const report = checkSqlite(path);
      print(
        report === null
          ? `ok · SQLite ${path} · no database yet; migrations apply at start`
          : `ok · SQLite ${path} · ${report.applied} of ${report.known} migrations applied`,
      );
      return 0;
    } catch (error) {
      fail(`paws db check failed on SQLite ${path}: ${(error as Error).message}`);
      return 1;
    }
  }
  const where = describeDatabaseUrl(url);
  let connection: PostgresConnection | null = null;
  try {
    connection = connect(url);
    const report = await checkPostgres(connection);
    print(
      `ok · Postgres ${where} · server ${report.serverVersion} · ${report.applied} of ${report.known} migrations applied`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(`paws db check failed on Postgres ${where}: ${redactDatabaseUrl(message, url)}`);
    return 1;
  } finally {
    await connection?.close().catch(() => undefined);
  }
}

/** `paws review-score [--since YYYY-MM-DD] [--escapes path]`: the independent reviewer's escapes. */
async function reviewScoreMain(args: string[]): Promise<number> {
  let since = 0;
  let escapesFile = REVIEW_ESCAPES_FILE;
  for (let index = 0; index < args.length; index += 2) {
    const value = args[index + 1];
    if (args[index] === "--since" && value && !Number.isNaN(Date.parse(value)))
      since = Date.parse(value);
    else if (args[index] === "--escapes" && value) escapesFile = value;
    else {
      console.error("usage: paws review-score [--since YYYY-MM-DD] [--escapes path]");
      return 1;
    }
  }
  const paths = pawsPaths(loadEnv(process.env).home);
  setAsideLegacyDatabase(paths.db, process.env);
  ensureLayout(paths);
  const db = openDatabase(paths.db);
  try {
    migrate(db);
    const escapes = await sqliteDb(db).run((q) => listReviewEscapesSteps(q, since));
    const score = scoreReview(escapes, readReviewEscapesFile(escapesFile));
    console.log(formatReviewScore(score));
    return 0;
  } finally {
    db.close();
  }
}

/** `paws probes collect`: the agent runs here, with the signed-in agent of whoever runs it. */
async function probesMain(argv: string[]): Promise<number> {
  let command: ProbesCommand;
  try {
    command = parseProbesArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 1;
  }
  const controller = new AbortController();
  process.once("SIGINT", () => controller.abort());
  try {
    const runtime = loadRuntime(process.env);
    const paths = pawsPaths(runtime.env.home);
    ensureLayout(paths);
    const repository = {
      owner: command.owner,
      repo: command.repo,
      remoteUrl: githubHttpsUrl(command.owner, command.repo),
    };
    // The App the running Paws uses: the workspace's, else the environment's.
    const db = existsSync(paths.db) ? openDatabase(paths.db) : null;
    if (db) process.once("exit", () => db.close());
    const appActivation = db
      ? createWorkspaceGitHubActivation(sqliteDb(db), runtime.env.home, process.env)
      : null;
    const provider = authProvider(
      runtime,
      repository,
      "read",
      appActivation ? (name) => appActivation.resolve(name) : undefined,
    );
    if (!provider) throw new Error("The GitHub App is not configured. Run `paws doctor`.");
    const print = (text: string) => console.log(text);
    await collectProbes({
      repository,
      pawsRoot: paths.home,
      since: command.since,
      dryRun: command.dryRun,
      out: command.out,
      github: { client: createFetchGitHubClient(), tokenProvider: gitHostToken(provider) },
      turn: runAgent,
      networkGit: createRepositoryGit({
        remoteUrl: repository.remoteUrl,
        token: () => provider.token(),
        signal: controller.signal,
        assert: async () => undefined,
        onCleanupFailure: () => undefined,
      }),
      findings: () =>
        readStoredFindings({
          home: paths.home,
          dbPath: paths.db,
          owner: command.owner,
          repo: command.repo,
        }),
      keep: keepCandidates(command.keep, print),
      print,
      signal: controller.signal,
    });
    return 0;
  } catch (error) {
    journalCaught(error, "paws probes collect failed.", null);
    return 1;
  }
}

export function useSavedSettings(): () => void {
  return useSavedSettingsReader((configPath) => {
    try {
      return readSavedSettings(join(dirname(configPath), "paws.db"));
    } catch (error) {
      journalCaught(error, "index.useSavedSettings", null);
      return null;
    }
  });
}

if (import.meta.main) {
  useSavedSettings();
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === "probes") process.exit(await probesMain(argv.slice(1)));
  if (command === "runner") process.exit(await runRunnerCli(argv.slice(1)));
  if (command === "runner-storage")
    process.exit(await runRunnerTranscriptStorageCli(argv.slice(1), loadEnv(process.env).home));
  if (command === "runner-authority") {
    try {
      if (argv.length !== 2 || argv[1] !== "init") throw new Error("Invalid command");
      const paths = pawsPaths(loadEnv(process.env).home);
      ensureLayout(paths);
      const keys = await initializeRunnerCoordinator(join(paths.secretsDir, "runner-identity"));
      console.log(`Runner authority initialized. Command key: ${keys[0].keyId}`);
      process.exit(0);
    } catch (caughtError2) {
      journalCaught(caughtError2, "Runner authority initialization failed.", null);

      process.exit(1);
    }
  }
  if (command === "public-tls") {
    try {
      if (argv.length !== 2 || argv[1] !== "validate") throw new Error("Invalid command");
      validatePublicTls(process.env);
      console.log("Public HTTPS certificate is valid.");
      process.exit(0);
    } catch (caughtError3) {
      journalCaught(caughtError3, "Public HTTPS certificate validation failed.", null);

      process.exit(1);
    }
  }
  if (command === "--help" || command === "-h" || command === "help") {
    console.log(CLI_HELP);
    process.exit(0);
  }
  if (command === "doctor") {
    process.exit(await doctorMain());
  }
  if (command === "db") {
    if (argv.length !== 2 || argv[1] !== "check") {
      console.error("usage: paws db check");
      process.exit(1);
    }
    process.exit(await dbCheckMain(process.env));
  }
  if (command === "install" && argv[1] === "secrets")
    process.exit(await runInstallCli(argv.slice(1), process.env));
  if (command === "install") process.exit(await installHostMain(argv.slice(1)));
  if (command === "review-score") process.exit(await reviewScoreMain(argv.slice(1)));
  if (command === "login" && argv[1] === "slack") {
    try {
      if (argv.length !== 2) throw new Error("usage: paws login slack");
      const runtime = loadRuntime(process.env);
      const paths = pawsPaths(runtime.env.home);
      setAsideLegacyDatabase(paths.db, process.env);
      ensureLayout(paths);
      const db = openDatabase(paths.db);
      migrate(db);
      await loginSlack({
        db,
        home: runtime.env.home,
        env: process.env,
        onAuthorize(url) {
          console.log(`Authorize Paws: ${url}`);
        },
      });
      console.log("Slack connected.");
      process.exit(0);
    } catch (error) {
      journalCaught(error, "Slack authorization failed.", null);

      process.exit(1);
    }
  }
  if (command === "login") {
    console.error("usage: paws login slack");
    process.exit(1);
  }
  const unknown = argv.find((arg) => arg !== "--no-tunnel");
  if (unknown) {
    console.error(`Unknown option ${unknown}.`);
    process.exit(1);
  }
  const starting = startPaws(process.env, {
    refreshRepositories: true,
    refreshAgentCatalog: true,
  });
  let exiting = false;
  const shutdown = (exitCode = 0) => {
    if (exiting) return;
    exiting = true;
    void starting.then(
      (started) => shutdownPaws(started, exitCode),
      () => undefined,
    );
  };
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  if (process.env.PAWS_PUBLIC_DASHBOARD === "1")
    process.on("SIGHUP", () => {
      if (exiting) return;
      try {
        validatePublicTls(process.env);
      } catch (caughtError4) {
        journalCaught(caughtError4, "public TLS certificate renewal rejected", null);

        return;
      }
      shutdown(PUBLIC_TLS_RESTART_EXIT);
    });
  const paws = await starting;
  try {
    await paws.ready;
  } catch (caughtError5) {
    // A signal during startup stops what `ready` waits on; that shutdown chooses the exit code.
    if (exiting) await new Promise<never>(() => {});
    exiting = true;
    journalCaught(caughtError5, "Paws startup failed.", null);
    await shutdownPaws(paws, 1);
    process.exit(1);
  }
  const origin = `${paws.server.protocol}://${paws.server.hostname}:${paws.server.port}`;
  // One write so a piped reader cannot observe the ready line before the dashboard line exists.
  console.log(`paws ready · ${origin}\ndashboard ${dashboardUrl(origin)}`);
}

/** One signed-in provider, shared by issues, comments, and git. */
export function gitHostToken(provider: AuthTokenProvider): GitHubTokenProvider {
  return {
    mode: provider.source,
    tokenFor: (purpose) => provider.token(purpose),
  };
}

function acceptedIssueChange(event: AcceptedLinearEvent): {
  issueId: string;
  organizationId: string;
  parentIssueId?: string | null;
  actorId: string | null;
} | null {
  let payload: unknown;
  try {
    payload = JSON.parse(event.payload);
  } catch (caughtError17) {
    journalCaught(caughtError17, "index.acceptedIssueChange.parse", null);
    return null;
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const value = payload as Record<string, unknown>;
  if (value["type"] !== "Issue" || typeof value["organizationId"] !== "string") return null;
  const data = value["data"];
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const issue = data as Record<string, unknown>;
  if (typeof issue["id"] !== "string" || !issue["id"].trim()) return null;
  const actor = value["actor"];
  const actorId =
    actor &&
    typeof actor === "object" &&
    !Array.isArray(actor) &&
    typeof (actor as Record<string, unknown>)["id"] === "string"
      ? (actor as { id: string }).id
      : null;
  return {
    issueId: issue["id"],
    organizationId: value["organizationId"],
    ...(typeof issue["parentId"] === "string" || issue["parentId"] === null
      ? { parentIssueId: issue["parentId"] }
      : {}),
    actorId,
  };
}
