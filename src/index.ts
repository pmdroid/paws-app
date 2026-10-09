import { readFileSync } from "node:fs";
import type { Database } from "bun:sqlite";
import {
  ensureLayout,
  loadEnv,
  pawsPaths,
  type EnvSource,
  type PawsEnv,
  type PawsPaths,
} from "./config";
import { migrate, openDatabase, prepareShutdown, recoverOnStartup, startLoops } from "./db";
import { doctorChecks, formatDoctor, realProbe } from "./doctor";
import { createFetchGitHubClient, githubHttpsUrl } from "./github";
import { startHost } from "./host";
import { openLinear } from "./linear";
import {
  attachOrchestrator,
  type GitHubBinding,
  type Orchestrator,
  type RepositoryBinding,
} from "./loop";
import { startServer } from "./server";

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
};

/** Open ~/.paws, migrate, recover in-flight work, and listen. Linear intake runs when a token is configured. */
export function startPaws(source?: EnvSource, options?: StartOptions): PawsProcess {
  const env = loadEnv(source);
  const paths = pawsPaths(env.home);
  ensureLayout(paths);
  const db = openDatabase(paths.db);
  migrate(db);
  recoverOnStartup(db);
  const abort = new AbortController();
  let orchestrator: Orchestrator | null = null;
  const linear = openLinear({
    db,
    secretsDir: paths.secretsDir,
    env: source ?? process.env,
    publicUrl: env.publicUrl,
    noTunnel: options?.noTunnel,
    followUp: async (event) => {
      if (orchestrator === null) throw new Error("loop is not attached");
      await orchestrator.onLinearEvent(event);
    },
  });
  const server = startServer({
    hostname: env.host,
    port: env.port,
    linearWebhookSecret: env.linearWebhookSecret,
    githubWebhookSecret: env.githubWebhookSecret,
    linearWebhook: linear.webhook,
  });
  const running = linear.start(server.port ?? env.port);
  const loops = startLoops({
    db,
    signal: abort.signal,
    prepare(created) {
      orchestrator = attachOrchestrator({
        db,
        jobs: created.jobs,
        outbox: created.outbox,
        pawsRoot: paths.home,
        tracker: linear.tracker,
        catchUp: () => running.catchUp(),
        repository: repositoryBinding(env),
        github: githubBinding(env),
      });
    },
  });
  const host = startHost({
    db,
    signal: abort.signal,
    agentAlive: (runId) => orchestrator?.agentAlive(runId) ?? false,
  });
  return {
    env,
    paths,
    db,
    server,
    catchUp: running.catchUp,
    tunnelUp: running.tunnelUp,
    tunnelRequested: running.tunnelRequested,
    tunnelUrl: running.tunnelUrl,
    stop() {
      abort.abort();
      host.stop();
      loops.stop();
      prepareShutdown(db);
      running.stop();
      server.stop(true);
      db.close();
    },
  };
}

function repositoryBinding(env: PawsEnv): RepositoryBinding | null {
  const value = env.githubRepository;
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

function githubBinding(env: PawsEnv): GitHubBinding | null {
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

async function doctorMain(): Promise<number> {
  const checks = doctorChecks(realProbe(process.env));
  console.log(formatDoctor(checks));
  return checks.every((item) => item.ok) ? 0 : 1;
}

if (import.meta.main) {
  if (process.argv.includes("doctor")) {
    const code = await doctorMain();
    process.exit(code);
  }
  const paws = startPaws(process.env, { noTunnel: process.argv.includes("--no-tunnel") });
  const tunnel =
    paws.tunnelRequested && paws.tunnelUrl !== null ? ` · tunnel ${paws.tunnelUrl}` : "";
  console.log(`paws ready · http://${paws.server.hostname}:${paws.server.port}${tunnel}`);
  const shutdown = () => {
    paws.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
