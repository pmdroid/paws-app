import { readFileSync } from "node:fs";
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
  ensureLayout,
  loadRuntime,
  pawsPaths,
  type EnvSource,
  type PawsEnv,
  type PawsPaths,
  type RuntimeConfig,
} from "./config";
import { WORK_ITEM_STATES, type LinearCommand } from "./core";
import {
  enqueueCommand,
  listWorkItemsByStates,
  migrate,
  openDatabase,
  prepareShutdown,
  recoverOnStartup,
  startLoops,
  submitCommand,
} from "./db";
import { doctorChecks, formatDoctor, realProbe } from "./doctor";
import { createFetchGitHubClient, createGhCliAuth, githubHttpsUrl } from "./github";
import { startHost } from "./host";
import { closeoutBinPath, grokLoginStatus } from "./install";
import {
  createInboxStore,
  createIntakePollSource,
  createLinearTracker,
  openLinear,
  startCatchUpPoller,
  type AcceptedLinearEvent,
  type LinearRunning,
  type TrackerAdapter,
} from "./linear";
import {
  attachOrchestrator,
  type GitHubBinding,
  type Orchestrator,
  type RepositoryBinding,
} from "./loop";
import { loginDocker, startAllowProxy, type AllowProxy } from "./sandbox";
import { startServer } from "./server";
import { runSetup } from "./setup";

export type PawsProcess = {
  env: PawsEnv;
  paths: PawsPaths;
  db: Database;
  server: Bun.Server<undefined>;
  catchUp: () => Promise<void>;
  tunnelUp: () => boolean;
  tunnelRequested: boolean;
  tunnelUrl: string | null;
  stop: () => void;
};

export type StartOptions = {
  noTunnel?: boolean;
  /** Run ACP adapters in the sandbox. `proxyUrl` is the allow-list proxy. */
  docker?: boolean;
  proxyUrl?: string | null;
  sandboxImage?: string;
};

const LOOPBACK = "127.0.0.1";

