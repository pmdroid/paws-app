import type { Database } from "bun:sqlite";
import {
  doctorReport,
  ensureLayout,
  formatDoctor,
  loadEnv,
  pawsPaths,
  type EnvSource,
  type PawsEnv,
  type PawsPaths,
} from "./config";
import {
  migrate,
  openDatabase,
  prepareShutdown,
  readEngineSnapshot,
  recoverOnStartup,
  startLoops,
} from "./db";
import { startHost } from "./host";
import { intakeDelegatedIssue } from "./intake";
import { openLinear } from "./linear";
import { startServer } from "./server";
import type { StatusReport } from "./web";

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
  const host = startHost({ db, signal: abort.signal, sleepLogic: !env.hosted });
  const linear = openLinear({
    db,
    secretsDir: paths.secretsDir,
    env: source ?? process.env,
    publicUrl: env.publicUrl,
    noTunnel: options?.noTunnel === true || env.hosted,
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
    hosted: env.hosted,
    dashboardToken: env.dashboardToken,
    statusProvider: () => engineStatus(db, env),
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

function engineStatus(db: Database, env: PawsEnv): StatusReport {
  const snap = readEngineSnapshot(db);
  return {
    ok: true,
    source: "engine",
    service: "paws",
    mode: env.mode,
    now: new Date(snap.now).toISOString(),
    publicUrl: env.publicUrl,
    listener: { host: env.host, port: env.port },
    counts: snap.counts,
    items: snap.items,
    runs: snap.runs,
  };
}

if (import.meta.main) {
  if (process.argv[2] === "doctor") {
    const report = doctorReport(process.env);
    console.log(formatDoctor(report));
    process.exit(report.ok ? 0 : 1);
  }
  const paws = startPaws(process.env, { noTunnel: process.argv.includes("--no-tunnel") });
  const tunnel =
    paws.tunnelRequested && paws.tunnelUrl !== null ? ` · tunnel ${paws.tunnelUrl}` : "";
  const hosted = paws.env.hosted ? " · hosted" : "";
  const pub = paws.env.publicUrl !== null ? ` · ${paws.env.publicUrl}` : "";
  console.log(
    `paws ready · http://${paws.server.hostname}:${paws.server.port}${hosted}${tunnel}${pub}`,
  );
  const shutdown = () => {
    paws.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
