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
import { startHost } from "./host";
import { intakeDelegatedIssue } from "./intake";
import { openLinear } from "./linear";
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
  const loops = startLoops({ db, signal: abort.signal });
  const host = startHost({ db, signal: abort.signal });
  const linear = openLinear({
    db,
    secretsDir: paths.secretsDir,
    env: source ?? process.env,
    publicUrl: env.publicUrl,
    noTunnel: options?.noTunnel,
    followUp: async (event, tracker) => {
      if (event.issueId === null) return;
      await intakeDelegatedIssue(db, tracker, {
        linearIssueId: event.issueId,
        sessionId: event.sessionId,
      });
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

if (import.meta.main) {
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
