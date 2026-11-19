import { journal, journalCaught } from "./journal";
import { ensureRunnerCoordinator } from "./runner-coordinator";
import type { PawsProcess } from "./index";
import { ensureLayout, loadRunnerControl, pawsPaths, type RuntimeConfig } from "./config";
import { useDatabaseSecrets } from "./credentials";
import { workspaceOrganizationIds, type PawsStore } from "./db";
import { publicTlsProxy, type PublicTls } from "./deployment";
import { createBrowserOnboarding, setupToken as savedSetupToken } from "./onboarding";
import { startServer } from "./server";
import { isDashboardPage } from "./dashboard-links";

export async function startBrowserOnboarding(
  runtime: RuntimeConfig,
  tls: PublicTls | undefined,
  start: (server: Bun.Server<undefined>) => Promise<PawsProcess>,
  source: Record<string, string | undefined>,
  database: PawsStore,
  reconnect = false,
  setupPending = false,
): Promise<PawsProcess> {
  const paths = pawsPaths(runtime.env.home);
  ensureLayout(paths);
  const db = database.store;
  let setupSecrets: Awaited<ReturnType<typeof useDatabaseSecrets>> | undefined;
  let active: PawsProcess | undefined;
  let stopping = false;
  let switching: Promise<void> | undefined;
  let closed = false;
  let failed = false;
  const requests = new Set<Promise<Response>>();
  async function closeDatabase() {
    if (closed) return;
    closed = true;
    await setupSecrets?.close();
    await database.close();
  }
  const environmentClient = runtime.linearClientId !== null && !setupPending;
  const setupToken =
    !environmentClient || (!reconnect && (await workspaceOrganizationIds(db, 1)).length === 0)
      ? await savedSetupToken(paths.secretsDir)
      : undefined;
  if (setupToken) {
    if (runtime.databaseUrl === null)
      setupSecrets = await useDatabaseSecrets(db, paths.secretsDir, { copy: false });
    const setupUrl = runtime.publicUrl + "/setup?token=" + setupToken;
    journal(setupUrl);
    console.log(setupUrl);
  }
  const handle = createBrowserOnboarding({
    setupToken,
    db,
    home: paths.home,
    origin: runtime.publicUrl!,
    clientId: runtime.linearClientId,
    clientSecret: runtime.linearClientSecret,
    clientSecretOverride: source.LINEAR_CLIENT_SECRET?.trim() || undefined,
    environmentClient,
    expectedOrganizationId: runtime.linearOrganizationId,
    reconnect,
    async prepare() {
      const runner = loadRunnerControl(source, runtime.env);
      if (runner) await ensureRunnerCoordinator(runner.root);
    },
    installed() {
      setTimeout(() => {
        if (stopping || switching) return;
        switching = (async () => {
          await Promise.allSettled([...requests]);
          if (stopping) return;
          await closeDatabase();
          active = await start(server);
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
    ...(tls ? { tls } : {}),
    ...(publicTlsProxy(source) ? { proxy: true } : {}),
    onboarding(request, client) {
      const path = new URL(request.url).pathname;
      const page = isDashboardPage(path);
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
    get store() {
      return active?.store ?? db;
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
      await closeDatabase();
    },
  };
}
