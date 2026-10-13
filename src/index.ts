import { runRunnerCli } from "./runner-cli";
import { join } from "node:path";
import { createSlackIdentityReads, loginSlack, readSlackApp } from "./slack";
import { readSecretFile } from "./credentials";
import type { Database } from "bun:sqlite";
import { commitCheckpointSync, probeAgentProfile, restartFromFreshMain, worktreePath } from "./acp";
import {
  createCommentMode,
  createLinearCommentBoard,
  createPersonalLinearClient,
  withCommentActivities,
  type CommentMode,
} from "./comments";
import {
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
import { WORK_ITEM_STATES, type LinearCommand } from "./core";
import {
  assertLinearQueue,
  enqueueCommand,
  enqueueJob,
  isLinearAppRevoked,
  getLinearSessionAccess,
  getTaskLinearActor,
  getWorkItemRepository,
  getWorkItemRepositoryChoice,
  getWorkItemRepositoryAnswer,
  getTaskMode,
  taskRequiresRepository,
  listWorkItemsByStates,
  listWorkItems,
  linearSessionForEpic,
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
  loginGitHub,
  logoutGitHub,
  type GitHubTokenProvider as AuthTokenProvider,
} from "./auth";
import {
  checkRepositoryWriteAccess,
  checkRepositoryReadAccess,
  createFetchGitHubClient,
  createGitHubApp,
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
  handleLinearAdministration,
  refreshLinearNotificationContext,
  type Orchestrator,
  type RepositoryBinding,
  type HostGitHubAuth,
} from "./loop";
import { startServer } from "./server";
import { runSetup } from "./setup";
import { createLinearReconnect } from "./linear-reconnect";
import { findOpenQuestion } from "./questions";
import { loadPublicTls, validatePublicTls, PUBLIC_TLS_RESTART_EXIT } from "./deployment";
import {
  issueVerifiedWorkspaceBootstrap,
  startWorkspaceAccess,
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
  runnerRepositoryAccess?: RunnerRepositoryAccessOptions;
  runnerTranscriptObjects?: RunnerTranscriptObjects;
};

const LOOPBACK = "127.0.0.1";

/** Open ~/.paws, migrate, recover in-flight work, and listen on 127.0.0.1. */
export function startPaws(source?: EnvSource, options?: StartOptions): PawsProcess {
  const envSource = source ?? process.env;
  const runtime = loadRuntime(envSource);
  if (runtime.configError !== null) throw new Error(runtime.configError);
  const transcriptObjects =
    options?.runnerTranscriptObjects ??
    (envSource.PAWS_EXECUTION === "remote"
      ? loadRunnerTranscriptObjects(runtime.env.home)
      : undefined);
  const publicDashboard = envSource.PAWS_PUBLIC_DASHBOARD === "1";
  const tls = publicDashboard ? validatePublicTls(envSource) : loadPublicTls(envSource);
  const runnerConfig = loadRunnerControl(envSource, runtime.env);
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
  const env = { ...runtime.env, host: publicDashboard ? runtime.env.host : LOOPBACK };
  const paths = pawsPaths(env.home);
  assertLinearQueue(paths.db);
  ensureLayout(paths);
  const db = openDatabase(paths.db);
  migrate(db);
  recoverOnStartup(db);
  const abort = new AbortController();
  let orchestrator: Orchestrator | null = null;
  const repository = repositoryBinding(runtime.repo);
  const repositories = [runtime.repo, ...runtime.file.githubRepos]
    .map(repositoryBinding)
    .filter((value): value is RepositoryBinding => value !== null);
  const auth = repository === null ? null : authProvider(runtime, repository);
  const github = githubBinding(auth);
  const webhooks = runtime.webhooks;
  const channel: "comments" | "agent-session" =
    runtime.linearMode === "agent-session" ? "agent-session" : "comments";
  const inbox = createInboxStore(db);

  const followUp = async (event: AcceptedLinearEvent): Promise<void | boolean> => {
    if (orchestrator === null) throw new Error("loop is not attached");
    return orchestrator.onLinearEvent(event);
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
  const stopLinearSession = (sessionId: string): void => {
    for (const item of listWorkItems(db)) {
      if ((item.sessionKey ?? linearSessionForEpic(db, item.epicId)) !== sessionId) continue;
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
                  await linearTaskAccess.reconcile(notification.issueId);
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
      workspace = startWorkspaceAccess({
        slackIdentities: createSlackIdentityReads({ home: paths.home, db }),
        db,
        publicUrl: runtime.publicUrl!,
        clientId: runtime.linearClientId!,
        memberships: linear.memberships,
        verifyTeam: (id, signal) => linear.access!.team(id, { signal }),
        onError: () => console.error("Paws workspace access refresh failed."),
      });
    } catch (error) {
      abort.abort();
      db.close();
      throw error;
    }
  }
  let runner: RunnerCoordinator | undefined;
  let runnerStopping = false;
  const runnerReady =
    runnerConfig === null
      ? Promise.resolve(undefined)
      : openRunnerCoordinator({
          db,
          root: runnerConfig.root,
          hostname: runnerConfig.hostname,
          port: runnerConfig.port,
          tls: tls!,
          repositoryAccess: options?.runnerRepositoryAccess ?? runnerRepositoryAccess(runtime),
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
  async function stopRunner() {
    runnerStopping = true;
    await runnerReady.catch(() => {});
    await runner?.stop();
  }
  const ready = Promise.all([workspace?.access, runnerReady]).then(() => {
    if (runnerStopping) throw new Error("Paws is stopping.");
  });
  void ready.catch(() => {});
  let server: Bun.Server<undefined>;
  try {
    server = startServer({
      hostname: env.host,
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
            runnerControl: (request: Request, principal: WorkspacePrincipal) =>
              runner
                ? runner.browser(request, principal)
                : Promise.resolve(
                    Response.json({ error: "Runner control is starting." }, { status: 503 }),
                  ),
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
        probe: (profile) =>
          probeAgentProfile({
            profile,
            pawsRoot: paths.home,
            worktree: paths.home,
            signal: abort.signal,
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

  const comment = channel === "comments" ? openComments(runtime) : null;
  const tracker =
    comment !== null
      ? commentTracker(db, comment.tracker, comment.mode)
      : (linear?.tracker ?? null);
  const loops = startLoops({
    db,
    signal: abort.signal,
    prepare(created) {
      const attached = attachOrchestrator({
        db,
        jobs: created.jobs,
        outbox: created.outbox,
        pawsRoot: paths.home,
        tracker,
        linearTaskModes: true,
        linearAccess: linearTaskAccess ?? undefined,
        ...(workspace
          ? {
              authorizeLinearEvent: async (event) =>
                (await workspace.access).authorizeLinearEvent(event),
            }
          : {}),
        githubAuth:
          channel === "agent-session"
            ? createLinearGitHubAuth({
                runtime,
                env: envSource,
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
                actorForItem: (item) => getTaskLinearActor(db, item.id),
              })
            : undefined,
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
          const provider = authProvider(runtime, candidate, access);
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
          const provider = authProvider(runtime, candidate, access);
          if (!provider)
            throw new Error("GitHub sign-in is required before reading the repository.");
          const token = await provider.token();
          signal.throwIfAborted();
          return token;
        },
        github,
        githubForRepository: (selected) => githubBinding(authProvider(runtime, selected)),
        channel,
        caps: { maxTurns: runtime.maxTurns, maxAwakeMs: runtime.maxAwakeMs },
      });
      orchestrator = attached;
      if (channel === "agent-session") {
        created.jobs.register("github.auth.recover", () => attached.recoverGitHubAuth());
        enqueueJob(db, { queue: "github.auth.recover", priority: 0, now: Date.now() });
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
    signal: abort.signal,
    agentAlive: (runId) => orchestrator?.agentAlive(runId) ?? false,
    restartFromMain: (item) => {
      const selected = getWorkItemRepository(db, item.id) ?? repository;
      if (selected === null) return;
      restartFromFreshMain({
        pawsRoot: paths.home,
        owner: selected.owner,
        repo: selected.repo,
        itemId: itemPathId(item),
        wipBranch: worktreeBranch(item),
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
        await orchestrator?.shutdown();
        await Promise.all([loops.stop(), linearStopped, serverStopped]);
        await workspace?.stop();
        await stopRunner();
        prepareShutdown(db, Date.now(), (item) => {
          commitCheckpointSync(worktreePath(paths.home, itemPathId(item)));
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

function runnerRepositoryAccess(runtime: RuntimeConfig): RunnerRepositoryAccessOptions | undefined {
  const { githubAppId, githubAppInstallationId, githubAppPrivateKeyPath } = runtime.env;
  if (
    runtime.githubAuth !== "app" ||
    githubAppId === null ||
    githubAppInstallationId === null ||
    githubAppPrivateKeyPath === null
  )
    return undefined;
  return {
    github: {
      async mintInstallationToken(input) {
        const privateKeyPem = readSecretFile(githubAppPrivateKeyPath, false);
        if (privateKeyPem === null) throw new Error("GitHub App credentials are unavailable.");
        return createGitHubApp({
          client: createFetchGitHubClient(),
          appId: githubAppId,
          privateKeyPem,
        }).mintInstallationToken(input);
      },
    },
    installationForRepository: () => githubAppInstallationId,
  };
}

function authProvider(
  runtime: RuntimeConfig,
  repository: RepositoryBinding,
  access: "read" | "write" = "write",
): AuthTokenProvider | null {
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
  repositoryForItem: (item: WorkItemRecord) => RepositoryBinding | null;
  actorForItem: (item: WorkItemRecord) => string | null;
  accessForItem?: (item: WorkItemRecord) => "read" | "write";
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
  return {
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
