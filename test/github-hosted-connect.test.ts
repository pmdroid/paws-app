import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { count as countRows, eq, sql } from "drizzle-orm";
import {
  createGitHubRepositorySetup,
  createGitHubStatusCache,
  createHostedGitHubConnect,
  type GitHubStatusCache,
} from "../src/server";
import { createWorkspaceGitHubActivation } from "../src/auth";
import {
  consumeWorkspaceBootstrap,
  deleteWorkspaceSession,
  openPawsStore,
  putWorkspaceUser,
  recordGitHubDelivery,
  replaceWorkspaceRepositories,
  syncWorkspaceMember,
  type Db,
  type Q,
} from "../src/db";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../src/workspace";
import { INSTALLATION_PERMISSIONS } from "../src/github";
import { copyMigratedPglite } from "./pglite";

const key = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

const rows = <R>(db: Db, query: (q: Q) => PromiseLike<R[]>) => db.run((q) => q.all(query(q)));
const write = (db: Db, query: (q: Q) => PromiseLike<unknown>) => db.run((q) => q.exec(query(q)));
const oauthCount = async (db: Db) =>
  (await rows(db, (q) => q.orm.select({ n: countRows() }).from(q.t.workspaceGithubOauth)))[0]!.n;
const connectionCount = async (db: Db) =>
  (await rows(db, (q) => q.orm.select({ n: countRows() }).from(q.t.workspaceGithubConnection)))[0]!
    .n;
const repositoryCount = async (db: Db) =>
  (await rows(db, (q) => q.orm.select({ n: countRows() }).from(q.t.workspaceRepository)))[0]!.n;
const connection = async (db: Db) =>
  (await rows(db, (q) => q.orm.select().from(q.t.workspaceGithubConnection)))[0];
const demote = (db: Db, userId: string) =>
  write(db, (q) =>
    q.orm
      .update(q.t.workspaceMember)
      .set({ role: "member" })
      .where(eq(q.t.workspaceMember.userId, userId)),
  );
// No Drizzle builder creates a trigger, so this one statement is raw SQL through the Db.
const refuseActivation = async (db: Db) => {
  if (db.dialect !== "postgres") throw new Error("This fixture runs on Postgres.");
  await db.orm.execute(
    sql.raw(
      "CREATE FUNCTION refuse_activation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic rollback'; END $$",
    ),
  );
  await db.orm.execute(
    sql.raw(
      "CREATE TRIGGER refuse_activation BEFORE UPDATE ON workspace_github_connection FOR EACH ROW EXECUTE FUNCTION refuse_activation()",
    ),
  );
};
const clearRepositories = (db: Db) => write(db, (q) => q.orm.delete(q.t.workspaceRepository));

