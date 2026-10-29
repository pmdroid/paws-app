import { journalCaught } from "./journal";
import { existsSync } from "node:fs";
import { initializeRunnerCoordinator } from "./runner-coordinator";
import type { PawsProcess } from "./index";
import { ensureLayout, loadRunnerControl, pawsPaths, type RuntimeConfig } from "./config";
import { migrate, openDatabase } from "./db";
import type { PublicTls } from "./deployment";
import { createBrowserOnboarding } from "./onboarding";
import { startServer } from "./server";

export function startBrowserOnboarding(
  runtime: RuntimeConfig,
  tls: PublicTls,
  start: (server: Bun.Server<undefined>) => PawsProcess,
  source: Record<string, string | undefined>,
  reconnect = false,
): PawsProcess {
  const paths = pawsPaths(runtime.env.home);
  ensureLayout(paths);
  const db = openDatabase(paths.db);
  migrate(db);
  let active: PawsProcess | undefined;
  let stopping = false;
  let switching: Promise<void> | undefined;
  let closed = false;
  let failed = false;
  const requests = new Set<Promise<Response>>();
  function closeDatabase() {
    if (!closed) db.close();
    closed = true;
  }
  const handle = createBrowserOnboarding({
    db,
    home: paths.home,
    origin: runtime.publicUrl!,
    clientId: runtime.linearClientId,
    clientSecret: runtime.linearClientSecret,
    expectedOrganizationId: runtime.linearOrganizationId,
    reconnect,
    async prepare() {
      const runner = loadRunnerControl(source, runtime.env);
      if (runner && !existsSync(runner.root)) await initializeRunnerCoordinator(runner.root);
    },
    installed() {
      setTimeout(() => {
        if (stopping || switching) return;
        switching = (async () => {
          await Promise.allSettled([...requests]);
          if (stopping) return;
          closeDatabase();
          active = start(server);
          await active.ready;
        })().catch((caughtError1) => {
          journalCaught(caughtError1, "Paws could not start after Linear authorization.", null);
          failed = true;
        });
      }, 0);
    },
  });
  const server = startServer({
    hostname: runtime.env.host,
    port: runtime.env.port,
    tls,
    onboarding(request, client) {
      const path = new URL(request.url).pathname;
      const page = path === "/" || path === "/status" || path.startsWith("/status/");
      if (stopping || ((switching || failed) && !page))
        return Promise.resolve(
          Response.json({ error: "Paws is starting. Retry shortly." }, { status: 503 }),
        );
      const operation = handle(request, client);
      requests.add(operation);
      return operation.finally(() => requests.delete(operation));
    },
  });
  return {
    env: runtime.env,
    paths,
    server,
    get db() {
      return active?.db ?? db;
    },
    ready: Promise.resolve(),
    catchUp: async () => {
      await active?.catchUp();
    },
    async stop() {
      stopping = true;
      await switching;
      if (active) await active.stop();
      else await server.stop(true);
      await Promise.allSettled([...requests]);
      closeDatabase();
    },
  };
}
