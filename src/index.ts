import { loginSlack, readSlackApp } from "./slack";
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
  pawsPaths,
  type EnvSource,
  type PawsEnv,
  type PawsPaths,
  type RuntimeConfig,
} from "./config";
import {
  transitionEpic,
  WORK_ITEM_STATES,
  type Clock,
  type EpicState,
  type LinearCommand,
} from "./core";
import {
  assertLinearQueue,
  enqueueCommand,
  listWorkItemsByStates,
  migrate,
  openDatabase,
  prepareShutdown,
  recoverOnStartup,
  recordGitHubDelivery,
  startLoops,
  submitCommand,
} from "./db";
import { doctorChecks, formatDoctor, realProbe } from "./doctor";
import {
  createGitHubTokenProvider,
  loginGitHub,
  logoutGitHub,
  type GitHubTokenProvider as AuthTokenProvider,
} from "./auth";
import {
  createGitHubIssuesClient,
  githubIssueKey,
  githubTrackerConfig,
  loadGitHubEpic,
  parseGitHubIssueKey,
  type FetchLike,
  type GitHubIssuesClient,
} from "./ghissues";
import {
  createGitHubCommentTracker,
  type GitHubCommentRequest,
  type GitHubCommentTracker,
} from "./ghcomments";
import { createFetchGitHubClient, githubHttpsUrl, type GitHubTokenProvider } from "./github";
import { startHost } from "./host";
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
  itemPathId,
  worktreeBranch,
  type GitHubBinding,
  type Orchestrator,
  type RepositoryBinding,
} from "./loop";
import { loginDocker, startAllowProxy, type AllowProxy } from "./sandbox";
import { startServer } from "./server";
import { runSetup } from "./setup";
import { findOpenQuestion, type StoredQuestion } from "./questions";

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
  if (runtime.configError !== null) throw new Error(runtime.configError);
  const env = { ...runtime.env, host: LOOPBACK };
  const paths = pawsPaths(env.home);
  assertLinearQueue(paths.db);
  ensureLayout(paths);
  const db = openDatabase(paths.db);
  migrate(db);
  recoverOnStartup(db);
  const abort = new AbortController();
  let orchestrator: Orchestrator | null = null;
  const repository = repositoryBinding(runtime.repo);
  const auth = repository === null ? null : authProvider(runtime, repository);
  const github = githubBinding(auth);
  const webhooks = runtime.webhooks;
  const channel: "comments" | "agent-session" =
    runtime.linearMode === "agent-session" ? "agent-session" : "comments";
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
    githubWebhook: { accept: (delivery) => recordGitHubDelivery(db, delivery) },
    slackSigningSecret:
      envSource.SLACK_SIGNING_SECRET ?? readSlackApp(paths.home)?.signingSecret ?? null,
    linearWebhook: linear?.webhook ?? (webhooks ? { store: inbox } : undefined),
    webhooks: webhooks || env.githubWebhookSecret !== null,
    db,
    statusEnv: envSource,
    closeoutHome: paths.home,
    agentSettings: {
      configPath: paths.configFile,
      repos: runtime.repo ? [runtime.repo] : [],
      probe: (profile) =>
        probeAgentProfile({
          profile,
          pawsRoot: paths.home,
          worktree: paths.home,
          signal: abort.signal,
        }),
    },
  });

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
        catchUp: async () => {
          await running.catchUp();
        },
        repository,
        github,
        channel,
        caps: { maxTurns: runtime.maxTurns, maxAwakeMs: runtime.maxAwakeMs },
        ...(docker ? { docker } : {}),
      });
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
        itemId: itemPathId(item),
        wipBranch: worktreeBranch(item),
      });
    },
  });

  return {
    env,
    paths,
    db,
    server,
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
      abort.abort();
      host.stop();
      loops.stop();
      prepareShutdown(db, Date.now(), (item) => {
        commitCheckpointSync(worktreePath(paths.home, itemPathId(item)));
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

function authProvider(
  runtime: RuntimeConfig,
  repository: RepositoryBinding,
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
  if (command === "doctor") {
    process.exit(await doctorMain());
  }
  if (command === "setup") {
    process.exit(await runSetup(argv));
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
    const agent = argv[1];
    if ((agent !== "claude" && agent !== "codex") || !argv.includes("--docker")) {
      console.error(
        "usage: paws login github | paws login slack | paws login <claude|codex> --docker",
      );
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

/** One signed-in provider, shared by issues, comments, and git. */
export function gitHostToken(provider: AuthTokenProvider): GitHubTokenProvider {
  return {
    mode: provider.source,
    tokenFor: () => provider.token(),
  };
}

export function openGitHubWork(options: {
  provider: AuthTokenProvider;
  owner: string;
  repo: string;
  repos?: readonly string[];
  triggerLabel?: string;
  mention?: string;
  trusted?: readonly string[];
  labels?: boolean;
  fetch?: FetchLike;
  baseUrl?: string;
  clock?: Clock;
}): { client: GitHubIssuesClient; comments: GitHubCommentTracker; tracker: TrackerAdapter } {
  const repos =
    options.repos !== undefined && options.repos.length > 0
      ? [...options.repos]
      : [`${options.owner}/${options.repo}`];
  const client = createGitHubIssuesClient({
    provider: options.provider,
    config: githubTrackerConfig({
      ...(options.triggerLabel === undefined ? {} : { trigger_label: options.triggerLabel }),
      ...(options.mention === undefined ? {} : { mention: options.mention }),
      ...(options.trusted === undefined ? {} : { trusted: options.trusted }),
      repos,
    }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
  });
  const request = githubCommentRequest(options.provider, options.fetch, options.baseUrl);
  const comments = createGitHubCommentTracker({
    request,
    owner: options.owner,
    repo: options.repo,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.trusted === undefined ? {} : { trustedAssociations: options.trusted }),
    ...(options.labels === false ? { labels: false } : {}),
  });
  const tracker: TrackerAdapter = {
    async loadEpic(id) {
      comments.bind({ itemId: id, issueId: id, sessionId: id });
      return loadGitHubEpic(client, requireGitHubIssue(id));
    },
    async listDeps(id) {
      const ref = requireGitHubIssue(id);
      const blockers = await client.listBlockedBy({ owner: ref.owner, repo: ref.repo }, ref.number);
      return blockers
        .filter((issue) => !issue.pullRequest)
        .map((issue) => ({
          blockerLinearIssueId: githubIssueKey(issue.owner, issue.repo, issue.number),
          blockedLinearIssueId: id,
        }));
    },
    async postProgress(update) {
      await comments.postProgress(update);
      if (update.body.includes("Epic complete.")) await closeGitHubIssue(request, update.sessionId);
    },
    askQuestion: (question) => comments.askQuestion(question),
    setStatus: (update) => comments.setStatus(update),
  };
  return { client, comments, tracker };
}

export function githubCreatedEvent(issueId: string, updatedAtMs: number): AcceptedLinearEvent {
  return {
    dedupeKey: `github:created:${issueId}`,
    deliveryId: null,
    source: "poll",
    action: "created",
    sessionId: issueId,
    issueId,
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs,
    payload: "{}",
  };
}

export async function ingestGitHubComments(
  comments: GitHubCommentTracker,
  issueId: string,
  deliver: (event: AcceptedLinearEvent) => Promise<void>,
  stop: (itemId: string, at: number) => void,
  pending?: StoredQuestion | null,
): Promise<void> {
  const result = await comments.sync(issueId, pending);
  for (const answer of result.resumed) {
    await deliver({
      dedupeKey: `github-answer:${answer.questionId}`,
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
    stop(stopped.itemId, stopped.requestedAt);
  }
}

export function createGitHubCommentIngestor(
  db: Database,
  comments: GitHubCommentTracker,
  deliver: (event: AcceptedLinearEvent) => Promise<void>,
  submit: (command: LinearCommand) => void,
): (issueId: string) => Promise<void> {
  return (issueId) => {
    comments.bind({ itemId: issueId, issueId, sessionId: issueId });
    return ingestGitHubComments(
      comments,
      issueId,
      deliver,
      (_key, requestedAt) => {
        const epic = db
          .query<{ id: string; state: EpicState }, [string]>(
            "SELECT id, state FROM epic WHERE linear_issue_id = ?",
          )
          .get(issueId);
        if (epic !== null) {
          const cancelled = transitionEpic(epic.state, "cancel");
          if (cancelled.ok) {
            db.run("UPDATE epic SET state = ?, version = version + 1 WHERE id = ? AND state = ?", [
              cancelled.to,
              epic.id,
              epic.state,
            ]);
          }
        }
        const targets = db
          .query<{ id: string }, [string, string]>(
            `SELECT work_item.id FROM work_item
           JOIN epic ON epic.id = work_item.epic_id
           WHERE work_item.state NOT IN ('merged', 'cancelled')
             AND (work_item.linear_issue_id = ? OR epic.linear_issue_id = ?)
           ORDER BY work_item.position, work_item.id`,
          )
          .all(issueId, issueId);
        for (const { id } of targets) {
          submit({ type: "stop", itemId: id, source: "linear", requestedAt });
        }
      },
      findOpenQuestion(db, issueId),
    );
  };
}

function githubCommentRequest(
  provider: AuthTokenProvider,
  fetchImpl: FetchLike = fetch,
  baseUrl = "https://api.github.com",
): GitHubCommentRequest {
  const root = baseUrl.replace(/\/$/, "");
  return async (input) => {
    const token = await provider.token();
    const response = await fetchImpl(`${root}${input.path}`, {
      method: input.method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "paws",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(input.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: input.body === undefined ? undefined : JSON.stringify(input.body),
    });
    const text = await response.text();
    let body: unknown = {};
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = {};
      }
    }
    return { status: response.status, body, link: response.headers.get("link") };
  };
}

async function closeGitHubIssue(request: GitHubCommentRequest, issueId: string): Promise<void> {
  const ref = parseGitHubIssueKey(issueId);
  if (ref === null) return;
  const closed = await request({
    method: "PATCH",
    path: `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}/issues/${ref.number}`,
    body: { state: "closed" },
  });
  if (closed.status !== 200) {
    throw new Error(`closing GitHub issue #${ref.number} failed with status ${closed.status}`);
  }
}

function requireGitHubIssue(id: string): { owner: string; repo: string; number: number } {
  const ref = parseGitHubIssueKey(id);
  if (ref === null) throw new Error(`invalid GitHub issue id: ${id}`);
  return ref;
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
