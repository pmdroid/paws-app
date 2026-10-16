import { runRunnerCli } from "./runner-cli";
import { join } from "node:path";
import { createSlackIdentityReads, loginSlack, readSlackApp } from "./slack";
import { readSecretFile } from "./credentials";
import type { Database } from "bun:sqlite";
import { commitCheckpointSync, restartFromFreshMain, worktreePath } from "./acp";
import {
  createCommentMode,
  createLinearCommentBoard,
  createPersonalLinearClient,
  withCommentActivities,
  type CommentMode,
} from "./comments";
import {
  closeoutPolicyRoot,
  ensureLayout,
  loadRuntime,
  loadEnv,
  loadRunnerControl,
  pawsPaths,
  type EnvSource,
  type PawsEnv,
  type PawsPaths,
  type RuntimeConfig,
} from "./config";
import {
  WORK_ITEM_STATES,
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
  listWorkspaceMembers,
  listWorkspaceRepositories,
  getLinearSessionInstallation,
  isLinearAppRevoked,
  getLinearSessionAccess,
  delegatedLinearUserId,
  getWorkItemRepository,
  getWorkItemRepositoryChoice,
  getWorkItemRepositoryAnswer,
  getTaskMode,
  taskRequiresRepository,
  listWorkItemsByStates,
  listWorkItems,
  migrate,
  openDatabase,
  prepareShutdown,
  recoverOnStartup,
  recordGitHubDelivery,
  startLoops,
  submitCommand,
  type WorkItemRecord,
} from "./db";
import { doctorChecks, formatDoctor, realProbe } from "./doctor";
import {
  checkGitHubCliRepositoryAccess,
  createGitHubTokenProvider,
  createVerifiedGitHubLogin,
  createGitHubInstallationCheck,
  createWorkspaceGitHubActivation,
  type ActiveGitHubApp,
  loginGitHub,
  logoutGitHub,
  type GitHubTokenProvider as AuthTokenProvider,
} from "./auth";
import {
  checkRepositoryWriteAccess,
  checkRepositoryReadAccess,
  createFetchGitHubClient,
  createGitHubApp,
  inspectPullRequestMerge,
  githubHttpsUrl,
  type GitHubTokenProvider,
} from "./github";
import { startHost } from "./host";
import {
  createInboxStore,
  createIntakePollSource,
  createLinearTracker,
  openLinear,
  startCatchUpPoller,
  parseLinearAdministration,
  sessionCreatedKey,
  type AcceptedLinearEvent,
  type LinearRunning,
  type TrackerAdapter,
} from "./linear";
import {
  attachOrchestrator,
  createLinearArtifactReader,
  itemPathId,
  repositoryAnswer,
  worktreeBranch,
  type GitHubBinding,
  LinearTaskAccess,
  authorizeLinearTask,
  handleLinearAdministration,
  refreshLinearNotificationContext,
  type Orchestrator,
  type OrchestratorOptions,
  type RepositoryBinding,
  type HostGitHubAuth,
} from "./loop";
import {
  createItemReconciler,
  createPublicationReadiness,
  hasPendingEpicChanges,
  canAdvanceItem,
} from "./intake";
import { createExecutionControls } from "./execution-controls";
import {
  createApprovedProjects,
  createProjectHttp,
  createProjectExecutionGuard,
} from "./project-execution";
import { epicSnapshotsComplete, saveExternalBlockerPolicies } from "./intake";
import { registerScheduler, saveSchedulingContext } from "./scheduler";
import { createRunnerPlacement, createRunnerPlacementBrowser } from "./runner-placement";
import { startServer } from "./server";
import { runSetup } from "./setup";
import { createLinearReconnect } from "./linear-reconnect";
import { findOpenQuestion } from "./questions";
import { loadPublicTls, validatePublicTls, PUBLIC_TLS_RESTART_EXIT } from "./deployment";
import {
  issueVerifiedWorkspaceBootstrap,
  startWorkspaceAccess,
  createCommitPolicyForItem,
  MissingCommitAttributionError,
  createWorkspaceAssignments,
  type WorkspacePrincipal,
} from "./workspace";
import {
  initializeRunnerCoordinator,
  openRunnerCoordinator,
  type RunnerCoordinator,
  type RunnerRepositoryAccessOptions,
} from "./runner-coordinator";
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
  noTunnel?: boolean;
  hostClock?: Clock;
  commitPolicyForItem?: (item: WorkItemRecord) => Promise<GitCommitPolicy>;
  runnerRepositoryAccess?: RunnerRepositoryAccessOptions;
  runnerTranscriptObjects?: RunnerTranscriptObjects;
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
  const remotePlacementReady =
    runnerConfig !== null && (repositoryAccess !== undefined || runtime.githubAuth === "app");
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
    if (runtime.linearClientId === null || runtime.linearMode !== "agent-session")
      throw new Error("Public dashboard requires the Linear app OAuth client.");
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
  const appActivation = createWorkspaceGitHubActivation(db, runtime.env.home, envSource);
  const resolveApp = (repository: string) => appActivation.resolve(repository);
  repositoryAccess ??= runnerRepositoryAccess(runtime, resolveApp);
  recoverOnStartup(db);
  const abort = new AbortController();
  let orchestrator: Orchestrator | null = null;
  let reconciler: ReturnType<typeof createItemReconciler> | null = null;
  let publication: ReturnType<typeof createPublicationReadiness> | null = null;
  let dispatch: (() => readonly string[]) | null = null;
  let legacyReadyItemIds: readonly string[] = [];
  let executionControls: ReturnType<typeof createExecutionControls> | null = null;
  let projects: ReturnType<typeof createApprovedProjects> | null = null;
  let projectHttp: ReturnType<typeof createProjectHttp> | null = null;
  const projectExecution = createProjectExecutionGuard(db, () => projects);
  const managedEpicReady = (epicId: string): boolean =>
    projectExecution.canDispatch(epicId) &&
    !hasPendingEpicChanges(db, epicId) &&
    epicSnapshotsComplete(db, epicId);
  const repository = repositoryBinding(runtime.repo);
  const repositories = [runtime.repo, ...runtime.file.githubRepos]
    .map(repositoryBinding)
    .filter((value): value is RepositoryBinding => value !== null);
  const auth = repository === null ? null : authProvider(runtime, repository, "write", resolveApp);
  const github = githubBinding(auth);
  const webhooks = runtime.webhooks;
  const channel: "comments" | "agent-session" =
    runtime.linearMode === "agent-session" ? "agent-session" : "comments";
  const inbox = createInboxStore(db);

  const followUp = async (event: AcceptedLinearEvent): Promise<void | boolean> => {
    if (orchestrator === null) throw new Error("loop is not attached");
    const accepted = await orchestrator.onLinearEvent(event);
    if (accepted !== false && reconciler && event.sessionId) {
      const session = getLinearSession(db, event.sessionId);
      const linked = workItemForSession(db, event.sessionId);
      if (linked && session?.organizationId && session.stoppedAt === null) {
        const workspace = db
          .query<{ id: string }, [string, string]>(
            "SELECT w.id FROM workspace w JOIN epic e ON e.id=? AND e.state IN ('running','stalled') WHERE w.linear_organization_id=?",
          )
          .get(linked.epicId, session.organizationId);
        if (workspace)
          await reconciler.reconcile({
            itemId: linked.id,
            workspaceId: workspace.id,
            signal: abort.signal,
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
  let workspace: ReturnType<typeof startWorkspaceAccess> | undefined;
  let assignments: ReturnType<typeof createWorkspaceAssignments> | undefined;
  const stopLinearSession = (sessionId: string): void => {
    for (const item of listWorkItems(db)) {
      if (item.sessionKey !== sessionId) continue;
      if (["cancelled", "completed", "merged"].includes(item.state)) continue;
      submit({ type: "cancel", source: "linear", itemId: item.id, requestedAt: Date.now() });
    }
  };
  const linear =
    channel === "agent-session"
      ? openLinear({
          db,
          secretsDir: paths.secretsDir,
          isAuthorized: () =>
            !isLinearAppRevoked(db, {
              oauthClientId: runtime.linearClientId,
              appUserId: runtime.linearViewerId,
            }),
          beforeEvent: async (event, request) => {
            const issueEvent = acceptedIssueChange(event);
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
                  await linearTaskAccess.revalidateSessions(sessionIds);
                },
                reconcile: async (notification) => {
                  if (linearTaskAccess === null) throw new Error("Linear is not connected.");
                  if (reconciler)
                    await reconciler.issueChanged({
                      issueId: notification.issueId,
                      organizationId: notification.organizationId,
                    });
                  await linearTaskAccess.reconcile(notification.issueId);
                  orchestrator?.reconcileExecution();
                  await refreshLinearNotificationContext(db, linear?.tracker ?? null, notification);
                },
                notify: (command) => {
                  if (orchestrator === null) throw new Error("The loop is not attached.");
                  orchestrator.bus.emit(command);
                },
              })
            ) {
              const administration = parseLinearAdministration(event);
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
            if (
              event.sessionId !== null &&
              getLinearSessionAccess(db, event.sessionId) === "revoked"
            )
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
        })
      : null;

  if (linear !== null)
    linearTaskAccess = new LinearTaskAccess(db, {
      access: linear.access,
      lifecycle: linear.issueLifecycle,
      oauthClientId: runtime.linearClientId,
      appUserId: runtime.linearViewerId,
      stopSession: stopLinearSession,
      interruptSession: async (sessionId) => {
        if (orchestrator === null) throw new Error("The loop is not attached.");
        await orchestrator.interruptLinearSession(sessionId);
      },
    });

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
          memberships: linear.memberships,
          lifecycle: linear.issueLifecycle,
          tracker: linear.tracker,
          accept: (event, signal) => linearTaskAccess!.accept(event, { signal }),
          continue: followUp,
        });
      }
      workspace = startWorkspaceAccess({
        assignments,
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
  const commitPolicyForItem = async (item: WorkItemRecord): Promise<GitCommitPolicy> => {
    const selected = getWorkItemRepository(db, item.id) ?? repository;
    if (!selected) throw new Error("Attribution repository is missing");
    const bot = await authProvider(runtime, selected, "read", resolveApp)?.botIdentity?.();
    if (!bot) throw new Error("Attribution App bot authority is unavailable");
    const policy = options?.commitPolicyForItem
      ? await options.commitPolicyForItem(item)
      : linear?.tracker?.getIssueAttribution && linear.memberships && runtime.linearClientId
        ? await createCommitPolicyForItem({
            db,
            bot,
            clientId: runtime.linearClientId,
            tracker: {
              getIssueAttribution: linear.tracker.getIssueAttribution.bind(linear.tracker),
            },
            memberships: linear.memberships,
          })(item)
        : undefined;
    if (!policy) throw new Error("Verified workspace attribution is unavailable");
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
          root: runnerConfig.root,
          hostname: runnerConfig.hostname,
          port: runnerConfig.port,
          tls: tls!,
          repositoryAccess,
          transcriptObjects,
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
  const placement =
    linear?.tracker && linear.issueLifecycle
      ? createRunnerPlacement({
          db,
          tracker: linear.tracker,
          lifecycle: linear.issueLifecycle,
          sessionActor: projectExecution.actor,
        })
      : undefined;
  const placementBrowser = createRunnerPlacementBrowser({ db });
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
        closeoutForItem: (itemId, signal, checkoutExclusions) => {
          let commands: ReturnType<Awaited<typeof remote>["agents"]["closeoutForItem"]>;
          return {
            async runLogged(request) {
              signal?.throwIfAborted();
              await ready;
              const backend = await remote;
              signal?.throwIfAborted();
              commands ??= backend.agents.closeoutForItem(itemId, signal, checkoutExclusions);
              return commands.runLogged(request);
            },
          };
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
      hostname: env.host,
      executionControls: async (...args) =>
        executionControls?.handle(...args) ??
        Response.json({ error: "Execution controls are starting." }, { status: 503 }),
      projects: async (...args) =>
        projectHttp?.(...args) ??
        Response.json({ error: "Project delivery is starting." }, { status: 503 }),
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
            runnerControl: async (request: Request, principal: WorkspacePrincipal) =>
              (await placementBrowser(request, principal)) ??
              (runner
                ? await runner.browser(request, principal)
                : Response.json({ error: "Runner control is starting." }, { status: 503 })),
          }),
      port: env.port,
      linearWebhookSecret: env.linearWebhookSecret,
      githubWebhookSecret: env.githubWebhookSecret,
      githubWebhook: { accept: (delivery) => recordGitHubDelivery(db, delivery) },
      slackSigningSecret:
        envSource.SLACK_SIGNING_SECRET ?? readSlackApp(paths.home)?.signingSecret ?? null,
      linearWebhook: linear?.webhook ?? (webhooks ? { store: inbox } : undefined),
      webhooks: webhooks || env.githubWebhookSecret !== null,
      db,
      statusEnv: envSource,
      closeoutHome: paths.home,
      readLinearArtifact: createLinearArtifactReader({ db, secretsDir: paths.secretsDir }),
      ...(linear?.startSession ? { startLinearSession: linear.startSession } : {}),
      agentSettings: {
        configPath: paths.configFile,
        repos: repositories.map((value) => `${value.owner}/${value.repo}`),
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

  const comment = channel === "comments" ? openComments(runtime) : null;
  const tracker =
    comment !== null
      ? commentTracker(db, comment.tracker, comment.mode)
      : (linear?.tracker ?? null);
  const loops = startLoops({
    db,
    signal: abort.signal,
    concurrency: workspace && linear?.tracker && linear.issueLifecycle ? 4 : 1,
    prepare(created) {
      assignments?.register(created.jobs);
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
        linearAccess: linearTaskAccess ?? undefined,
        canDispatchEpic: projectExecution.canDispatch,
        publicationReady: (itemId) => {
          const item = getWorkItem(db, itemId);
          return !!item && projectExecution.canDispatch(item.epicId);
        },
        authorizeLinearIntake: projectExecution.authorizeIntake,
        linearIntakeScope: projectExecution.scope,
        linearIntakeActor: projectExecution.actor,
        onLinearIntake: projectExecution.accepted,
        adoptLinearParent: projectExecution.adoptParent,
        authorizeLinearEvent: async (event) =>
          (await projectExecution.authorizeEvent(event)) ?? true,
        ...(workspace && linear?.tracker && linear.issueLifecycle
          ? {
              canDispatchEpic: managedEpicReady,
              canAdvanceItem: (itemId: string) => {
                const item = getWorkItem(db, itemId);
                const sessionId = item?.sessionKey ?? null;
                const session = sessionId ? getLinearSession(db, sessionId) : null;
                const currentWorkspace = session?.organizationId
                  ? db
                      .query<{ id: string }, [string]>(
                        "SELECT id FROM workspace WHERE linear_organization_id=?",
                      )
                      .get(session.organizationId)
                  : null;
                return (
                  item !== null &&
                  projectExecution.canDispatch(item.epicId) &&
                  currentWorkspace !== null &&
                  canAdvanceItem(db, {
                    itemId,
                    workspaceId: currentWorkspace.id,
                  })
                );
              },
              dispatchReady: (input: { legacyReadyItemIds: readonly string[] }) => {
                legacyReadyItemIds = input.legacyReadyItemIds;
                dispatch?.();
              },
              publicationReady: (
                ...args: Parameters<NonNullable<OrchestratorOptions["publicationReady"]>>
              ) =>
                Promise.resolve(publication?.publicationReady(...args) ?? false).then(
                  (publicationAllowed) => {
                    const item = getWorkItem(db, args[0]);
                    return (
                      publicationAllowed && !!item && projectExecution.canDispatch(item.epicId)
                    );
                  },
                ),
            }
          : {}),
        ...(workspace
          ? {
              authorizeLinearIntake: (sessionId, spec) =>
                projectExecution.authorizeIntake(sessionId, spec) &&
                (assignments?.authorizeIntake(sessionId, spec) ?? true),
              authorizeLinearEvent: async (event) =>
                (await (await workspace.access).authorizeLinearEvent(event)) &&
                ((await projectExecution.authorizeEvent(event)) ??
                  (assignments ? await assignments.authorize(event) : true)),
            }
          : {}),
        githubAuth:
          channel === "agent-session"
            ? createLinearGitHubAuth({
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
                  const configured = repositories.filter(
                    (candidate, index) =>
                      repositories.findIndex(
                        (other) => other.owner === candidate.owner && other.repo === candidate.repo,
                      ) === index,
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
                },
                accessForItem: (item) =>
                  getTaskMode(db, item.id) !== "code" && taskRequiresRepository(db, item.id)
                    ? "read"
                    : "write",
                actorForItem: (item) => delegatedLinearUserId(db, item.id),
                attributionReady: async (item) => {
                  try {
                    if (getTaskMode(db, item.id) === "code") await commitPolicyForItem(item);
                    return true;
                  } catch (error) {
                    if (error instanceof MissingCommitAttributionError) return false;
                    throw error;
                  }
                },
                authorizeItem: async (item, signal, selectedRepository) => {
                  if (
                    linearTaskAccess &&
                    !(await authorizeLinearTask(linearTaskAccess, item, signal))
                  )
                    return false;
                  if (!workspace) return true;
                  const session = item.sessionKey
                    ? getLinearSessionInstallation(db, item.sessionKey)
                    : null;
                  const currentWorkspace = session?.organizationId
                    ? workspaceForOrganization(db, session.organizationId)
                    : null;
                  const actorId = delegatedLinearUserId(db, item.id);
                  if (!currentWorkspace || !actorId || !session?.teamId || !linear?.memberships)
                    return false;
                  const member = workspaceLinearMember(db, currentWorkspace.id, actorId);
                  const identity = await linear.memberships.member(
                    currentWorkspace.organizationId,
                    actorId,
                    signal,
                  );
                  const latest = workspaceLinearMember(db, currentWorkspace.id, actorId);
                  const currentSession = item.sessionKey
                    ? getLinearSessionInstallation(db, item.sessionKey)
                    : null;
                  return (
                    currentSession !== null &&
                    currentSession.organizationId === session.organizationId &&
                    currentSession.oauthClientId === session.oauthClientId &&
                    currentSession.appUserId === session.appUserId &&
                    currentSession.teamId === session.teamId &&
                    identity.organizationId === currentWorkspace.organizationId &&
                    identity.userId === actorId &&
                    identity.active &&
                    !identity.guest &&
                    identity.teamIds.includes(session.teamId) &&
                    member !== null &&
                    member.active &&
                    member.role !== "observer" &&
                    member.teamIds.includes(session.teamId) &&
                    latest !== null &&
                    latest.active &&
                    latest.role !== "observer" &&
                    latest.teamIds.includes(session.teamId) &&
                    listWorkspaceRepositories(db, currentWorkspace.id).some(
                      (entry) =>
                        entry.teamId === session.teamId &&
                        entry.repository.toLowerCase() ===
                          `${selectedRepository.owner}/${selectedRepository.repo}`.toLowerCase(),
                    )
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
                    member !== null &&
                    member.active &&
                    member.role !== "observer" &&
                    member.teamIds.includes(session.teamId)
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
              })
            : undefined,
        commitPolicyForItem: runtime.githubAuth === "app" ? commitPolicyForItem : undefined,
        files: linear?.files,
        secretsDir: paths.secretsDir,
        catchUp: async () => {
          await running.catchUp();
        },
        repository,
        repositories,
        repositoryAccess: async (candidate, signal, access) => {
          if (runtime.githubAuth === "gh")
            return checkGitHubCliRepositoryAccess(
              { repo: `${candidate.owner}/${candidate.repo}`, access },
              signal,
            );
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
            throw new Error("GitHub sign-in is required before reading the repository.");
          const token = await provider.token();
          signal.throwIfAborted();
          return token;
        },
        github,
        githubForRepository: (selected) =>
          githubBinding(authProvider(runtime, selected, "write", resolveApp)),
        channel,
        caps: { maxTurns: runtime.maxTurns, maxAwakeMs: runtime.maxAwakeMs },
      });
      orchestrator = attached;
      executionControls = createExecutionControls({
        db,
        bus: attached.bus,
        getPort: () => attached,
      });
      if (workspace && linear?.tracker && linear.issueLifecycle) {
        if (linear.memberships && linear.startSession && runtime.publicUrl) {
          projects = createApprovedProjects({
            db,
            tracker: linear.tracker,
            memberships: linear.memberships,
            startSession: linear.startSession,
            resumeSession: async (sessionId) => {
              const event = linear.webhook.store.get(sessionCreatedKey(sessionId));
              if (!event || !linear.webhook.onEvent)
                throw new Error("Wait for Linear to refresh this project session.");
              if ((await linear.webhook.onEvent(event)) === false)
                throw new Error("Project session admission is awaiting access.");
            },
            origin: runtime.publicUrl,
            bus: attached.bus,
            getPort: () => attached,
            repository: (name) =>
              repositories.find((value) => `${value.owner}/${value.repo}` === name) ?? null,
            saveBlockerPolicies: (value) => saveExternalBlockerPolicies(db, value),
          });
          projectHttp = createProjectHttp({ db, tracker: linear.tracker, projects });
          projects.register(created.jobs);
        }
        reconciler = createItemReconciler({
          db,
          tracker: linear.tracker,
          lifecycle: linear.issueLifecycle,
          scopeSnapshot: projectExecution.scopeSnapshot,
          inspectMerge: async (input) => {
            input.signal?.throwIfAborted();
            const [owner, repo] = input.repository.split("/") as [string, string];
            const provider = authProvider(
              runtime,
              { owner, repo, remoteUrl: githubHttpsUrl(owner, repo) },
              "read",
              resolveApp,
            );
            if (!provider) throw new Error("Connect GitHub to verify the blocker pull request.");
            return inspectPullRequestMerge({ ...input, token: await provider.token() });
          },
          onChanges: (changes) => {
            for (const { itemId, issue } of changes.issues)
              saveSchedulingContext(db, {
                itemId,
                ...("projectId" in issue ? { projectId: issue.projectId } : {}),
                priority: issue.priority,
              });
            attached.applyEpicChanges(changes);
          },
          afterChanges: (changes) => attached.finishEpicChanges(changes),
        });
        publication = createPublicationReadiness({ db, reconciler });
        const enqueueMissingSnapshots = () => {
          const targets = db
            .query<{ itemId: string; workspaceId: string }, []>(
              `SELECT picked.id AS itemId,w.id AS workspaceId FROM epic e
            JOIN work_item picked ON picked.id=(
              SELECT i.id FROM work_item i
              JOIN linear_session s ON s.session_id=i.session_key AND s.stopped_at IS NULL
              WHERE i.epic_id=e.id AND i.state NOT IN ('completed','merged','cancelled')
              AND NOT EXISTS(SELECT 1 FROM work_item_specification f WHERE f.item_id=i.id AND f.present=0)
              ORDER BY i.position,i.id LIMIT 1)
            JOIN linear_session s ON s.session_id=picked.session_key
            JOIN workspace w ON w.linear_organization_id=s.organization_id
            WHERE e.state IN ('running','stalled') AND s.stopped_at IS NULL
            AND EXISTS(SELECT 1 FROM work_item gap WHERE gap.epic_id=e.id AND gap.state NOT IN ('completed','merged','cancelled')
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
        created.jobs.register("linear.item.reconcile", async (job) => {
          const target = job.payload as { itemId: string; workspaceId: string };
          await reconciler?.reconcile({ ...target, signal: abort.signal });
          attached.reconcileExecution();
        });
        created.jobs.register("linear.epic.reconcile", async (job) => {
          const legacy = job.payload as { epicId: string; workspaceId: string };
          const item = db
            .query<{ id: string }, [string]>(
              `SELECT i.id FROM work_item i JOIN linear_session s ON s.session_id=i.session_key
               WHERE i.epic_id=? AND s.stopped_at IS NULL
               AND i.state NOT IN ('completed','merged','cancelled') ORDER BY i.position,i.id LIMIT 1`,
            )
            .get(legacy.epicId);
          if (item)
            await reconciler?.reconcile({
              itemId: item.id,
              workspaceId: legacy.workspaceId,
              signal: abort.signal,
            });
          attached.reconcileExecution();
        });
        dispatch = registerScheduler(
          created.jobs,
          () => {
            enqueueMissingSnapshots();
            return {
              now: Date.now(),
              defaultRepository: repository,
              legacyReadyItemIds,
              canDispatchEpic: managedEpicReady,
              handoffForItem: (itemId) => attached.dependencyHandoff(itemId),
            };
          },
          () => attached.reconcileExecution(),
        );
        created.jobs.register("execution.reconcile", () => {
          attached.reconcileExecution();
        });
        enqueueJobOnce(db, {
          queue: "execution.reconcile",
          jobKey: "execution.reconcile",
          recurringEveryMs: 30_000,
          now: Date.now(),
        });
        created.jobs.register("linear.epics.reconcile", async () => {
          await reconciler?.sweep({ signal: abort.signal });
          attached.reconcileExecution();
        });
        enqueueJobOnce(db, {
          queue: "linear.epics.reconcile",
          jobKey: "linear.epics.reconcile",
          recurringEveryMs: 300_000,
          now: Date.now(),
        });
      }
      if (channel === "agent-session") {
        created.jobs.register("github.auth.recover", () => attached.recoverGitHubAuth());
        enqueueJobOnce(db, {
          queue: "github.auth.recover",
          jobKey: "github.auth.recover",
          recurringEveryMs: 30_000,
          priority: 0,
          now: Date.now(),
        });
      }
    },
  });

  if (comment !== null && comment.poll !== null) {
    const poller = startCatchUpPoller({
      source: comment.poll.source,
      store: inbox,
      db,
      onEvent: followUp,
      submitCommand: submit,
      beforeDelay: async () => {
        const current = orchestrator;
        if (current === null) return;
        try {
          await syncComments(db, comment.mode, current);
        } catch (error) {
          const message = error instanceof Error ? error.message : "comment sync failed";
          console.error(`linear comment sync failed: ${message}`);
        }
      },
    });
    running = {
      catchUp: () => poller.pollNow(),
      tunnelUp: () => false,
      tunnelRequested: false,
      tunnelUrl: null,
      stop: () => poller.stop(),
    };
  }

  const host = startHost({
    db,
    clock: options?.hostClock,
    signal: abort.signal,
    agentAlive: (runId) => orchestrator?.agentAlive(runId) ?? false,
    restartFromMainBlocked:
      runtime.githubAuth === "app"
        ? (item) => {
            const policy = getItemRunCommitPolicy(db, item.id);
            try {
              if (policy) {
                policyCoauthors(policy);
                return null;
              }
            } catch {}
            return "Restart stopped: verified GitHub attribution for the project lead and task steerer is missing. WIP is preserved. Restore the attribution links before retrying.";
          }
        : undefined,
    restartFromMain: (item) => {
      const selected = getWorkItemRepository(db, item.id) ?? repository;
      if (selected === null) return;
      const policy = getItemRunCommitPolicy(db, item.id);
      if (runtime.githubAuth === "app" && !policy) return;
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
          if (runtime.githubAuth !== "app" || policy)
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

type CommentRuntime = {
  tracker: TrackerAdapter;
  mode: CommentMode;
  poll: {
    source: ReturnType<typeof createIntakePollSource>;
  } | null;
};

function openComments(runtime: RuntimeConfig): CommentRuntime | null {
  const credential = runtime.linearApiKey;
  if (credential === null) return null;
  const personal = createPersonalLinearClient({ apiKey: credential });
  const tracker = createLinearTracker(personal);
  const mode = createCommentMode({
    board: createLinearCommentBoard(personal),
    selfUserId: runtime.linearViewerId ?? "paws",
  });
  const team = runtime.linearTeamId ?? runtime.linearTeam;
  return {
    tracker,
    mode,
    poll:
      team === null
        ? null
        : {
            source: createIntakePollSource(personal, {
              teamId: team,
              appUserId: runtime.linearViewerId,
            }),
          },
  };
}

export function commentTracker(
  db: Database,
  base: TrackerAdapter,
  mode: CommentMode,
): TrackerAdapter {
  return withCommentActivities(base, {
    async postProgress(update) {
      bindIssue(db, mode, update.sessionId);
      await mode.postProgress(update);
    },
    async askQuestion(question) {
      bindIssue(db, mode, question.sessionId);
      await mode.askQuestion(question);
    },
  });
}

function bindIssue(db: Database, mode: CommentMode, sessionId: string): void {
  const match = listWorkItemsByStates(db, WORK_ITEM_STATES).find(
    (item) => item.linearIssueId === sessionId,
  );
  mode.bind({
    itemId: match?.id ?? sessionId,
    linearIssueId: sessionId,
    sessionId,
  });
}

export async function syncComments(
  db: Database,
  mode: CommentMode,
  orchestrator: Pick<Orchestrator, "bus" | "onLinearEvent">,
): Promise<void> {
  const items = listWorkItemsByStates(db, WORK_ITEM_STATES);
  const issues = new Set(items.map((item) => item.linearIssueId));
  for (const issueId of issues) {
    const match = items.find((item) => item.linearIssueId === issueId);
    if (match === undefined) continue;
    mode.bind({ itemId: match.id, linearIssueId: issueId, sessionId: issueId });
    const result = await mode.sync(issueId, findOpenQuestion(db, issueId));
    for (const answer of result.resumed) {
      await orchestrator.onLinearEvent({
        dedupeKey: `comment-answer:${answer.questionId}`,
        deliveryId: null,
        source: "poll",
        action: "prompted",
        sessionId: issueId,
        issueId,
        activityId: null,
        body: answer.answer,
        signal: null,
        updatedAtMs: Date.now(),
        payload: JSON.stringify({ answeredBy: answer.answeredBy, questionId: answer.questionId }),
      });
    }
    for (const stopped of result.stopped) {
      submitCommand(db, orchestrator.bus, {
        type: "stop",
        itemId: stopped.itemId,
        source: "linear",
        requestedAt: stopped.requestedAt,
      });
    }
  }
}

function unavailableRemoteExecution(): NonNullable<OrchestratorOptions["remoteExecution"]> {
  const required = () => Promise.reject(new Error("A remote runner is required."));
  return {
    cancelItem: async () => {},
    agentForSession: () => required,
    agentForItem: () => required,
    closeoutForItem: () => ({ runLogged: required }),
  };
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
  if (runtime.githubAuth !== "app") return undefined;
  return {
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
  };
}

export function authProvider(
  runtime: RuntimeConfig,
  repository: RepositoryBinding,
  access: "read" | "write" = "write",
  resolveApp?: (repository: string) => ActiveGitHubApp,
): AuthTokenProvider | null {
  if (runtime.githubAuth === "app" && resolveApp) {
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
  if (runtime.githubAuth === "app" && env.githubAppPrivateKeyPath !== null) {
    try {
      privateKeyPem = readSecretFile(env.githubAppPrivateKeyPath, false);
    } catch {
      return null;
    }
  }
  try {
    return createGitHubTokenProvider({
      auth: runtime.githubAuth,
      access,
      oauthClientId: runtime.oauthClientId,
      repo: `${repository.owner}/${repository.repo}`,
      home: env.home,
      env: process.env,
      appId: env.githubAppId,
      installationId: env.githubAppInstallationId,
      privateKeyPem,
      client: createFetchGitHubClient(),
    });
  } catch {
    return null;
  }
}

export function createLinearGitHubAuth(input: {
  runtime: RuntimeConfig;
  env: EnvSource;
  resolveApp?: (repository: string) => ActiveGitHubApp;
  repositoryForItem: (item: WorkItemRecord) => RepositoryBinding | null;
  actorForItem: (item: WorkItemRecord) => string | null;
  authorizeItem?: (
    item: WorkItemRecord,
    signal: AbortSignal,
    repository: RepositoryBinding,
  ) => Promise<boolean>;
  integrationIdentity?: (item: WorkItemRecord) => string;
  currentIntegrationItem?: (item: WorkItemRecord) => boolean;
  administratorsForItem?: (item: WorkItemRecord) => readonly string[];
  accessForItem?: (item: WorkItemRecord) => "read" | "write";
  attributionReady?: (item: WorkItemRecord) => Promise<boolean>;
}): HostGitHubAuth {
  const loginFor = (item: WorkItemRecord) => {
    const repository = input.repositoryForItem(item);
    if (repository === null) throw new Error("Choose a GitHub repository before signing in.");
    return createVerifiedGitHubLogin({
      auth: input.runtime.githubAuth,
      home: input.runtime.env.home,
      env: input.env,
      repo: `${repository.owner}/${repository.repo}`,
      oauthClientId: input.runtime.oauthClientId,
    });
  };
  const installation = createGitHubInstallationCheck({
    home: input.runtime.env.home,
    env: input.env,
    ...(input.resolveApp ? { resolve: input.resolveApp } : {}),
  });
  return {
    ...(input.runtime.githubAuth === "app"
      ? {
          integration: {
            recoveryUrl: `${input.runtime.publicUrl ?? "http://127.0.0.1:8787"}/status#/settings`,
            administrators: input.administratorsForItem ?? (() => []),
            current: input.currentIntegrationItem ?? (() => true),
            identity:
              input.integrationIdentity ??
              ((item) => JSON.stringify([input.actorForItem(item), input.repositoryForItem(item)])),
            authorize: async (item: WorkItemRecord, signal: AbortSignal) => {
              const selected = input.repositoryForItem(item);
              return (
                selected !== null &&
                (!input.authorizeItem || (await input.authorizeItem(item, signal, selected)))
              );
            },
            attributionReady: input.attributionReady,
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
          },
        }
      : {}),
    ...(input.runtime.githubAuth === "gh"
      ? {
          externalLogin: true,
          recoveryMessage:
            "Run gh auth login on the Paws host using your original GitHub account, then reply here to continue.",
        }
      : {}),
    owner: input.actorForItem,
    linkedAccount: (item) =>
      input.runtime.githubAuth === "gh" ? Promise.resolve(null) : loginFor(item).linkedAccount(),
    async check(item, signal) {
      if (input.runtime.githubAuth !== "gh") return loginFor(item).check(signal);
      const repository = input.repositoryForItem(item);
      if (repository === null) return null;
      const provider = authProvider(input.runtime, repository, input.accessForItem?.(item));
      const user = await provider?.user().catch(() => null);
      signal.throwIfAborted();
      return user ?? null;
    },
    begin: (item, options) => {
      if (input.runtime.githubAuth === "gh")
        return Promise.reject(new Error("Use the existing GitHub CLI host login."));
      return loginFor(item).begin(options);
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
  if (command === "doctor") {
    process.exit(await doctorMain());
  }
  if (command === "setup") {
    process.exit(await runSetup(argv, { linearReconnect: createLinearReconnect() }));
  }
  if (command === "login" && argv[1] === "github") {
    process.exit(await loginGitHubCommand(argv.slice(2)));
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
  if (command === "logout") {
    process.exit(await logoutGitHubCommand());
  }
  if (command === "login") {
    console.error("usage: paws login github | paws login slack");
    process.exit(1);
  }
  const unknown = argv.find((arg) => arg !== "--no-tunnel");
  if (unknown) {
    console.error(`Unknown option ${unknown}.`);
    process.exit(1);
  }
  const paws = startPaws(process.env, {
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

async function loginGitHubCommand(args: readonly string[]): Promise<number> {
  try {
    const runtime = loadRuntime(process.env);
    let auth = runtime.githubAuth;
    let repo = runtime.repo;
    for (let index = 0; index < args.length; index += 1) {
      const arg = args[index];
      if (arg === "--app") auth = "app";
      else if (arg === "--repo") {
        const value = args[++index];
        if (!value || value.startsWith("--")) throw new Error("--repo needs owner/name.");
        repo = value;
      } else throw new Error(`Unknown GitHub login flag ${arg}.`);
    }
    await loginGitHub({
      auth,
      repo,
      env: process.env,
      home: runtime.env.home,
      oauthClientId: runtime.oauthClientId,
    });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "GitHub login failed");
    return 1;
  }
}

async function logoutGitHubCommand(): Promise<number> {
  try {
    const runtime = loadRuntime(process.env);
    await logoutGitHub({ env: process.env, home: runtime.env.home });
    return 0;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "GitHub logout failed");
    return 1;
  }
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
