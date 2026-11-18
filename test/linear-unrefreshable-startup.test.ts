import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { inArray } from "drizzle-orm";
import { migratedHome, storeHomeLinearToken, tempHome, withHomeStore } from "./helpers";
import { copyMigratedPglite } from "./pglite";
import { openPawsStore, type Db } from "../src/db";
import { createLinearReconnect } from "../src/onboarding";
import { createLinearAuth, openLinear, readStoredToken, writeStoredToken } from "../src/linear";
import { startPaws, type PawsProcess } from "../src/index";

const cleanup: (() => Promise<void> | void)[] = [];
const realFetch = globalThis.fetch;
afterEach(async () => {
  globalThis.fetch = realFetch;
  for (const close of cleanup.splice(0).reverse()) await close();
});

const stale = {
  accessToken: "fake-stale-access",
  refreshToken: "fake-stale-refresh",
  expiresAtMs: 0,
  scope: "read,write",
  actor: "app" as const,
};
const failingRefresh = () =>
  Object.assign(
    async (input: string | URL | Request) => {
      if (
        String(input instanceof Request ? input.url : input) ===
        "https://api.linear.app/oauth/token"
      )
        return Response.json({ error: "invalid_grant" }, { status: 400 });
      if (String(input instanceof Request ? input.url : input) === "https://api.linear.app/graphql")
        return Response.json({ errors: [{ message: "Authentication required" }] }, { status: 401 });
      throw new Error("Offline request must not run");
    },
    { preconnect: () => undefined },
  );

function killRefreshJobs(store: Db) {
  return store.run((q) =>
    q.exec(
      q.orm
        .update(q.t.job)
        .set({ status: "dead" })
        .where(inArray(q.t.job.status, ["pending", "running"])),
    ),
  );
}

function refreshJobs(store: Db) {
  return store.run(function* (q) {
    const rows = yield* q.all(q.orm.select().from(q.t.job));
    return rows.filter((row) => row.queue.startsWith("oauth.refresh."));
  });
}

async function start(home: string): Promise<PawsProcess> {
  const cert = join(home, "server.crt");
  const key = join(home, "server.key");
  const generated = Bun.spawnSync(
    [
      "openssl",
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:P-256",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-config",
      "/dev/null",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdout: "ignore", stderr: "pipe" },
  );
  expect(generated.exitCode).toBe(0);
  const paws = await startPaws({
    PAWS_HOME: home,
    PAWS_HOST: "127.0.0.1",
    PAWS_PORT: "0",
    PAWS_PUBLIC_DASHBOARD: "1",
    PAWS_PUBLIC_URL: "https://localhost:8787",
    PAWS_TLS_KEY_PATH: key,
    PAWS_TLS_CERT_PATH: cert,
    LINEAR_CLIENT_ID: "fixture-client",
    LINEAR_CLIENT_SECRET: "fixture-client-secret",
    LINEAR_ORGANIZATION_ID: "org",
  });
  cleanup.push(() => paws.stop());
  return paws;
}

async function expectReconnecting(paws: PawsProcess) {
  await paws.ready;
  expect(await paws.store.run((q) => q.all(q.orm.select().from(q.t.instance)))).not.toHaveLength(0);
  const session = await paws.server.fetch(new Request("https://localhost:8787/api/auth/session"));
  expect(await session.json()).toMatchObject({ onboarding: true, reconnect: true });
  const overview = await paws.server.fetch(new Request("https://localhost:8787/api/overview"));
  expect(overview.status).toBe(401);
  expect(((await overview.json()) as { error: string }).error).toContain(
    "Linear needs reconnecting",
  );
  const settings = await paws.server.fetch(
    new Request("https://localhost:8787/dashboard/settings"),
  );
  expect(settings.status).toBe(200);
}

test("a stored Linear credential that cannot refresh starts Paws in reconnect mode, even after its refresh job died", async () => {
  const home = await migratedHome();
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  await storeHomeLinearToken(home, stale);
  globalThis.fetch = failingRefresh();
  const first = await start(home);
  await expectReconnecting(first);
  await first.stop();
  await withHomeStore(home, async (store) => {
    await killRefreshJobs(store);
    expect((await refreshJobs(store)).map((row) => row.status)).toEqual(["dead"]);
  });
  await expectReconnecting(await start(home));
});

test("an unexpired stored Linear token that Linear rejects and cannot refresh keeps Paws running", async () => {
  const home = await migratedHome();
  cleanup.push(() => rmSync(home, { recursive: true, force: true }));
  await storeHomeLinearToken(home, { ...stale, expiresAtMs: Date.now() + 3_600_000 });
  globalThis.fetch = failingRefresh();
  await expectReconnecting(await start(home));
});

test("reconnecting after a dead refresh job stores the new credential and Linear reads resume", async () => {
  const home = tempHome();
  const secretsDir = join(home, "secrets");
  const pgliteDir = join(home, "pglite");
  await copyMigratedPglite(pgliteDir);
  const open = await openPawsStore({ url: null, pgliteDir });
  cleanup.push(() => open.close());
  const db = open.store;
  await writeStoredToken(db, secretsDir, stale);
  const failing = await createLinearAuth({
    db,
    secretsDir,
    clientId: "client",
    clientSecret: "secret",
    fetch: failingRefresh(),
  });
  await expect(failing.ensureFresh()).rejects.toThrow("Integration token refresh failed");
  await killRefreshJobs(db);
  await expect(failing.ensureFresh()).rejects.toThrow("Integration refresh could not complete");

  let authorized = false;
  const queries: string[] = [];
  const linear = await openLinear({
    db,
    store: db,
    secretsDir,
    env: { LINEAR_CLIENT_ID: "client", LINEAR_CLIENT_SECRET: "secret" },
    isAuthorized: async () => authorized,
    fetch: async (input, init) => {
      if (String(input) === "https://api.linear.app/oauth/token")
        return Response.json({
          access_token: "fake-rotated-access",
          refresh_token: "fake-rotated-refresh",
          expires_in: 3600,
        });
      queries.push(String(init?.body));
      return Response.json({
        data: {
          viewer: { id: "app" },
          issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
          agentActivities: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      });
    },
  });
  const running = await linear.start();
  cleanup.push(() => running.stop());
  await running.pollDue();
  expect(queries).toEqual([]);

  const next = { ...stale, accessToken: "fake-new-access", refreshToken: "fake-new-refresh" };
  const reconnect = await createLinearReconnect({
    fetch: async () =>
      Response.json({ data: { viewer: { id: "app", app: true, organization: { id: "org" } } } }),
  })(db, home);
  expect(await reconnect.complete({ clientId: "client", token: next })).toBe(true);
  expect(await readStoredToken(db, secretsDir)).toEqual(next);
  expect(await refreshJobs(db)).toEqual([]);

  authorized = true;
  await running.catchUp();
  expect(queries.some((body) => body.includes("IntakePoll"))).toBe(true);
  expect(await readStoredToken(db, secretsDir)).toMatchObject({
    accessToken: "fake-rotated-access",
    refreshToken: "fake-rotated-refresh",
  });
});