/** Open ~/.paws, migrate, recover in-flight work, and listen on 127.0.0.1. */
export function startPaws(source?: EnvSource, options?: StartOptions): PawsProcess {
  const envSource = source ?? process.env;
  const runtime = loadRuntime(envSource);
  const env = { ...runtime.env, host: LOOPBACK };
  const paths = pawsPaths(env.home);
  ensureLayout(paths);
  const db = openDatabase(paths.db);
  migrate(db);
  recoverOnStartup(db);
  const abort = new AbortController();
  let orchestrator: Orchestrator | null = null;
  const repository = repositoryBinding(runtime.repo);
  const github = githubBinding(runtime, repository);
  const closeoutBin = runtime.closeoutBin ?? closeoutBinPath(paths.home);
  const webhooks = runtime.webhooks;
  const channel = runtime.linearMode;
  const docker = sandboxOptions(options);
  const inbox = createInboxStore(db);

  const followUp = async (event: AcceptedLinearEvent): Promise<void> => {
    if (orchestrator === null) throw new Error("loop is not attached");
    await orchestrator.onLinearEvent(event);
  };
  const submit = (command: LinearCommand): void => {
    if (orchestrator === null) {
      enqueueCommand(db, command);
      return;
    }
    submitCommand(db, orchestrator.bus, command);
  };

  const linear =
    channel === "agent-session"
      ? openLinear({
          db,
          secretsDir: paths.secretsDir,
          env: linearEnv(runtime, envSource),
          publicUrl: runtime.publicUrl,
          noTunnel: !webhooks || options?.noTunnel === true,
          webhooks,
          followUp,
          submitCommand: submit,
        })
      : null;

  const server = startServer({
    hostname: LOOPBACK,
    port: env.port,
    linearWebhookSecret: env.linearWebhookSecret,
    githubWebhookSecret: env.githubWebhookSecret,
    linearWebhook: linear?.webhook ?? (webhooks ? { store: inbox } : undefined),
    webhooks,
    db,
    statusEnv: envSource,
  });

  let running: LinearRunning = linear ? linear.start(server.port ?? env.port) : down();

  const comment = channel === "comments" ? openComments(runtime) : null;
  const loops = startLoops({
    db,
    signal: abort.signal,
    prepare(created) {
      const attached = attachOrchestrator({
        db,
        jobs: created.jobs,
        outbox: created.outbox,
        pawsRoot: paths.home,
        tracker: linear?.tracker ?? comment?.tracker ?? null,
        catchUp: () => running.catchUp(),
        repository,
        github,
        closeoutBin,
        channel,
        caps: { maxTurns: runtime.maxTurns, maxAwakeMs: runtime.maxAwakeMs },
        ...(docker ? { docker } : {}),
      });
      if (comment !== null) attached.setTracker(commentTracker(db, comment.tracker, comment.mode));
      orchestrator = attached;
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
      stop() {
        poller.stop();
      },
    };
  }

  const host = startHost({
    db,
    signal: abort.signal,
    agentAlive: (runId) => orchestrator?.agentAlive(runId) ?? false,
    restartFromMain: (item) => {
      if (repository === null) return;
      restartFromFreshMain({
        pawsRoot: paths.home,
        owner: repository.owner,
        repo: repository.repo,
        itemId: item.linearIdentifier,
        wipBranch: item.branchName,
      });
    },
  });

  return {
    env,
    paths,
    db,
    server,
    catchUp: () => running.catchUp(),
    tunnelUp: () => running.tunnelUp(),
    get tunnelRequested() {
      return running.tunnelRequested;
    },
    get tunnelUrl() {
      return running.tunnelUrl;
    },
    stop() {
      abort.abort();
      host.stop();
      loops.stop();
      prepareShutdown(db, Date.now(), (item) => {
        commitCheckpointSync(worktreePath(paths.home, item.linearIdentifier));
      });
      running.stop();
      server.stop(true);
      db.close();
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

function commentTracker(db: Database, base: TrackerAdapter, mode: CommentMode): TrackerAdapter {
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

async function syncComments(
  db: Database,
  mode: CommentMode,
  orchestrator: Orchestrator,
): Promise<void> {
  const items = listWorkItemsByStates(db, WORK_ITEM_STATES);
  const issues = new Set(items.map((item) => item.linearIssueId));
  for (const issueId of issues) {
    const match = items.find((item) => item.linearIssueId === issueId);
    if (match === undefined) continue;
    mode.bind({ itemId: match.id, linearIssueId: issueId, sessionId: issueId });
    const result = await mode.sync(issueId);
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
        payload: "{}",
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
    stop() {},
  };
}

function sandboxOptions(
  options: StartOptions | undefined,
): { proxyUrl: string; image?: string } | undefined {
  if (options?.docker !== true || options.proxyUrl === null || options.proxyUrl === undefined) {
    return undefined;
  }
  return {
    proxyUrl: options.proxyUrl,
    ...(options.sandboxImage ? { image: options.sandboxImage } : {}),
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

function githubBinding(
  runtime: RuntimeConfig,
  repository: RepositoryBinding | null,
): GitHubBinding | null {
  if (repository === null) return null;
  if (runtime.githubAuth === "app") {
    const env = runtime.env;
    if (
      env.githubAppId === null ||
      env.githubAppInstallationId === null ||
      env.githubAppPrivateKeyPath === null
    ) {
      return null;
    }
    try {
      return {
        appId: env.githubAppId,
        installationId: env.githubAppInstallationId,
        privateKeyPem: readFileSync(env.githubAppPrivateKeyPath, "utf8"),
        client: createFetchGitHubClient(),
      };
    } catch {
      return null;
    }
  }
  return {
    appId: "",
    installationId: "",
    privateKeyPem: "",
    client: createFetchGitHubClient(),
    tokenProvider: createGhCliAuth({ owner: repository.owner, repo: repository.repo }),
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
  const runtime = loadRuntime(process.env);
  const agents = runtime.file.agents;
  const grok =
    agents.implementer === "grok" ? await grokLoginStatus({ env: process.env, agents }) : null;
  const checks = doctorChecks(await realProbe(process.env), { config: { agents }, grok });
  console.log(formatDoctor(checks));
  return checks.every((item) => item.ok) ? 0 : 1;
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  const command = argv[0];
  if (command === "doctor") {
    process.exit(await doctorMain());
  }
  if (command === "setup") {
    process.exit(await runSetup(argv));
  }
  if (command === "login") {
    const agent = argv[1];
    if ((agent !== "claude" && agent !== "codex") || !argv.includes("--docker")) {
      console.error("usage: paws login <claude|codex> --docker");
      process.exit(1);
    }
    try {
      await loginDocker(agent);
    } catch (error) {
      console.error(error instanceof Error ? error.message : "docker login failed");
      process.exit(1);
    }
    process.exit(0);
  }
  const docker = argv.includes("--docker");
  let proxy: AllowProxy | null = null;
  if (docker) proxy = await startAllowProxy({ host: "0.0.0.0" });
  const paws = startPaws(process.env, {
    noTunnel: argv.includes("--no-tunnel"),
    docker,
    proxyUrl: proxy === null ? null : `http://host.docker.internal:${proxy.port}`,
  });
  const shutdown = () => {
    paws.stop();
    void proxy?.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  const origin = `http://${paws.server.hostname}:${paws.server.port}`;
  const tunnel =
    paws.tunnelRequested && paws.tunnelUrl !== null ? ` · tunnel ${paws.tunnelUrl}` : "";
  // One write so a piped reader cannot observe the ready line before the dashboard line exists.
  console.log(`paws ready · ${origin}${tunnel}\ndashboard ${origin}/status`);
}
