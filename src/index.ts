import { startBrowserOnboarding } from "./onboarding-start";
import { createBrowserOnboarding } from "./onboarding";
import { runRunnerCli } from "./runner-cli";
import { join } from "node:path";
import { readFileSync } from "node:fs";
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
import { readSecretFile } from "./credentials";
import type { Database } from "bun:sqlite";
import {
  ArtifactRejectedError,
  commitCheckpointSync,
  restartFromFreshMain,
  worktreePath,
} from "./acp";
import { createEvidenceStore, EvidenceRejectedError } from "./evidence";
import {
  closeoutPolicyRoot,
  ensureLayout,
  LINEAR_COMMENT_MODE_REMOVED,
  LINEAR_WORKSPACE_REQUIRED,
  loadRuntime,
  loadEnv,
  loadConfigFile,
  loadRunnerControl,
  pawsPaths,
  readQueueSettings,
  type EnvSource,
  type PawsEnv,
  type PawsPaths,
  type RuntimeConfig,
} from "./config";
import {
  delegationHasOpenWork,
  type LinearCommand,
  type GitCommitPolicy,
  type AppBotIdentity,
  type Clock,
  policyCoauthors,
} from "./core";
import {
  assertLinearQueue,
  enqueueCommand,
  enqueueJobOnce,
  getLinearSession,
  getWorkItem,
  workItemForSession,
  getItemRunCommitPolicy,
  workspaceLinearMember,
  workspaceForOrganization,
  applyLinearUserChange,
  listWorkspaceMembers,
  listRepositoryCandidates,
  getLinearSessionInstallation,
  isLinearAppRevoked,
  journal,
  getLinearSessionAccess,
  delegatedLinearUserId,
  getWorkItemRepository,
  getWorkItemRepositoryChoice,
  getWorkItemRepositoryAnswer,
  getTaskMode,
  taskRequiresRepository,
  listWorkItems,
  clearUsagePauses,
  countLinearRequest,
  migrate,
  openDatabase,
  prepareShutdown,
  recoverOnStartup,
  listSkills,
  listRepositoryCatalog,
  refreshRepositoryCatalog,
  startLoops,
  submitCommand,
  type WorkItemRecord,
  runnerHasCapacity,
  applyLinearIssueProject,
  workspaceMember,
} from "./db";
import { doctorChecks, formatDoctor, realProbe } from "./doctor";
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
  githubHttpsUrl,
  type GitHubBinding,
  type GitHubTokenProvider,
} from "./github";
import { startHost } from "./host";
import {
  checkRedelegation,
  createInboxStore,
  REDELEGATION_CHECK_DELAY_MS,
  linearCaller,
  linearCallerFor,
  linearItem,
  openLinear,
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
  type LinearRunning,
} from "./linear";
import {
  acceptGitHubDelivery,
  attachOrchestrator,
  createLinearArtifactReader,
  itemPathId,
  repositoryAnswer,
  worktreeBranch,
  LinearTaskAccess,
  authorizeLinearTask,
  handleLinearAdministration,
  closeClosedIssueTasks,
  stopUndelegatedIssue,
  refreshLinearNotificationContext,
  type Orchestrator,
  type OrchestratorOptions,
  type RepositoryBinding,
  type GitHubDenial,
  type GitHubIntegration,
  teamMemberDenial,
  teamRepositoryDenial,
} from "./loop";
import {
  createItemReconciler,
  createParentDelegations,
  createPublicationReadiness,
} from "./intake";
import { createExecutionControls } from "./execution-controls";
import { createAdmission, registerScheduler, saveSchedulingContext } from "./scheduler";
import {
  createRunnerPlacement,
  createRunnerPlacementBrowser,
  itemOwnerEligibleRunner,
  itemOwnerHasEligibleRunner,
  itemOwnerRunnerSetupNeed,
} from "./runner-placement";
import { startServer } from "./server";
import { createSkillResolver, createSkillUpdates, SKILL_UPDATE_INTERVAL } from "./skills";
import { createAgentCatalog, createNpmRegistry } from "./agent-catalog";
import { loadPublicTls, validatePublicTls, PUBLIC_TLS_RESTART_EXIT } from "./deployment";
import {
  issueVerifiedWorkspaceBootstrap,
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
import { cacheRepositoryCredentials } from "./runner-repository-access";
import type { RunnerTranscriptObjects } from "./runner-transcripts";
import {
  loadRunnerTranscriptObjects,
  runRunnerTranscriptStorageCli,
} from "./runner-transcript-config";
import {
  createRemoteAgentRunner,
  createRemoteSessionAgentRunner,
  fetchRunnerCandidate,
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
  server: Bun.Server<undefined>;
  catchUp: () => Promise<void>;
  tunnelUp: () => boolean;
  tunnelRequested: boolean;
  tunnelUrl: string | null;
  ready: Promise<void>;
  stop: () => Promise<void>;
};

export type StartOptions = {
  server?: Bun.Server<undefined>;
  noTunnel?: boolean;
  hostClock?: Clock;
  commitPolicyForItem?: (item: WorkItemRecord) => Promise<GitCommitPolicy>;
  runnerRepositoryAccess?: RunnerRepositoryAccessOptions;
  runnerTranscriptObjects?: RunnerTranscriptObjects;
  refreshRepositories?: boolean;
  /** Read npm once a day for the coding agent version catalog. Off in tests. */
  refreshAgentCatalog?: boolean;
  /** Replaces the exe.dev client and VM bootstrap behind Create VM. Tests pass the fakes. */
  memberVm?: { exeDev: ExeDev; bootstrap: ExeDevBootstrap; pollMs?: number };
};

const LOOPBACK = "127.0.0.1";

/** Open ~/.paws, migrate, recover in-flight work, and listen on 127.0.0.1. */
export function startPaws(source?: EnvSource, options?: StartOptions): PawsProcess {
  const envSource = source ?? process.env;
  const execution = envSource.PAWS_EXECUTION;
  if (execution === "local") throw new Error("Paws places work on a remote runner.");
  if (execution !== undefined && execution !== "remote")
    throw new Error("PAWS_EXECUTION must be remote.");
  const runtime = loadRuntime(envSource);
  if (runtime.configError !== null) throw new Error(runtime.configError);
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
  const transcriptObjects =
    options?.runnerTranscriptObjects ??
    (placeOnRunner ? loadRunnerTranscriptObjects(runtime.env.home) : undefined);
  const env = { ...runtime.env, host: publicDashboard ? runtime.env.host : LOOPBACK };
  const paths = pawsPaths(env.home);
  assertLinearQueue(paths.db);
  ensureLayout(paths);
  const db = openDatabase(paths.db);
  migrate(db);
  clearUsagePauses(db);
  const linearRevoked = () =>
    isLinearAppRevoked(db, {
      oauthClientId: runtime.linearClientId,
      appUserId: runtime.linearViewerId,
    });
  if (
    publicDashboard &&
    (linearRevoked() ||
      (runtime.linearAccessToken === null &&
        readStoredToken(join(paths.secretsDir, "linear-oauth.json")) === null))
  ) {
    const reconnect = linearRevoked();
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
  const reconnectLinear = publicDashboard
    ? createBrowserOnboarding({
        db,
        home: paths.home,
        origin: runtime.publicUrl!,
        clientId: runtime.linearClientId,
        clientSecret: runtime.linearClientSecret,
        reconnect: true,
        installed() {},
      })
    : null;
  const appActivation = createWorkspaceGitHubActivation(db, runtime.env.home, envSource);
  const resolveApp = (repository: string) => appActivation.resolve(repository);
  repositoryAccess ??= runnerRepositoryAccess(runtime, resolveApp);
  recoverOnStartup(db);
  const abort = new AbortController();
  let orchestrator: Orchestrator | null = null;
  let reconciler: ReturnType<typeof createItemReconciler> | null = null;
  let publication: ReturnType<typeof createPublicationReadiness> | null = null;
  let executionControls: ReturnType<typeof createExecutionControls> | null = null;
  const repository = repositoryBinding(runtime.repo);
  const repositories = [runtime.repo, ...runtime.file.githubRepos]
    .map(repositoryBinding)
    .filter((value): value is RepositoryBinding => value !== null);
  const auth = repository === null ? null : authProvider(runtime, repository, "write", resolveApp);
  const github = githubBinding(auth);
  const listCatalog = async () => {
    const client = createFetchGitHubClient();
    const lists = await Promise.all(
      appActivation.installations().map((app) =>
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
  if (options?.refreshRepositories) {
    void refreshRepositoryCatalog(db, listCatalog);
    const catalogTimer = setInterval(() => void refreshRepositoryCatalog(db, listCatalog), 600_000);
    catalogTimer.unref?.();
    abort.signal.addEventListener("abort", () => clearInterval(catalogTimer));
  }
  if (options?.refreshAgentCatalog) {
    const agentCatalog = createAgentCatalog({ db, registry: createNpmRegistry() });
    const check = () => void agentCatalog.refreshIfDue(abort.signal).catch(() => {});
    check();
    // Hourly checks keep the daily read on schedule across sleep and restarts.
    const agentCatalogTimer = setInterval(check, 60 * 60 * 1000);
    agentCatalogTimer.unref?.();
    abort.signal.addEventListener("abort", () => clearInterval(agentCatalogTimer));
  }
  const skillUpdates = createSkillUpdates();
  const skillUpdateTimer = setInterval(
    () => void skillUpdates.check(listSkills(db)),
    SKILL_UPDATE_INTERVAL,
  );
  skillUpdateTimer.unref?.();
  abort.signal.addEventListener("abort", () => clearInterval(skillUpdateTimer));
  const webhooks = runtime.webhooks;
  const inbox = createInboxStore(db);

  const followUp = async (event: AcceptedLinearEvent): Promise<void | boolean> => {
    if (orchestrator === null) throw new Error("loop is not attached");
    const accepted = await orchestrator.onLinearEvent(event);
    const known = event.sessionId ? orchestrator.takeIntakeReads(event.sessionId) : undefined;
    if (accepted !== false && reconciler && event.sessionId) {
      const session = getLinearSession(db, event.sessionId);
      const linked = workItemForSession(db, event.sessionId);
      if (linked && session?.organizationId && session.stoppedAt === null) {
        const workspace = db
          .query<{ id: string }, [string, string]>(
            `SELECT w.id FROM workspace w WHERE w.linear_organization_id=? AND ${delegationHasOpenWork("?")}`,
          )
          .get(session.organizationId, linked.delegationId);
        if (workspace)
          await reconciler.reconcile({
            itemId: linked.id,
            workspaceId: workspace.id,
            signal: abort.signal,
            known: event.action === "created" ? known : undefined,
          });
        orchestrator.reconcileExecution();
      }
    }
    return accepted;
  };
  const submit = (command: LinearCommand): void => {
    if (orchestrator === null) {
      enqueueCommand(db, command);
      return;
    }
    submitCommand(db, orchestrator.bus, command);
  };

  let linearTaskAccess: LinearTaskAccess | null = null;
  const invalidateAuthorization = (scope: { sessionId?: string; issueId?: string } = {}): void => {
    linearTaskAccess?.invalidate(scope);
    orchestrator?.invalidateGitHubAuthorization(scope);
  };
  let workspace: ReturnType<typeof startWorkspaceAccess> | undefined;
  let assignments: ReturnType<typeof createWorkspaceAssignments> | undefined;
  let members: ReturnType<typeof cacheLinearMemberships> | null = null;
  const stopLinearSession = (sessionId: string): void => {
    for (const item of listWorkItems(db)) {
      if (item.sessionKey !== sessionId) continue;
      if (["cancelled", "completed", "merged"].includes(item.state)) continue;
      submit({ type: "cancel", source: "linear", itemId: item.id, requestedAt: Date.now() });
    }
  };
  const linear = openLinear({
    db,
    signal: abort.signal,
    countItemRequest: (itemId, caller) => countLinearRequest(db, itemId, caller),
    secretsDir: paths.secretsDir,
    isAuthorized: () =>
      !isLinearAppRevoked(db, {
        oauthClientId: runtime.linearClientId,
        appUserId: runtime.linearViewerId,
      }),
    beforeEvent: async (event, request) => {
      const userChange = parseLinearUserChange(event);
      if (userChange) {
        members?.forget();
        if (applyLinearUserChange(db, { ...userChange, now: Date.now() }))
          invalidateAuthorization();
        return false;
      }
      const issueEvent = acceptedIssueChange(event);
      if (issueEvent) invalidateAuthorization({ issueId: issueEvent.issueId });
      const projectChange = parseLinearIssueProjectChange(event);
      if (projectChange) applyLinearIssueProject(db, projectChange.issueId, projectChange.project);
      const undelegation = parseLinearUndelegation(event, runtime.linearViewerId);
      if (undelegation)
        await stopUndelegatedIssue(db, undelegation, {
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
        await closeClosedIssueTasks(db, closedIssue, {
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
        if (targets.length > 0) orchestrator?.reconcileExecution();
        return false;
      }
      if (
        await handleLinearAdministration(db, event, {
          oauthClientId: runtime.linearClientId,
          appUserId: runtime.linearViewerId,
          interrupt: async (sessionId) => {
            if (orchestrator === null) throw new Error("The loop is not attached.");
            await orchestrator.interruptLinearSession(sessionId);
          },
          revalidate: async (sessionIds) => {
            if (linearTaskAccess === null) throw new Error("Linear is not connected.");
            for (const sessionId of sessionIds) invalidateAuthorization({ sessionId });
            await linearTaskAccess.revalidateSessions(sessionIds);
          },
          reconcile: (notification) =>
            linearCaller("notifications", async () => {
              if (notification.action === "issueAssignedToYou") {
                inbox.setCursor(`delegated:${notification.issueId}`, notification.createdAtMs);
                enqueueJobOnce(db, {
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
              invalidateAuthorization({ issueId: notification.issueId });
              await linearTaskAccess.reconcile(notification.issueId);
              orchestrator?.reconcileExecution();
              await refreshLinearNotificationContext(db, linear?.tracker ?? null, notification);
            }),
          notify: (command) => {
            if (orchestrator === null) throw new Error("The loop is not attached.");
            orchestrator.bus.emit(command);
          },
        })
      ) {
        const administration = parseLinearAdministration(event);
        if (administration?.kind === "revoked" || administration?.kind === "teams")
          invalidateAuthorization();
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
      if (event.sessionId !== null && getLinearSessionAccess(db, event.sessionId) === "revoked")
        return false;
      if (linearTaskAccess === null) throw new Error("Linear is not connected.");
      return linearTaskAccess.accept(event, request);
    },
    env: linearEnv(runtime, envSource),
    publicUrl: runtime.publicUrl,
    noTunnel: !webhooks || options?.noTunnel === true,
    webhooks,
    followUp,
    progressReporter: (event) => {
      if (orchestrator === null) throw new Error("loop is not attached");
      return orchestrator.sessionProgressReporter(event);
    },
    submitCommand: submit,
  });

  if (linear !== null)
    linearTaskAccess = new LinearTaskAccess(db, {
      access: linear.access && linearCallerFor(linear.access, "task-access"),
      lifecycle: linear.issueLifecycle && linearCallerFor(linear.issueLifecycle, "task-access"),
      oauthClientId: runtime.linearClientId,
      appUserId: runtime.linearViewerId,
      stopSession: stopLinearSession,
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
      db.close();
      throw new Error("Public dashboard requires a connected Linear app installation.");
    }
    try {
      if (!linear.issueLifecycle || !linearTaskAccess || !linear.tracker)
        throw new Error("Public workspace assignments require verified Linear task access.");
      {
        assignments = createWorkspaceAssignments({
          db,
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
        assignments,
        onboardingReadiness: createOnboardingReadiness(db),
        createVmAvailable,
        githubAttributionClient: (() => {
          try {
            const { clientId, clientSecret } = appActivation.template();
            return { clientId, clientSecret };
          } catch {
            return undefined;
          }
        })(),
        slackIdentities: createSlackIdentityReads({ home: paths.home, db }),
        db,
        publicUrl: runtime.publicUrl!,
        clientId: runtime.linearClientId!,
        memberships: linear.memberships,
        verifyTeam: (id, signal) => linear.access!.team(id, { signal }),
        readTeams: (signal) => linear.access!.teams!({ signal }),
        onError: () => console.error("Paws workspace access refresh failed."),
      });
    } catch (error) {
      abort.abort();
      db.close();
      throw error;
    }
  }
  const commitPolicyForItem = async (
    item: WorkItemRecord,
    selected = getWorkItemRepository(db, item.id) ?? repository,
  ): Promise<GitCommitPolicy> => {
    if (!selected) throw new Error("Attribution repository is missing");
    const bot = await authProvider(runtime, selected, "read", resolveApp)?.botIdentity?.();
    if (!bot) throw new Error("Attribution App bot authority is unavailable");
    const policy = options?.commitPolicyForItem
      ? await options.commitPolicyForItem(item)
      : { bot, credit: delegatorCommitCredit(db, item.id) };
    if (
      bot.appId !== policy.bot.appId ||
      bot.id !== policy.bot.id ||
      bot.login !== policy.bot.login
    )
      throw new Error("Attribution App bot authority changed");
    return policy;
  };
  let runner: RunnerCoordinator | undefined;
  let runnerStopping = false;
  const runnerReady =
    runnerConfig === null
      ? Promise.resolve(undefined)
      : openRunnerCoordinator({
          db,
          discoverModels: true,
          checkSignIn: true,
          root: runnerConfig.root,
          hostname: runnerConfig.hostname,
          port: runnerConfig.port,
          tls: tls!,
          repositoryAccess,
          transcriptObjects,
          skillsRoot: paths.skillsDir,
          publicUrl: runtime.publicUrl,
          repositories: () =>
            listRepositoryCatalog(db).map((entry) => `${entry.owner}/${entry.repo}`),
          onError: () => console.error("Paws runner connection failed."),
        }).then(async (value) => {
          if (runnerStopping) {
            await value.stop();
            throw new Error("Runner control is stopping.");
          }
          runner = value;
          return value;
        });
  if (runnerConfig !== null)
    void runnerReady.catch(() => console.error("Paws runner startup failed."));
  const tailscaleAuthKey = tailscaleAuthKeyReader(paths.home);
  const memberVmExeDev = createExeDev({ readToken: exeDevToken });
  const MEMBER_VM_STOP_WAIT_MS = 15_000;
  const memberVmProvisioning = createMemberVmProvisioning({
    readToken: exeDevToken,
    tailscaleAuthKey,
    ...(options?.memberVm
      ? { exeDev: options.memberVm.exeDev, bootstrap: options.memberVm.bootstrap }
      : {}),
    installer: () => {
      try {
        return readFileSync(new URL("../deploy/linux/install-runner.sh", import.meta.url), "utf8");
      } catch {
        return null;
      }
    },
    publicUrl: runtime.publicUrl,
    repositories: () => listRepositoryCatalog(db).map((entry) => `${entry.owner}/${entry.repo}`),
    latestRelease: () => latestRunnerRelease(),
    runnerControl: async () => {
      const coordinator = await runnerReady;
      if (!coordinator) return null;
      return {
        port: coordinator.port,
        serverVersion: coordinator.control.serverVersion(),
        mintEnrollment: (member, input) =>
          coordinator.control.createEnrollment(
            {
              workspaceId: member.workspaceId,
              userId: member.userId,
              role: workspaceMember(db, member.workspaceId, member.userId)?.role ?? "member",
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
          db,
          tracker: linear.tracker,
          lifecycle: linear.issueLifecycle,
          ...(linear.startSession && runtime.publicUrl
            ? { startSession: linear.startSession }
            : {}),
          resumeSession: async (sessionId) => {
            const event = linear.webhook.store.get(sessionCreatedKey(sessionId));
            if (!event || !linear.webhook.onEvent)
              throw new Error("Wait for Linear to refresh this sub-issue session.");
            if ((await linear.webhook.onEvent(event)) === false)
              throw new Error("Sub-issue session admission is awaiting access.");
          },
          origin: runtime.publicUrl ?? "http://127.0.0.1:8787",
        })
      : null;
  const placement = linear
    ? createRunnerPlacement({ db, ...(parents ? { sessionActor: parents.actor } : {}) })
    : undefined;
  const placementBrowser = createRunnerPlacementBrowser({ db });
  const memberVmHttp = createMemberVmHttp({ db, available: createVmAvailable });
  const remote = placeOnRunner
    ? runnerReady.then((coordinator) => {
        if (!coordinator?.transcripts) throw new Error("Remote transcript storage is unavailable.");
        if (!placement) throw new Error("Remote execution requires current Linear ownership.");
        return {
          agents: createRemoteAgentRunner({
            db,
            ...coordinator,
            fetchCandidate: fetchRunnerCandidate,
            checkpointBot: repositoryAccess?.checkpointBot,
            placement,
          }),
          sessions: createRemoteSessionAgentRunner({
            db,
            helpers: coordinator.helpers,
            placement,
          }),
        };
      })
    : undefined;
  void remote?.catch(() => {});
  const remoteExecution: OrchestratorOptions["remoteExecution"] = remote
    ? {
        cancelItem: async (itemId) => {
          const backend = await remote;
          await backend.agents.cancelItem(itemId);
        },
        slotFree: () =>
          db
            .query<{ id: string }, []>(
              "SELECT id FROM runner WHERE status='active' AND revoked_at IS NULL",
            )
            .all()
            .some((host) => runnerHasCapacity(db, host.id, Date.now())),
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
  async function stopRunner() {
    runnerStopping = true;
    await runnerReady.catch(() => {});
    await runner?.stop();
  }
  const ready = Promise.all([workspace?.access, runnerReady, remote]).then(() => {
    if (runnerStopping) throw new Error("Paws is stopping.");
  });
  void ready.catch(() => {});
  let server: Bun.Server<undefined>;
  try {
    server = startServer({
      server: options?.server,
      linearUsage: linear === null ? undefined : () => linear.usage(),
      onboarding: async (request) =>
        reconnectLinear &&
        !new URL(request.url).pathname.startsWith("/webhooks/") &&
        linearRevoked()
          ? reconnectLinear(request)
          : null,
      hostname: env.host,
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
            runnerEnrollment: (request: Request) =>
              runner
                ? runner.enrollment(request)
                : Promise.resolve(
                    Response.json({ error: "Runner control is starting." }, { status: 503 }),
                  ),
            runnerHostEnrollment: (request: Request) =>
              runner
                ? runner.hostEnrollment(request)
                : Promise.resolve(
                    Response.json({ error: "Runner control is starting." }, { status: 503 }),
                  ),
            runnerControl: async (request: Request, principal: WorkspacePrincipal) =>
              (await memberVmHttp(request, principal)) ??
              (await placementBrowser(request, principal)) ??
              (runner
                ? await runner.browser(request, principal)
                : Response.json({ error: "Runner control is starting." }, { status: 503 })),
          }),
      port: env.port,
      linearWebhookSecret: env.linearWebhookSecret,
      githubWebhookSecret: env.githubWebhookSecret,
      githubWebhook: { accept: (delivery) => acceptGitHubDelivery(db, delivery, Date.now()) },
      slackSigningSecret:
        envSource.SLACK_SIGNING_SECRET ?? readSlackApp(paths.home)?.signingSecret ?? null,
      linearWebhook: linear?.webhook ?? (webhooks ? { store: inbox } : undefined),
      webhooks: webhooks || env.githubWebhookSecret !== null,
      db,
      statusEnv: envSource,
      closeoutHome: paths.home,
      evidenceDir: paths.evidenceDir,
      visualReviewChanges: async (input) =>
        orchestrator ? orchestrator.requestVisualReviewChanges(input) : "rejected",
      readLinearArtifact: createLinearArtifactReader({ db, secretsDir: paths.secretsDir }),
      ...(linear?.startSession ? { startLinearSession: linear.startSession } : {}),
      skillSettings: {
        root: paths.skillsDir,
        resolver: createSkillResolver(),
        updates: skillUpdates,
      },
      agentSettings: {
        configPath: paths.configFile,
        repos: repositories.map((value) => `${value.owner}/${value.repo}`),
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
    if (runnerConfig !== null)
      void Promise.all([workspace?.stop(), stopRunner()]).then(() => db.close());
    else if (workspace === undefined) db.close();
    else void workspace.stop().then(() => db.close());
    throw error;
  }

  let running: LinearRunning = linear ? linear.start(server.port ?? env.port) : down();

  const tracker = linear?.tracker ?? null;
  if (runtime.linearCommentMode) journal(LINEAR_COMMENT_MODE_REMOVED);
  const managed = Boolean(workspace && linear?.tracker && linear.issueLifecycle);
  if (!managed) journal(LINEAR_WORKSPACE_REQUIRED);
  const admission = createAdmission({ db, workspace: managed });
  const enqueueMissingSnapshots = () => {
    const targets = db
      .query<{ itemId: string; workspaceId: string }, []>(
        `SELECT picked.id AS itemId,w.id AS workspaceId FROM work_item picked
      JOIN linear_session s ON s.session_id=picked.session_key
      JOIN workspace w ON w.linear_organization_id=s.organization_id
      WHERE picked.id=(
        SELECT i.id FROM work_item i
        JOIN linear_session open_session ON open_session.session_id=i.session_key AND open_session.stopped_at IS NULL
        WHERE i.delegation_id=picked.delegation_id AND i.state NOT IN ('completed','merged','cancelled')
        AND NOT EXISTS(SELECT 1 FROM work_item_specification f WHERE f.item_id=i.id AND f.present=0)
        ORDER BY i.position,i.id LIMIT 1)
      AND ${delegationHasOpenWork("picked.delegation_id")} AND s.stopped_at IS NULL
      AND EXISTS(SELECT 1 FROM work_item gap WHERE gap.delegation_id=picked.delegation_id AND gap.state NOT IN ('completed','merged','cancelled')
        AND NOT EXISTS(SELECT 1 FROM work_item_specification f WHERE f.item_id=gap.id AND f.present=0)
        AND NOT EXISTS(SELECT 1 FROM item_dependency_snapshot p WHERE p.item_id=gap.id))`,
      )
      .all();
    for (const target of targets)
      enqueueJobOnce(db, {
        queue: "linear.item.reconcile",
        jobKey: `linear.item.reconcile:${target.itemId}`,
        payload: target,
        now: Date.now(),
      });
  };
  const loops = startLoops({
    db,
    signal: abort.signal,
    prepare(created) {
      assignments?.register(created.jobs);
      parents?.register(created.jobs);
      registerMemberVmJob(created.jobs, {
        provision: memberVmProvisioning,
        secrets: () => [exeDevToken(), tailscaleAuthKey()],
        ...(options?.memberVm?.pollMs === undefined ? {} : { pollMs: options.memberVm.pollMs }),
      });
      registerMemberVmDeleteJob(created.jobs, {
        exeDev: options?.memberVm?.exeDev ?? memberVmExeDev,
        stopTask: async (itemId) => {
          if (orchestrator === null) throw new Error("Paws is still starting. Retry the delete.");
          submitCommand(db, orchestrator.bus, {
            type: "stop",
            source: "dashboard",
            itemId,
            requestedAt: Date.now(),
          });
          await Promise.race([
            orchestrator.interruptItem(itemId).catch(() => {}),
            Bun.sleep(MEMBER_VM_STOP_WAIT_MS),
          ]);
        },
        disconnect: () =>
          void runnerReady
            .then((coordinator) => coordinator?.control.expireConnections())
            .catch(() => {}),
        secrets: () => [exeDevToken(), tailscaleAuthKey()],
      });
      const attached = attachOrchestrator({
        db,
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
              ownerHasRunner: (itemId: string, agent: string, now: number) =>
                itemOwnerHasEligibleRunner(db, { itemId, agent, now }),
              runnerSetupNeed: (itemId: string, agent: string, now: number) =>
                itemOwnerRunnerSetupNeed(db, { itemId, agent, now }),
              eligibleRunner: (itemId: string, agent: string, now: number) =>
                itemOwnerEligibleRunner(db, { itemId, agent, now }),
            }
          : {}),
        linearAccess: linearTaskAccess ?? undefined,
        admission,
        journal,
        runnersUrl: `${runtime.publicUrl ?? "http://127.0.0.1:8787"}/status/runners`,
        authorizeLinearIntake: (sessionId, spec) =>
          (parents?.authorizeIntake(sessionId, spec) ?? true) &&
          (!workspace || (assignments?.authorizeIntake(sessionId, spec) ?? true)),
        ...(parents
          ? {
              linearIntakeScope: parents.scope,
              linearIntakeActor: parents.actor,
              onLinearIntake: parents.accepted,
              adoptLinearParent: parents.adoptParent,
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
        recheckLinearEvent: async (event) =>
          workspace
            ? (await workspace.access).recheckLinearEvent(event) &&
              (parents?.recheckEvent(event) ?? assignments?.recheck(event) ?? true)
            : true,
        scheduling: () => {
          enqueueMissingSnapshots();
          return { defaultRepository: repository, ownerCap: ownerCap(paths.configFile) };
        },
        publicationReady: (
          ...args: Parameters<NonNullable<OrchestratorOptions["publicationReady"]>>
        ) => Promise.resolve(publication?.publicationReady(...args) ?? false),
        githubInstallation: createGitHubIntegration({
          runtime,
          env: envSource,
          resolveApp,
          repositoryForItem: (item) => {
            const bound = getWorkItemRepository(db, item.id);
            if (bound) return bound;
            const answer = getWorkItemRepositoryAnswer(db, item.id);
            const selected =
              getWorkItemRepositoryChoice(db, item.id) ??
              (answer ? repositoryAnswer(answer.answer, answer.candidates) : null);
            const configured = listRepositoryCandidates(db, item.sessionKey, repositories);
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
          },
          accessForItem: (item) =>
            getTaskMode(db, item.id) !== "code" && taskRequiresRepository(db, item.id)
              ? "read"
              : "write",
          actorForItem: (item) => delegatedLinearUserId(db, item.id),
          authorizeItem: async (item, signal, selectedRepository) => {
            if (linearTaskAccess && !(await authorizeLinearTask(linearTaskAccess, item, signal)))
              return false;
            if (!workspace) return true;
            const session = item.sessionKey
              ? getLinearSessionInstallation(db, item.sessionKey)
              : null;
            const currentWorkspace = session?.organizationId
              ? workspaceForOrganization(db, session.organizationId)
              : null;
            const actorId = delegatedLinearUserId(db, item.id);
            if (!currentWorkspace || !actorId || !session?.teamId || !members) return false;
            const member = workspaceLinearMember(db, currentWorkspace.id, actorId);
            const identity = await members.member(currentWorkspace.organizationId, actorId, signal);
            const latest = workspaceLinearMember(db, currentWorkspace.id, actorId);
            const currentSession = item.sessionKey
              ? getLinearSessionInstallation(db, item.sessionKey)
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
              return false;
            if (
              !identity.active ||
              identity.guest ||
              !identity.teamIds.includes(session.teamId) ||
              member === null ||
              !member.active ||
              member.role === "observer" ||
              !member.teamIds.includes(session.teamId) ||
              latest === null ||
              !latest.active ||
              latest.role === "observer" ||
              !latest.teamIds.includes(session.teamId)
            )
              return teamMemberDenial(db, item);
            return (
              teamRepositoryDenial(
                db,
                item,
                { workspaceId: currentWorkspace.id, teamId: session.teamId },
                selectedRepository,
              ) ?? true
            );
          },
          currentIntegrationItem: (item) => {
            if (!workspace) return true;
            const session = item.sessionKey
              ? getLinearSessionInstallation(db, item.sessionKey)
              : null;
            const currentWorkspace = session?.organizationId
              ? workspaceForOrganization(db, session.organizationId)
              : null;
            const actorId = delegatedLinearUserId(db, item.id);
            if (!currentWorkspace || !actorId || !session?.teamId) return false;
            const member = workspaceLinearMember(db, currentWorkspace.id, actorId);
            return (
              (member !== null &&
                member.active &&
                member.role !== "observer" &&
                member.teamIds.includes(session.teamId)) ||
              teamMemberDenial(db, item)
            );
          },
          integrationIdentity: (item) =>
            JSON.stringify([
              delegatedLinearUserId(db, item.id),
              getWorkItemRepository(db, item.id) ?? getWorkItemRepositoryChoice(db, item.id),
              db
                .query(
                  "SELECT id,head,base,policy_digest,decision FROM closeout_progress WHERE item_id=? ORDER BY updated_at DESC,id DESC LIMIT 1",
                )
                .get(item.id),
            ]),
          administratorsForItem: (item) => {
            const session = item.sessionKey ? getLinearSession(db, item.sessionKey) : null;
            const currentWorkspace = session?.organizationId
              ? workspaceForOrganization(db, session.organizationId)
              : null;
            if (!currentWorkspace) return [];
            return listWorkspaceMembers(db, currentWorkspace.id)
              .filter((member) => member.active && ["owner", "admin"].includes(member.role))
              .flatMap((member) => {
                const linked = db
                  .query<{ id: string }, [string]>(
                    "SELECT linear_user_id AS id FROM workspace_user WHERE id=?",
                  )
                  .get(member.id);
                return linked ? [linked.id] : [];
              });
          },
        }),
        commitPolicyForItem,
        files: linear?.files,
        secretsDir: paths.secretsDir,
        evidence: runtime.publicUrl
          ? {
              publicUrl: runtime.publicUrl,
              root: paths.evidenceDir,
              store: {
                save: (input) =>
                  createEvidenceStore({ db, root: paths.evidenceDir })
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
        repository,
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
        github,
        githubForRepository: (selected) =>
          githubBinding(authProvider(runtime, selected, "write", resolveApp)),
        caps: { maxTurns: runtime.maxTurns, maxAwakeMs: runtime.maxAwakeMs },
      });
      orchestrator = attached;
      executionControls = createExecutionControls({
        db,
        bus: attached.bus,
        getPort: () => attached,
      });
      if (workspace && linear?.tracker && linear.issueLifecycle) {
        reconciler = createItemReconciler({
          db,
          tracker: linear.tracker,
          lifecycle: linear.issueLifecycle,
          ...(parents ? { scopeSnapshot: parents.scopeSnapshot } : {}),
          onChanges: (changes) => {
            for (const { itemId, issue } of changes.issues)
              saveSchedulingContext(db, {
                itemId,
                ...("projectId" in issue ? { projectId: issue.projectId } : {}),
                ...("projectLeadId" in issue ? { projectLeadId: issue.projectLeadId } : {}),
                priority: issue.priority,
              });
            attached.applyDelegationChanges(changes);
          },
          afterChanges: (changes) => attached.finishDelegationChanges(changes),
        });
        publication = createPublicationReadiness({
          db,
          reconciler,
          canMerge: (itemId) => admission.canMerge(itemId).ok,
        });
        created.jobs.register("linear.redelegation", async (job) => {
          const lifecycle = linear?.issueLifecycle;
          const onEvent = linear?.webhook.onEvent;
          if (!lifecycle || !onEvent) return;
          await linearCaller("redelegation", () =>
            checkRedelegation(
              {
                db,
                store: inbox,
                appUserId: runtime.linearViewerId,
                inspect: (issueId) => lifecycle.inspect(issueId, { signal: abort.signal }),
                onEvent,
              },
              job.payload as { issueId: string; delegatedAtMs: number },
            ),
          );
        });
        const forItem = <T>(itemId: string, run: () => T): T => {
          const item = getWorkItem(db, itemId);
          return item ? linearItem(item.linearIdentifier, run, item.id) : run();
        };
        created.jobs.register("linear.item.reconcile", async (job) => {
          const target = job.payload as { itemId: string; workspaceId: string };
          await linearCaller("item-reconcile", () =>
            forItem(target.itemId, () =>
              reconciler?.reconcile({ ...target, signal: abort.signal }),
            ),
          );
          attached.reconcileExecution();
        });
        created.jobs.register("linear.epic.reconcile", async (job) => {
          const legacy = job.payload as { epicId: string; workspaceId: string };
          const item = db
            .query<{ id: string }, [string]>(
              `SELECT i.id FROM work_item i JOIN linear_session s ON s.session_id=i.session_key
               WHERE i.delegation_id=? AND s.stopped_at IS NULL
               AND i.state NOT IN ('completed','merged','cancelled') ORDER BY i.position,i.id LIMIT 1`,
            )
            .get(legacy.epicId);
          if (item)
            await linearCaller("epic-reconcile", () =>
              forItem(item.id, () =>
                reconciler?.reconcile({
                  itemId: item.id,
                  workspaceId: legacy.workspaceId,
                  signal: abort.signal,
                }),
              ),
            );
          attached.reconcileExecution();
        });
        created.jobs.register("linear.epics.reconcile", async () => {
          await linearCaller("epics-sweep", () => reconciler?.sweep({ signal: abort.signal }));
          attached.reconcileExecution();
        });
        enqueueJobOnce(db, {
          queue: "linear.epics.reconcile",
          jobKey: "linear.epics.reconcile",
          recurringEveryMs: 1_800_000,
          now: Date.now(),
        });
      }
      registerScheduler(created.jobs, () => attached.reconcileExecution());
      created.jobs.register("worktree.sweep", (_job, context) =>
        attached.sweepWorktrees(context.signal),
      );
      enqueueJobOnce(db, {
        queue: "worktree.sweep",
        jobKey: "worktree.sweep",
        recurringEveryMs: 3_600_000,
        now: Date.now(),
      });
      created.jobs.register("github.auth.recover", () => attached.recoverGitHubAuth());
      enqueueJobOnce(db, {
        queue: "github.auth.recover",
        jobKey: "github.auth.recover",
        recurringEveryMs: 30_000,
        priority: 0,
        now: Date.now(),
      });
    },
  });

  const host = startHost({
    db,
    clock: options?.hostClock,
    signal: abort.signal,
    agentAlive: (runId) => orchestrator?.agentAlive(runId) ?? false,
    stopAgent: (itemId) => {
      void orchestrator?.stopAgent(itemId).catch(() => undefined);
    },
    restartFromMainBlocked: (item) => {
      const policy = getItemRunCommitPolicy(db, item.id);
      try {
        if (policy) {
          policyCoauthors(policy);
          return null;
        }
      } catch {}
      return "Restart stopped: a valid GitHub App commit policy is missing. WIP is preserved. Restore the run policy before retrying.";
    },
    restartFromMain: (item) => {
      const selected = getWorkItemRepository(db, item.id) ?? repository;
      if (selected === null) return;
      const policy = getItemRunCommitPolicy(db, item.id);
      if (!policy) return;
      restartFromFreshMain({
        pawsRoot: paths.home,
        owner: selected.owner,
        repo: selected.repo,
        itemId: itemPathId(item),
        wipBranch: worktreeBranch(item),
        commitPolicy: policy,
      });
    },
  });

  let stopping: Promise<void> | undefined;
  return {
    env,
    paths,
    db,
    server,
    ready,
    catchUp: async () => {
      await running.catchUp();
    },
    tunnelUp: () => running.tunnelUp(),
    get tunnelRequested() {
      return running.tunnelRequested;
    },
    get tunnelUrl() {
      return running.tunnelUrl;
    },
    stop() {
      stopping ??= (async () => {
        runnerStopping = true;
        abort.abort();
        host.stop();
        const linearStopped = running.stop();
        const serverStopped = server.stop(true);
        const reconciliationStopped = reconciler?.close();
        await orchestrator?.shutdown();
        await reconciliationStopped;
        await Promise.all([loops.stop(), linearStopped, serverStopped]);
        await workspace?.stop();
        await stopRunner();
        prepareShutdown(db, Date.now(), (item) => {
          const policy = getItemRunCommitPolicy(db, item.id);
          if (policy)
            commitCheckpointSync(
              worktreePath(paths.home, itemPathId(item)),
              "wip: shutdown",
              undefined,
              policy,
            );
        });
        db.close();
      })();
      return stopping;
    },
  };
}

export function unavailableRemoteExecution(): NonNullable<OrchestratorOptions["remoteExecution"]> {
  const required = () => Promise.reject(new Error("A remote runner is required."));
  return {
    cancelItem: async () => {},
    agentForSession: () => required,
    agentForItem: () => required,
  };
}

function ownerCap(configFile: string): number | null {
  try {
    return readQueueSettings(loadConfigFile(configFile)).maxRunningPerOwner;
  } catch {
    return null;
  }
}

function down(): LinearRunning {
  return {
    catchUp: async () => undefined,
    tunnelUp: () => false,
    tunnelRequested: false,
    tunnelUrl: null,
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
  } catch {
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
  resolveApp?: (repository: string) => ActiveGitHubApp,
): RunnerRepositoryAccessOptions | undefined {
  return cacheRepositoryCredentials({
    github: {
      async mintInstallationToken(input) {
        const before = resolveApp?.(input.repository);
        if (!before || before.installationId !== input.installationId)
          throw new Error("GitHub integration unavailable.");
        const token = await createGitHubApp({
          client: createFetchGitHubClient(),
          appId: before.appId,
          privateKeyPem: before.privateKeyPem,
        }).mintInstallationToken(input);
        if (JSON.stringify(resolveApp?.(input.repository)) !== JSON.stringify(before))
          throw new Error("GitHub integration replaced.");
        return token;
      },
    },
    installationForRepository: (repository) => {
      try {
        return resolveApp?.(repository).installationId ?? null;
      } catch {
        return null;
      }
    },
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
  resolveApp?: (repository: string) => ActiveGitHubApp,
): AuthTokenProvider | null {
  if (resolveApp) {
    const name = `${repository.owner}/${repository.repo}`;
    const provider = () => {
      const active = resolveApp(name);
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
    const perform = async (operation: "token" | "user" | "botIdentity") => {
      const before = provider();
      const result = await before.provider[operation]!();
      if (JSON.stringify(resolveApp(name)) !== JSON.stringify(before.active))
        throw new Error("GitHub integration replaced.");
      return result;
    };
    return {
      source: "app",
      token: async () => (await perform("token")) as string,
      user: async () => (await perform("user")) as { login: string; id: number },
      botIdentity: async () => (await perform("botIdentity")) as AppBotIdentity,
    };
  }
  const env = runtime.env;
  let privateKeyPem: string | null = null;
  if (env.githubAppPrivateKeyPath !== null) {
    try {
      privateKeyPem = readSecretFile(env.githubAppPrivateKeyPath, false);
    } catch {
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
  } catch {
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
  resolveApp?: (repository: string) => ActiveGitHubApp;
  repositoryForItem: (item: WorkItemRecord) => RepositoryBinding | null;
  actorForItem: (item: WorkItemRecord) => string | null;
  /** False, or a `GitHubDenial` with the reason the session ends with, cancels the item. */
  authorizeItem?: (
    item: WorkItemRecord,
    signal: AbortSignal,
    repository: RepositoryBinding,
  ) => Promise<boolean | GitHubDenial>;
  integrationIdentity?: (item: WorkItemRecord) => string;
  currentIntegrationItem?: (item: WorkItemRecord) => boolean | GitHubDenial;
  administratorsForItem?: (item: WorkItemRecord) => readonly string[];
  accessForItem?: (item: WorkItemRecord) => "read" | "write";
}): GitHubIntegration {
  const installation = createGitHubInstallationCheck({
    home: input.runtime.env.home,
    env: input.env,
    ...(input.resolveApp ? { resolve: input.resolveApp } : {}),
  });
  return {
    recoveryUrl: `${input.runtime.publicUrl ?? "http://127.0.0.1:8787"}/status/settings/integrations`,
    administrators: input.administratorsForItem ?? (() => []),
    current: input.currentIntegrationItem ?? (() => true),
    unavailableRetryMs: [2_000, 5_000, 10_000, 20_000, 30_000],
    identity:
      input.integrationIdentity ??
      ((item) => JSON.stringify([input.actorForItem(item), input.repositoryForItem(item)])),
    authorize: async (item: WorkItemRecord, signal: AbortSignal) => {
      const selected = input.repositoryForItem(item);
      if (selected === null) return false;
      return input.authorizeItem ? input.authorizeItem(item, signal, selected) : true;
    },
    async check(item: WorkItemRecord, signal: AbortSignal) {
      const selected = input.repositoryForItem(item);
      return (
        selected !== null &&
        (await installation(
          `${selected.owner}/${selected.repo}`,
          input.accessForItem?.(item) ?? "write",
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

const CLI_HELP = `usage: paws [--no-tunnel]

Commands:
  paws                          start Paws on 127.0.0.1:8787
  paws doctor                   check prerequisites, including the GitHub App
  paws login slack              connect Slack
  paws workspace bootstrap      print a single-use workspace setup code
  paws runner <command>         pair and run a remote runner
  paws runner-authority init    create the runner command key
  paws public-tls validate      check the public HTTPS certificate

GitHub access uses the GitHub App only. See docs/github-app.md.`;

async function doctorMain(): Promise<number> {
  const checks = doctorChecks(await realProbe(process.env));
  console.log(formatDoctor(checks));
  return checks.every((item) => item.ok) ? 0 : 1;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const command = argv[0];
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
    } catch {
      console.error("Runner authority initialization failed.");
      process.exit(1);
    }
  }
  if (command === "public-tls") {
    try {
      if (argv.length !== 2 || argv[1] !== "validate") throw new Error("Invalid command");
      validatePublicTls(process.env);
      console.log("Public HTTPS certificate is valid.");
      process.exit(0);
    } catch {
      console.error("Public HTTPS certificate validation failed.");
      process.exit(1);
    }
  }
  if (command === "workspace") {
    try {
      if (argv.length !== 2 || argv[1] !== "bootstrap")
        throw new Error("usage: paws workspace bootstrap");
      const runtime = loadRuntime(process.env);
      if (runtime.configError !== null) throw new Error(runtime.configError);
      const paths = pawsPaths(runtime.env.home);
      assertLinearQueue(paths.db);
      ensureLayout(paths);
      const db = openDatabase(paths.db);
      try {
        migrate(db);
        const linear = openLinear({
          db,
          secretsDir: paths.secretsDir,
          env: linearEnv(runtime, process.env),
          publicUrl: runtime.publicUrl,
          isAuthorized: () =>
            !isLinearAppRevoked(db, {
              oauthClientId: runtime.linearClientId,
              appUserId: runtime.linearViewerId,
            }),
          webhooks: false,
          noTunnel: true,
        });
        if (linear.memberships === null)
          throw new Error("Connect the Linear app installation before workspace setup.");
        const grant = await issueVerifiedWorkspaceBootstrap(db, linear.memberships);
        console.log(`Workspace: ${grant.organization.name} (${grant.organization.id})`);
        console.log(`Single-use setup code (expires in 10 minutes): ${grant.code}`);
      } finally {
        db.close();
      }
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Workspace setup failed.");
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
  if (command === "login" && argv[1] === "slack") {
    try {
      if (argv.length !== 2) throw new Error("usage: paws login slack");
      const runtime = loadRuntime(process.env);
      await loginSlack({
        home: runtime.env.home,
        env: process.env,
        onAuthorize(url) {
          console.log(`Authorize Paws: ${url}`);
        },
      });
      console.log("Slack connected.");
      process.exit(0);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "Slack login failed");
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
  const paws = startPaws(process.env, {
    refreshRepositories: true,
    refreshAgentCatalog: true,
    noTunnel: argv.includes("--no-tunnel"),
  });
  let exiting = false;
  const shutdown = (exitCode = 0) => {
    if (exiting) return;
    exiting = true;
    void (async () => {
      await paws.stop();
      process.exit(exitCode);
    })().catch(() => process.exit(1));
  };
  process.on("SIGINT", () => shutdown());
  process.on("SIGTERM", () => shutdown());
  if (process.env.PAWS_PUBLIC_DASHBOARD === "1")
    process.on("SIGHUP", () => {
      if (exiting) return;
      try {
        validatePublicTls(process.env);
      } catch {
        console.error("Public HTTPS certificate renewal rejected.");
        return;
      }
      shutdown(PUBLIC_TLS_RESTART_EXIT);
    });
  try {
    await paws.ready;
  } catch {
    console.error("Paws startup failed.");
    await paws.stop();
    process.exit(1);
  }
  const origin = `${paws.server.protocol}://${paws.server.hostname}:${paws.server.port}`;
  const tunnel =
    paws.tunnelRequested && paws.tunnelUrl !== null ? ` · tunnel ${paws.tunnelUrl}` : "";
  // One write so a piped reader cannot observe the ready line before the dashboard line exists.
  console.log(`paws ready · ${origin}${tunnel}\ndashboard ${origin}/status`);
}

/** One signed-in provider, shared by issues, comments, and git. */
export function gitHostToken(provider: AuthTokenProvider): GitHubTokenProvider {
  return {
    mode: provider.source,
    tokenFor: () => provider.token(),
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
  } catch {
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
