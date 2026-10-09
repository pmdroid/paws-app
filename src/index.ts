import {
  ensureLayout,
  loadEnv,
  pawsPaths,
  type EnvSource,
  type PawsEnv,
  type PawsPaths,
} from "./config";
import { migrate, openDatabase } from "./db";
import { startServer } from "./server";
import type { Database } from "bun:sqlite";

export type PawsProcess = {
  env: PawsEnv;
  paths: PawsPaths;
  db: Database;
  server: Bun.Server<undefined>;
  stop: () => void;
};

/** Open ~/.paws, migrate, and listen. Adapters stay unwired until their issues land. */
export function startPaws(source?: EnvSource): PawsProcess {
  const env = loadEnv(source);
  const paths = pawsPaths(env.home);
  ensureLayout(paths);
  const db = openDatabase(paths.db);
  migrate(db);
  const server = startServer({
    hostname: env.host,
    port: env.port,
    linearWebhookSecret: env.linearWebhookSecret,
    githubWebhookSecret: env.githubWebhookSecret,
  });
  return {
    env,
    paths,
    db,
    server,
    stop() {
      server.stop(true);
      db.close();
    },
  };
}

if (import.meta.main) {
  const paws = startPaws();
  console.log(`paws ready · http://${paws.server.hostname}:${paws.server.port}`);
  const shutdown = () => {
    paws.stop();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}