async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "paws-hosted-app-"));
  writeFileSync(join(home, "key.pem"), key, { mode: 0o600 });
  const pgliteDir = join(home, "pglite");
  await copyMigratedPglite(pgliteDir);
  let database = await openPawsStore({ url: null, pgliteDir });
  let db = database.store;
  let now = Date.now();
  await putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "owner",
    name: "owner",
    email: "owner@example.invalid",
  });
  await consumeWorkspaceBootstrap(db, {
    id: "ws",
    organizationId: "org",
    name: "Workspace",
    userId: "owner",
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const role of ["admin", "member"] as const) {
    await putWorkspaceUser(db, {
      id: role,
      linearUserId: role,
      name: role,
      email: `${role}@example.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId: "ws",
      userId: role,
      role,
      active: true,
      teamIds: ["team"],
      now,
    });
  }
  await replaceWorkspaceRepositories(db, {
    workspaceId: "ws",
    actorId: "owner",
    repositories: [{ repository: "acme/widgets", teamId: "team" }],
    now,
  });
  const env = {
    GITHUB_AUTH: "app",
    GITHUB_APP_ID: "99",
    PAWS_GITHUB_CLIENT_ID: "Iv1.fake",
    PAWS_GITHUB_CLIENT_SECRET: "scripted-client-secret",
    GITHUB_APP_PRIVATE_KEY_PATH: join(home, "key.pem"),
  };
  const sessions: Record<string, Awaited<ReturnType<typeof issueWorkspaceSession>>> = {};
  for (const role of ["owner", "admin", "member"])
    sessions[role] = await issueWorkspaceSession(db, {
      workspaceId: "ws",
      userId: role,
      now,
    });
  const calls: { path: string; body: string }[] = [];
  let hold: Promise<void> | undefined;
  let beforeInstallation: (() => Promise<void>) | undefined;
  let installationStatus = 200;
  let tokenGate: ((inFlight: number) => Promise<void>) | undefined;
  let tokensInFlight = 0;
  let maxTokensInFlight = 0;
  let catalogPages: boolean | "duplicate" = false;
  let catalogPermissions: unknown = INSTALLATION_PERMISSIONS;
  const github = {
    repoStatus: 200,
    suspended: false,
  };
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(providerRequest) {
      const url = new URL(providerRequest.url);
      const body = await providerRequest.text();
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/login/oauth/access_token") {
        await hold;
        return Response.json({ access_token: "scripted-user-token" });
      }
      if (url.pathname === "/user/installations")
        return Response.json({
          total_count: 1,
          installations: [
            {
              id: 22,
              app_id: 99,
              account: { login: "acme" },
              permissions: catalogPermissions,
            },
          ],
        });
      if (url.pathname === "/user/installations/22/repositories" && catalogPages) {
        const page = Number(url.searchParams.get("page"));
        const offset = page === 1 || catalogPages === "duplicate" ? 0 : 100;
        const count = page === 1 ? 100 : 1;
        return Response.json({
          total_count: 101,
          repositories: Array.from({ length: count }, (_, index) => ({
            id: offset + index + 1,
            full_name: `acme/widget${offset + index}`,
            permissions: { admin: true, pull: true },
          })),
        });
      }
      if (url.pathname === "/user/installations/22/repositories")
        return Response.json({
          total_count: 3,
          repositories: [
            {
              id: 1,
              full_name: "acme/widgets",
              private: true,
              permissions: { admin: true, pull: true },
            },
            { id: 2, full_name: "other/private", permissions: { admin: false } },
            { id: 3, full_name: "acme/gadgets", permissions: { admin: false, pull: true } },
          ],
        });
      if (url.pathname === "/user") return Response.json({ id: 7, login: "installer" });
      if (url.pathname === "/app")
        return Response.json({ id: 99, client_id: "Iv1.fake", slug: "fixture-paws" });
      if (/^\/repos\/acme\/[^/]+\/installation$/.test(url.pathname)) {
        await beforeInstallation?.();
        return Response.json(
          {
            id: 22,
            app_id: 99,
            suspended_at: github.suspended ? "2026-11-13T00:00:00Z" : null,
            permissions: INSTALLATION_PERMISSIONS,
          },
          { status: installationStatus },
        );
      }
      if (/^\/repos\/acme\/(widgets|gadgets)$/.test(url.pathname))
        return Response.json(
          { permissions: { admin: false, pull: true } },
          { status: github.repoStatus },
        );
      if (url.pathname === "/app/installations/22/access_tokens") {
        const name = (JSON.parse(body) as { repositories: string[] }).repositories[0];
        maxTokensInFlight = Math.max(maxTokensInFlight, ++tokensInFlight);
        await tokenGate?.(tokensInFlight);
        tokensInFlight--;
        return Response.json(
          {
            token: "scripted-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            repository_selection: "selected",
            repositories: [{ name, full_name: `acme/${name}` }],
            permissions: INSTALLATION_PERMISSIONS,
          },
          { status: 201 },
        );
      }
      return new Response(null, { status: 404 });
    },
  });
  const scriptedFetch = ((url, init) =>
    fetch(
      `http://127.0.0.1:${provider.port}${new URL(String(url)).pathname}${new URL(String(url)).search}`,
      init,
    )) as typeof fetch;
  const handler = (cache?: GitHubStatusCache) =>
    createHostedGitHubConnect({
      store: db,
      home,
      env,
      origin: "https://paws.example",
      now: () => now,
      fetch: scriptedFetch,
      cache,
    });
  function request(role: string, url: string, init: RequestInit = {}) {
    return new Request(url, {
      ...init,
      headers: { cookie: `${WORKSPACE_COOKIE}=${sessions[role]!.token}`, ...init.headers },
    });
  }
  async function begin(role = "owner") {
    const response = await handler()(
      request(role, "https://paws.example/api/workspaces/github-connect", {
        method: "POST",
        headers: {
          origin: "https://paws.example",
          "x-paws-csrf": sessions[role]!.session.csrfToken,
        },
        body: JSON.stringify({ installationId: "22" }),
      }),
    );
    if (response?.status !== 200) throw new Error(`Start ${response?.status}`);
    const data = (await response.json()) as { authorizationUrl: string };
    const authorize = new URL(data.authorizationUrl);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("code", "scripted-code");
    return { authorize, callback };
  }
  return {
    home,
    env,
    calls,
    github,
    sessions,
    begin,
    handler,
    setup: (cache?: GitHubStatusCache) =>
      createGitHubRepositorySetup({
        cache,
        store: db,
        home,
        env,
        origin: "https://paws.example",
        now: () => now,
        fetch: scriptedFetch,
        teams: async () => [{ id: "team", name: "Engineering", key: "ENG" }],
      }),
    request,
    get db() {
      return db;
    },
    advance(ms: number) {
      now += ms;
    },
    setCatalogPages(value: boolean | "duplicate") {
      catalogPages = value;
    },
    setCatalogPermissions(value: unknown) {
      catalogPermissions = value;
    },
    setTokenGate(value: (inFlight: number) => Promise<void>) {
      tokenGate = value;
    },
    get maxTokensInFlight() {
      return maxTokensInFlight;
    },
    setInstallationStatus(value: number) {
      installationStatus = value;
    },
    setBeforeInstallation(value: (() => Promise<void>) | undefined) {
      beforeInstallation = value;
    },
    setHold(value: Promise<void>) {
      hold = value;
    },
    pgliteDir,
    async restart() {
      await database.close();
      database = await openPawsStore({ url: null, pgliteDir });
      db = database.store;
    },
    async close() {
      await provider.stop(true);
      await database.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("hosted App OAuth survives restart, verifies real scripted HTTP, encrypts activation and rejects replay", async () => {
  const f = await fixture();
  try {
    const flow = await f.begin("admin");
    expect(flow.authorize.searchParams.get("redirect_uri")).toBe(
      "https://paws.example/auth/github-app/callback",
    );
    expect(flow.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    await f.restart();
    const callback = await f.handler()(f.request("admin", flow.callback.href));
    expect(callback?.status).toBe(303);
    const active = await createWorkspaceGitHubActivation(f.db, f.home, f.env).resolve(
      "acme/widgets",
    );
    expect(active.installationId).toBe("22");
    expect(active.generation).toBe(1);
    await write(f.db, (q) =>
      q.orm.update(q.t.workspaceRepository).set({ repository: "Acme/Widgets" }),
    );
    await write(f.db, (q) =>
      q.orm.update(q.t.workspaceGithubConnection).set({ repositories: '["Acme/Widgets"]' }),
    );
    expect(
      (await createWorkspaceGitHubActivation(f.db, f.home, f.env).resolve("acme/widgets"))
        .generation,
    ).toBe(1);
    expect((await f.handler()(f.request("admin", flow.callback.href)))?.status).toBe(403);
    const row = (await connection(f.db))!;
    const encrypted = readFileSync(
      join(f.home, "secrets", `github-connect-${row.secretId}`),
      "utf8",
    );
    expect(encrypted).not.toContain("scripted-client-secret");
    expect(encrypted).not.toContain("PRIVATE KEY");
    expect(encrypted).not.toContain("scripted-user-token");
    const exchange = new URLSearchParams(
      f.calls.find((call) => call.path === "/login/oauth/access_token")!.body,
    );
    expect(exchange.get("code_verifier")).toHaveLength(43);
  } finally {
    await f.close();
  }
});

test("concurrent admin callbacks cannot overwrite the first activated generation", async () => {
  const f = await fixture();
  try {
    const first = await f.begin();
    const second = await f.begin("admin");
    expect((await f.handler()(f.request("owner", first.callback.href)))?.status).toBe(303);
    expect((await f.handler()(f.request("admin", second.callback.href)))?.status).toBe(409);
    expect((await connection(f.db))?.generation).toBe(1);
  } finally {
    await f.close();
  }
});

for (const invalidation of ["logout", "demotion", "repositories", "session"] as const)
  test(`hosted callback refuses ${invalidation} while exchange is awaited`, async () => {
    const f = await fixture();
    try {
      const flow = await f.begin("admin");
      const gate = Promise.withResolvers<void>();
      f.setHold(gate.promise);
      const result = f.handler()(f.request("admin", flow.callback.href));
      for (
        let n = 0;
        n < 100 && !f.calls.some((call) => call.path === "/login/oauth/access_token");
        n++
      )
        await Bun.sleep(1);
      if (invalidation === "logout")
        await deleteWorkspaceSession(f.db, f.sessions.admin!.session.tokenHash);
      if (invalidation === "demotion") await demote(f.db, "admin");
      if (invalidation === "repositories")
        await replaceWorkspaceRepositories(f.db, {
          workspaceId: "ws",
          actorId: "owner",
          repositories: [],
          now: Date.now(),
        });
      if (invalidation === "session") {
        expect((await f.handler()(f.request("owner", flow.callback.href)))?.status).toBe(403);
      }
      gate.resolve();
      const response = await result;
      expect(response?.status).toBe(invalidation === "session" ? 303 : 403);
      if (invalidation !== "session") expect((await connection(f.db))?.generation).toBe(0);
    } finally {
      await f.close();
    }
  });

test("hosted connection reports missing server credentials as JSON without changing connection state", async () => {
  const f = await fixture();
  try {
    const handler = createHostedGitHubConnect({
      store: f.db,
      home: f.home,
      env: {},
      origin: "https://paws.example",
    });
    const response = await handler(
      f.request("owner", "https://paws.example/api/workspaces/github-connect", {
        method: "POST",
        headers: {
          origin: "https://paws.example",
          "x-paws-csrf": f.sessions.owner!.session.csrfToken,
        },
        body: JSON.stringify({ installationId: "22" }),
      }),
    );
    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({
      error: "Ask the Paws operator to configure the GitHub App on the server, then restart Paws.",
    });
    expect(await oauthCount(f.db)).toBe(0);
    expect(await connectionCount(f.db)).toBe(0);
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
});

function automaticRequest(f: Awaited<ReturnType<typeof fixture>>, method = "POST", role = "owner") {
  return f.request(role, "https://paws.example/api/workspaces/github-connect", {
    method,
    ...(method === "POST"
      ? {
          headers: {
            origin: "https://paws.example",
            "x-paws-csrf": f.sessions[role]!.session.csrfToken,
          },
          body: "{}",
        }
      : {}),
  });
}

test("GitHub setup discovers the approved installation and exposes status without credential or ID inputs", async () => {
  const f = await fixture();
  try {
    const initial = await f.handler()(automaticRequest(f, "GET"));
    expect(await initial?.json()).toMatchObject({
      status: "needs_connection",
      canManage: true,
      requiresSignIn: false,
      repositoryCount: 1,
    });
    const start = await f.handler()(automaticRequest(f));
    expect(start?.status).toBe(200);
    const body = (await start!.json()) as { authorizationUrl: string };
    expect(JSON.stringify(body)).not.toContain("scripted-client-secret");
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    const authorize = new URL(body.authorizationUrl);
    const callback = new URL(authorize.searchParams.get("redirect_uri")!);
    callback.searchParams.set("state", authorize.searchParams.get("state")!);
    callback.searchParams.set("code", "scripted-code");
    expect((await f.handler()(f.request("owner", callback.href)))?.status).toBe(303);
    const connected = await f.handler()(automaticRequest(f, "GET", "member"));
    expect(await connected?.json()).toMatchObject({
      status: "connected",
      canManage: false,
      repositoryCount: 1,
      lastDelivery: null,
    });
    await recordGitHubDelivery(
      f.db,
      { deliveryId: "d-1", event: "check_suite", payload: "{}" },
      5_000,
    );
    expect(await (await f.handler()(automaticRequest(f, "GET")))?.json()).toMatchObject({
      lastDelivery: { event: "check_suite", receivedAt: 5_000 },
    });
    f.setInstallationStatus(404);
    const removed = await f.handler()(automaticRequest(f, "GET"));
    expect(await removed?.json()).toMatchObject({ status: "needs_installation" });
  } finally {
    await f.close();
  }
});

test("GitHub status checks repositories concurrently and serves a minute-long cache only to signed-in callers", async () => {
  const f = await fixture();
  try {
    await f.handler()(f.request("owner", (await f.begin()).callback.href));
    const names = Array.from({ length: 10 }, (_, index) => `acme/repo${index}`);
    await replaceWorkspaceRepositories(f.db, {
      workspaceId: "ws",
      actorId: "owner",
      repositories: names.map((repository) => ({ repository, teamId: "team" })),
      now: Date.now(),
    });
    await write(f.db, (q) =>
      q.orm.update(q.t.workspaceGithubConnection).set({ repositories: JSON.stringify(names) }),
    );
    const limit = Math.min(8, names.length);
    const opened = Promise.withResolvers<void>();
    f.setTokenGate(async (inFlight) => {
      if (inFlight >= limit) opened.resolve();
      await opened.promise;
    });
    const cache = createGitHubStatusCache();
    const status = async () => (await f.handler(cache)(automaticRequest(f, "GET")))!.json();
    expect(await status()).toMatchObject({ status: "connected", repositoryCount: 10 });
    expect(f.maxTokensInFlight).toBe(limit);
    let calls = f.calls.length;
    f.advance(59_000);
    expect(await status()).toMatchObject({ status: "connected", repositoryCount: 10 });
    const anonymous = new Request("https://paws.example/api/workspaces/github-connect");
    expect((await f.handler(cache)(anonymous))?.status).toBe(403);
    expect(f.calls.length).toBe(calls);
    const headers = {
      origin: "https://paws.example",
      "x-paws-csrf": f.sessions.owner!.session.csrfToken,
    };
    await f.setup(cache)(
      f.request("owner", "https://paws.example/api/workspaces/github-setup", {
        method: "PUT",
        headers,
        body: "{}",
      }),
    );
    calls = f.calls.length;
    expect(await status()).toMatchObject({ status: "connected" });
    expect(f.calls.length).toBeGreaterThan(calls);
  } finally {
    await f.close();
  }
});

test("missing installations offer a verified GitHub install URL without persisting OAuth state", async () => {
  const f = await fixture();
  try {
    f.setInstallationStatus(404);
    const response = await f.handler()(automaticRequest(f));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      installationUrl: "https://github.com/apps/fixture-paws/installations/new",
    });
    expect(await oauthCount(f.db)).toBe(0);
    expect(await connectionCount(f.db)).toBe(0);
  } finally {
    await f.close();
  }
});

test("an administrator signed in hours ago can still manage the connection", async () => {
  const f = await fixture();
  try {
    f.advance(6 * 60 * 60_000);
    const response = await f.handler()(automaticRequest(f, "GET"));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ canManage: true, requiresSignIn: false });
    expect((await f.handler()(automaticRequest(f)))?.status).toBe(200);
    const member = await f.handler()(automaticRequest(f, "POST", "member"));
    expect(await member?.json()).toMatchObject({ code: "admin_required" });
  } finally {
    await f.close();
  }
});

for (const change of ["logout", "demotion", "repositories", "credentials", "expiry"] as const) {
  test(`automatic installation discovery rejects ${change} during GitHub lookup`, async () => {
    const f = await fixture();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    try {
      f.setBeforeInstallation(async () => {
        entered.resolve();
        await released.promise;
      });
      const pending = f.handler()(automaticRequest(f));
      await entered.promise;
      if (change === "logout")
        await deleteWorkspaceSession(f.db, f.sessions.owner!.session.tokenHash);
      if (change === "demotion") await demote(f.db, "owner");
      if (change === "repositories")
        await replaceWorkspaceRepositories(f.db, {
          workspaceId: "ws",
          actorId: "owner",
          repositories: [],
          now: Date.now(),
        });
      if (change === "credentials") f.env.PAWS_GITHUB_CLIENT_ID = "Iv1.changed";
      if (change === "expiry") f.advance(31 * 24 * 60 * 60_000);
      released.resolve();
      const response = await pending;
      expect(response?.status).toBe(
        change === "repositories" || change === "credentials" ? 409 : 403,
      );
      expect(await oauthCount(f.db)).toBe(0);
    } finally {
      released.resolve();
      await f.close();
    }
  });
}

for (const repository of [
  "acme/..",
  "../widgets",
  "acme/widgets?x=1",
  "acme/widgets#fragment",
  "acme/widgets/extra",
]) {
  test(`automatic discovery rejects an unsafe repository before App requests: ${repository}`, async () => {
    const f = await fixture();
    try {
      await write(f.db, (q) =>
        q.orm
          .update(q.t.workspaceRepository)
          .set({ repository })
          .where(eq(q.t.workspaceRepository.workspaceId, "ws")),
      );
      const response = await f.handler()(automaticRequest(f));
      expect(response?.status).toBe(503);
      expect(f.calls).toEqual([]);
      expect(await oauthCount(f.db)).toBe(0);
    } finally {
      await f.close();
    }
  });
}

async function signInForRepositorySetup(f: Awaited<ReturnType<typeof fixture>>) {
  const response = await f.setup()(
    f.request("owner", "https://paws.example/api/workspaces/github-setup", {
      method: "POST",
      headers: {
        origin: "https://paws.example",
        "content-type": "application/json",
        "x-paws-csrf": f.sessions.owner!.session.csrfToken,
      },
      body: "{}",
    }),
  );
  expect(response?.status).toBe(200);
  const target = new URL(
    ((await response!.json()) as { authorizationUrl: string }).authorizationUrl,
  );
  const callback = new URL(target.searchParams.get("redirect_uri")!);
  callback.searchParams.set("state", target.searchParams.get("state")!);
  callback.searchParams.set("code", "scripted-code");
  expect((await f.setup()(f.request("owner", callback.href)))?.status).toBe(303);
  return callback;
}
async function saveSetup(
  f: Awaited<ReturnType<typeof fixture>>,
  mappings: unknown = [{ repository: "acme/widgets", teamId: "team" }],
  installationId = "22",
) {
  const catalog = await f.setup()(
    f.request("owner", "https://paws.example/api/workspaces/github-setup"),
  );
  const setupId = ((await catalog!.json()) as { setupId?: string }).setupId;
  return f.setup()(
    f.request("owner", "https://paws.example/api/workspaces/github-setup", {
      method: "PUT",
      headers: {
        origin: "https://paws.example",
        "content-type": "application/json",
        "x-paws-csrf": f.sessions.owner!.session.csrfToken,
      },
      body: JSON.stringify({ installationId, mappings, setupId }),
    }),
  );
}
for (const permissions of [
  { contents: "write", actions: "read", metadata: "read" },
  { ...INSTALLATION_PERMISSIONS, checks: "read" },
  null,
])
  test("repository setup shows accessible repositories with missing permissions and blocks activation until approved", async () => {
    const f = await fixture();
    try {
      await clearRepositories(f.db);
      f.setCatalogPermissions(permissions);
      await signInForRepositorySetup(f);
      const response = await f.setup()(
        f.request("owner", "https://paws.example/api/workspaces/github-setup"),
      );
      expect(response?.status).toBe(200);
      const body = (await response!.json()) as { missingPermissions: string[] };
      expect(body).toMatchObject({
        installationId: "22",
        installations: [{ id: "22", account: "acme" }],
        repositories: [
          { repository: "acme/widgets", private: true },
          { repository: "acme/gadgets", private: false },
        ],
      });
      expect(body.missingPermissions.length).toBeGreaterThan(0);
      const denied = await saveSetup(f);
      expect(denied?.status).toBe(409);
      expect(await denied!.json()).toMatchObject({ code: "github_permissions_required" });
      expect(await repositoryCount(f.db)).toBe(0);
      expect(await connectionCount(f.db)).toBe(0);
      expect(f.calls.some((call) => call.path.endsWith("/access_tokens"))).toBe(false);
      f.setCatalogPermissions(INSTALLATION_PERMISSIONS);
      expect((await saveSetup(f))?.status).toBe(200);
    } finally {
      await f.close();
    }
  });

test("GitHub sign-in precedes repository approval and activates selected matches atomically", async () => {
  const f = await fixture();
  try {
    await clearRepositories(f.db);
    const callback = await signInForRepositorySetup(f);
    expect(await repositoryCount(f.db)).toBe(0);
    expect(await connectionCount(f.db)).toBe(0);
    expect((await f.setup()(f.request("owner", callback.href)))?.status).toBe(403);
    await f.restart();
    const catalog = await f.setup()(
      f.request("owner", "https://paws.example/api/workspaces/github-setup"),
    );
    expect(catalog?.status).toBe(200);
    const body = await catalog!.json();
    expect(body).toMatchObject({
      signedIn: true,
      login: "installer",
      repositories: [
        { repository: "acme/widgets", private: true },
        { repository: "acme/gadgets", private: false },
      ],
      teams: [{ id: "team", name: "Engineering", key: "ENG" }],
      mappings: [],
    });
    expect(JSON.stringify(body)).not.toContain("scripted-user-token");
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    const stored = readdirSync(f.pgliteDir, { recursive: true, encoding: "utf8" })
      .map((name) => join(f.pgliteDir, name))
      .filter((path) => statSync(path).isFile());
    expect(stored.length).toBeGreaterThan(0);
    for (const path of stored)
      expect(readFileSync(path).includes(Buffer.from("scripted-user-token"))).toBe(false);
    expect((await saveSetup(f))?.status).toBe(200);
    expect(
      await rows(f.db, (q) =>
        q.orm
          .select({
            repository: q.t.workspaceRepository.repository,
            teamId: q.t.workspaceRepository.teamId,
          })
          .from(q.t.workspaceRepository),
      ),
    ).toEqual([{ repository: "acme/widgets", teamId: "team" }]);
    expect(
      (await createWorkspaceGitHubActivation(f.db, f.home, f.env).resolve("acme/widgets"))
        .installationId,
    ).toBe("22");
    expect(
      (await f.setup()(f.request("owner", "https://paws.example/api/workspaces/github-setup")))
        ?.status,
    ).toBe(200);
    expect((await saveSetup(f, []))?.status).toBe(200);
    expect(await repositoryCount(f.db)).toBe(0);
  } finally {
    await f.close();
  }
});
for (const scenario of [
  "member",
  "csrf",
  "wrong-installation",
  "wrong-repository",
  "wrong-team",
  "expired",
  "demoted",
  "scope",
  "credentials",
  "rollback",
] as const) {
  test(`repository setup rejects ${scenario} without activating access`, async () => {
    const f = await fixture();
    try {
      await signInForRepositorySetup(f);
      if (scenario === "expired") f.advance(600_001);
      if (scenario === "demoted") await demote(f.db, "owner");
      if (scenario === "scope") await clearRepositories(f.db);
      if (scenario === "credentials") f.env.PAWS_GITHUB_CLIENT_SECRET = "rotated-scripted-secret";
      if (scenario === "rollback") await refuseActivation(f.db);
      let response: Response | null;
      if (scenario === "member")
        response = await f.setup()(
          f.request("member", "https://paws.example/api/workspaces/github-setup"),
        );
      else if (scenario === "csrf")
        response = await f.setup()(
          f.request("owner", "https://paws.example/api/workspaces/github-setup", {
            method: "PUT",
            body: "{}",
          }),
        );
      else
        response = await saveSetup(
          f,
          [
            {
              repository: scenario === "wrong-repository" ? "other/private" : "acme/widgets",
              teamId: scenario === "wrong-team" ? "other-team" : "team",
            },
          ],
          scenario === "wrong-installation" ? "999" : "22",
        );
      expect([400, 403, 409]).toContain(response!.status);
      expect(await connectionCount(f.db)).toBe(0);
      expect(await repositoryCount(f.db)).toBe(scenario === "scope" ? 0 : 1);
    } finally {
      await f.close();
    }
  });
}
test("repository setup rechecks owner authority while GitHub verification is held", async () => {
  const f = await fixture();
  try {
    await signInForRepositorySetup(f);
    f.setBeforeInstallation(() => demote(f.db, "owner"));
    expect((await saveSetup(f))?.status).toBe(403);
    expect(await connectionCount(f.db)).toBe(0);
  } finally {
    await f.close();
  }
});

test("repository choices read every user-accessible page and reject duplicate pagination", async () => {
  const f = await fixture();
  try {
    await signInForRepositorySetup(f);
    f.setCatalogPages(true);
    const response = await f.setup()(
      f.request("owner", "https://paws.example/api/workspaces/github-setup"),
    );
    expect(response?.status).toBe(200);
    const data = (await response!.json()) as { repositories: { repository: string }[] };
    expect(data.repositories.length).toBe(101);
    expect(data.repositories[100]?.repository).toBe("acme/widget100");
    f.setCatalogPages("duplicate");
    expect(
      (await f.setup()(f.request("owner", "https://paws.example/api/workspaces/github-setup")))
        ?.status,
    ).toBe(409);
  } finally {
    await f.close();
  }
});

const NOT_INSTALLED =
  "The GitHub App is not installed on acme/widgets, or the installation is suspended.";

test("first setup by an org member who can read saves and audits the mapping", async () => {
  const f = await fixture();
  try {
    await clearRepositories(f.db);
    await signInForRepositorySetup(f);
    expect((await saveSetup(f))?.status).toBe(200);
    expect(await repositoryCount(f.db)).toBe(1);
    expect(
      await rows(f.db, (q) =>
        q.orm
          .select({ action: q.t.workspaceAccessAudit.action })
          .from(q.t.workspaceAccessAudit)
          .where(eq(q.t.workspaceAccessAudit.action, "github.connect.activated")),
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("connect accepts an org member who can read and names a repository they can't", async () => {
  const f = await fixture();
  try {
    f.github.repoStatus = 404;
    const flow = await f.begin("admin");
    const response = await f.handler()(f.request("admin", flow.callback.href));
    expect(response?.status).toBe(409);
    expect(await response!.json()).toEqual({
      error: "Your GitHub account can't read acme/widgets.",
    });
    expect((await connection(f.db))?.generation).toBe(0);
    f.github.repoStatus = 200;
    const retry = await f.begin("admin");
    expect((await f.handler()(f.request("admin", retry.callback.href)))?.status).toBe(303);
  } finally {
    await f.close();
  }
});

test("after first setup an org member who can read a repository adds it", async () => {
  const f = await fixture();
  try {
    await signInForRepositorySetup(f);
    const catalog = await f.setup()(
      f.request("owner", "https://paws.example/api/workspaces/github-setup"),
    );
    expect(
      ((await catalog!.json()) as { repositories: { repository: string }[] }).repositories.map(
        (entry) => entry.repository,
      ),
    ).toEqual(["acme/widgets", "acme/gadgets"]);
    const saved = await saveSetup(f, [
      { repository: "acme/widgets", teamId: "team" },
      { repository: "acme/gadgets", teamId: "team" },
    ]);
    expect(saved?.status).toBe(200);
    expect(await repositoryCount(f.db)).toBe(2);
    expect(
      await rows(f.db, (q) =>
        q.orm
          .select({ action: q.t.workspaceAccessAudit.action })
          .from(q.t.workspaceAccessAudit)
          .where(eq(q.t.workspaceAccessAudit.action, "github.connect.activated")),
      ),
    ).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("after first setup a repository the user can't read is refused", async () => {
  const f = await fixture();
  try {
    await signInForRepositorySetup(f);
    f.github.repoStatus = 404;
    const refused = await saveSetup(f);
    expect(refused?.status).toBe(409);
    expect(await refused!.json()).toEqual({
      error: "Your GitHub account can't read acme/widgets.",
    });
    expect(await connectionCount(f.db)).toBe(0);
  } finally {
    await f.close();
  }
});

for (const mode of ["first setup", "after first setup"])
  for (const cause of ["suspended", "other installation"])
    test(`${mode} refuses a repository on a ${cause} installation`, async () => {
      const f = await fixture();
      try {
        if (mode === "first setup") await clearRepositories(f.db);
        await signInForRepositorySetup(f);
        if (cause === "suspended") f.github.suspended = true;
        else f.setInstallationStatus(404);
        const refused = await saveSetup(f);
        expect(refused?.status).toBe(409);
        expect(await refused!.json()).toEqual({ error: NOT_INSTALLED });
        expect(await connectionCount(f.db)).toBe(0);
      } finally {
        await f.close();
      }
    });
