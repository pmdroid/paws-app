import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createGitHubRepositorySetup, createHostedGitHubConnect } from "../src/server";
import { createWorkspaceGitHubActivation } from "../src/auth";
import {
  consumeWorkspaceBootstrap,
  deleteWorkspaceSession,
  migrate,
  openDatabase,
  putWorkspaceUser,
  replaceWorkspaceRepositories,
  syncWorkspaceMember,
} from "../src/db";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../src/workspace";
import { INSTALLATION_PERMISSIONS } from "../src/github";

const key = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "paws-hosted-app-"));
  writeFileSync(join(home, "key.pem"), key, { mode: 0o600 });
  const path = join(home, "db.sqlite");
  let db = openDatabase(path);
  migrate(db);
  let now = Date.now();
  putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "owner",
    name: "owner",
    email: "owner@example.invalid",
  });
  consumeWorkspaceBootstrap(db, {
    id: "ws",
    organizationId: "org",
    name: "Workspace",
    userId: "owner",
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const role of ["admin", "member"] as const) {
    putWorkspaceUser(db, {
      id: role,
      linearUserId: role,
      name: role,
      email: `${role}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: "ws",
      userId: role,
      role,
      active: true,
      teamIds: ["team"],
      now,
    });
  }
  replaceWorkspaceRepositories(db, {
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
  const sessions = Object.fromEntries(
    ["owner", "admin", "member"].map((role) => [
      role,
      issueWorkspaceSession(db, { workspaceId: "ws", userId: role, now }),
    ]),
  );
  const calls: { path: string; body: string }[] = [];
  let hold: Promise<void> | undefined;
  let beforeInstallation: (() => Promise<void>) | undefined;
  let installationStatus = 200;
  let catalogPages: boolean | "duplicate" = false;
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
              permissions: INSTALLATION_PERMISSIONS,
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
            permissions: { admin: true },
          })),
        });
      }
      if (url.pathname === "/user/installations/22/repositories")
        return Response.json({
          total_count: 2,
          repositories: [
            { id: 1, full_name: "acme/widgets", private: true, permissions: { admin: true } },
            { id: 2, full_name: "other/private", permissions: { admin: false } },
          ],
        });
      if (url.pathname === "/user") return Response.json({ id: 7, login: "installer" });
      if (url.pathname === "/app")
        return Response.json({ id: 99, client_id: "Iv1.fake", slug: "fixture-paws" });
      if (url.pathname === "/repos/acme/widgets/installation") {
        await beforeInstallation?.();
        return Response.json(
          { id: 22, app_id: 99, suspended_at: null, permissions: INSTALLATION_PERMISSIONS },
          { status: installationStatus },
        );
      }
      if (url.pathname === "/repos/acme/widgets")
        return Response.json({
          permissions: { admin: true },
          owner: { type: "Organization", id: 1 },
        });
      if (url.pathname === "/user/memberships/orgs/acme")
        return Response.json({ state: "active", role: "admin" });
      if (url.pathname === "/app/installations/22/access_tokens")
        return Response.json(
          {
            token: "scripted-installation-token",
            expires_at: new Date(Date.now() + 3600000).toISOString(),
            repository_selection: "selected",
            repositories: [{ name: "widgets", full_name: "acme/widgets" }],
            permissions: INSTALLATION_PERMISSIONS,
          },
          { status: 201 },
        );
      return new Response(null, { status: 404 });
    },
  });
  const scriptedFetch = ((url, init) =>
    fetch(
      `http://127.0.0.1:${provider.port}${new URL(String(url)).pathname}${new URL(String(url)).search}`,
      init,
    )) as typeof fetch;
  const handler = () =>
    createHostedGitHubConnect({
      db,
      home,
      env,
      origin: "https://paws.example",
      now: () => now,
      fetch: scriptedFetch,
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
    sessions,
    begin,
    handler,
    setup: () =>
      createGitHubRepositorySetup({
        db,
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
    setInstallationStatus(value: number) {
      installationStatus = value;
    },
    setBeforeInstallation(value: (() => Promise<void>) | undefined) {
      beforeInstallation = value;
    },
    setHold(value: Promise<void>) {
      hold = value;
    },
    restart() {
      db.close();
      db = openDatabase(path);
    },
    async close() {
      await provider.stop(true);
      db.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}

test("hosted App OAuth survives restart, verifies real scripted HTTP, encrypts activation and rejects replay", async () => {
  const f = fixture();
  try {
    const flow = await f.begin("admin");
    expect(flow.authorize.searchParams.get("redirect_uri")).toBe(
      "https://paws.example/auth/github-app/callback",
    );
    expect(flow.authorize.searchParams.get("code_challenge_method")).toBe("S256");
    f.restart();
    const callback = await f.handler()(f.request("admin", flow.callback.href));
    expect(callback?.status).toBe(303);
    const active = createWorkspaceGitHubActivation(f.db, f.home, f.env).resolve("acme/widgets");
    expect(active.installationId).toBe("22");
    expect(active.generation).toBe(1);
    f.db.run("UPDATE workspace_repository SET repository='Acme/Widgets'");
    f.db.run("UPDATE workspace_github_connection SET repositories='[\"Acme/Widgets\"]'");
    expect(
      createWorkspaceGitHubActivation(f.db, f.home, f.env).resolve("acme/widgets").generation,
    ).toBe(1);
    expect((await f.handler()(f.request("admin", flow.callback.href)))?.status).toBe(403);
    const row = f.db
      .query<{ secret_id: string }, []>("SELECT secret_id FROM workspace_github_connection")
      .get()!;
    const encrypted = readFileSync(
      join(f.home, "secrets", `github-connect-${row.secret_id}`),
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
  const f = fixture();
  try {
    const first = await f.begin();
    const second = await f.begin("admin");
    expect((await f.handler()(f.request("owner", first.callback.href)))?.status).toBe(303);
    expect((await f.handler()(f.request("admin", second.callback.href)))?.status).toBe(409);
    expect(
      f.db
        .query<{ generation: number }, []>("SELECT generation FROM workspace_github_connection")
        .get()?.generation,
    ).toBe(1);
  } finally {
    await f.close();
  }
});

for (const invalidation of ["logout", "demotion", "repositories", "session"] as const)
  test(`hosted callback refuses ${invalidation} while exchange is awaited`, async () => {
    const f = fixture();
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
        deleteWorkspaceSession(f.db, f.sessions.admin!.session.tokenHash);
      if (invalidation === "demotion")
        f.db.run("UPDATE workspace_member SET role='member' WHERE user_id='admin'");
      if (invalidation === "repositories")
        replaceWorkspaceRepositories(f.db, {
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
      if (invalidation !== "session")
        expect(
          f.db
            .query<{ generation: number }, []>("SELECT generation FROM workspace_github_connection")
            .get()?.generation,
        ).toBe(0);
    } finally {
      await f.close();
    }
  });

test("hosted connection reports missing server credentials as JSON without changing connection state", async () => {
  const f = fixture();
  try {
    const handler = createHostedGitHubConnect({
      db: f.db,
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
    expect(f.db.query("SELECT count(*) AS n FROM workspace_github_oauth").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM workspace_github_connection").get()).toEqual({
      n: 0,
    });
    expect(f.calls).toEqual([]);
  } finally {
    await f.close();
  }
});

function automaticRequest(f: ReturnType<typeof fixture>, method = "POST", role = "owner") {
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
  const f = fixture();
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
    });
    f.setInstallationStatus(404);
    const removed = await f.handler()(automaticRequest(f, "GET"));
    expect(await removed?.json()).toMatchObject({ status: "needs_installation" });
  } finally {
    await f.close();
  }
});

test("missing installations offer a verified GitHub install URL without persisting OAuth state", async () => {
  const f = fixture();
  try {
    f.setInstallationStatus(404);
    const response = await f.handler()(automaticRequest(f));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      installationUrl: "https://github.com/apps/fixture-paws/installations/new",
    });
    expect(f.db.query("SELECT count(*) AS n FROM workspace_github_oauth").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT count(*) AS n FROM workspace_github_connection").get()).toEqual({
      n: 0,
    });
  } finally {
    await f.close();
  }
});

test("connection status remains readable after recent sign-in expires and identifies the recovery", async () => {
  const f = fixture();
  try {
    f.advance(16 * 60_000);
    const response = await f.handler()(automaticRequest(f, "GET"));
    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({ canManage: true, requiresSignIn: true });
    const calls = f.calls.length;
    const denied = await f.handler()(automaticRequest(f));
    expect(denied?.status).toBe(403);
    expect(await denied?.json()).toMatchObject({ code: "reauth_required" });
    expect(f.calls.length).toBe(calls);
    const member = await f.handler()(automaticRequest(f, "POST", "member"));
    expect(await member?.json()).toMatchObject({ code: "admin_required" });
  } finally {
    await f.close();
  }
});

for (const change of ["logout", "demotion", "repositories", "credentials", "expiry"] as const) {
  test(`automatic installation discovery rejects ${change} during GitHub lookup`, async () => {
    const f = fixture();
    const entered = Promise.withResolvers<void>();
    const released = Promise.withResolvers<void>();
    try {
      f.setBeforeInstallation(async () => {
        entered.resolve();
        await released.promise;
      });
      const pending = f.handler()(automaticRequest(f));
      await entered.promise;
      if (change === "logout") deleteWorkspaceSession(f.db, f.sessions.owner!.session.tokenHash);
      if (change === "demotion")
        f.db.run(
          "UPDATE workspace_member SET role='member' WHERE workspace_id='ws' AND user_id='owner'",
        );
      if (change === "repositories")
        replaceWorkspaceRepositories(f.db, {
          workspaceId: "ws",
          actorId: "owner",
          repositories: [],
          now: Date.now(),
        });
      if (change === "credentials") f.env.PAWS_GITHUB_CLIENT_ID = "Iv1.changed";
      if (change === "expiry") f.advance(16 * 60_000);
      released.resolve();
      const response = await pending;
      expect(response?.status).toBe(
        change === "repositories" || change === "credentials" ? 409 : 403,
      );
      expect(f.db.query("SELECT count(*) AS n FROM workspace_github_oauth").get()).toEqual({
        n: 0,
      });
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
    const f = fixture();
    try {
      f.db.run("UPDATE workspace_repository SET repository=? WHERE workspace_id='ws'", [
        repository,
      ]);
      const response = await f.handler()(automaticRequest(f));
      expect(response?.status).toBe(503);
      expect(f.calls).toEqual([]);
      expect(f.db.query("SELECT count(*) AS n FROM workspace_github_oauth").get()).toEqual({
        n: 0,
      });
    } finally {
      await f.close();
    }
  });
}

async function signInForRepositorySetup(f: ReturnType<typeof fixture>) {
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
  f: ReturnType<typeof fixture>,
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
test("GitHub sign-in precedes repository approval and activates selected matches atomically", async () => {
  const f = fixture();
  try {
    f.db.run("DELETE FROM workspace_repository");
    const callback = await signInForRepositorySetup(f);
    expect(f.db.query("SELECT * FROM workspace_repository").all()).toEqual([]);
    expect(f.db.query("SELECT * FROM workspace_github_connection").all()).toEqual([]);
    expect((await f.setup()(f.request("owner", callback.href)))?.status).toBe(403);
    f.restart();
    const catalog = await f.setup()(
      f.request("owner", "https://paws.example/api/workspaces/github-setup"),
    );
    expect(catalog?.status).toBe(200);
    const body = await catalog!.json();
    expect(body).toMatchObject({
      signedIn: true,
      login: "installer",
      repositories: [{ repository: "acme/widgets", private: true }],
      teams: [{ id: "team", name: "Engineering", key: "ENG" }],
      mappings: [],
    });
    expect(JSON.stringify(body)).not.toContain("scripted-user-token");
    expect(JSON.stringify(body)).not.toContain("PRIVATE KEY");
    expect(
      readFileSync(join(f.home, "db.sqlite")).includes(Buffer.from("scripted-user-token")),
    ).toBe(false);
    expect((await saveSetup(f))?.status).toBe(200);
    expect(
      f.db.query("SELECT repository,team_id AS teamId FROM workspace_repository").all(),
    ).toEqual([{ repository: "acme/widgets", teamId: "team" }]);
    expect(
      createWorkspaceGitHubActivation(f.db, f.home, f.env).resolve("acme/widgets").installationId,
    ).toBe("22");
    expect(
      (await f.setup()(f.request("owner", "https://paws.example/api/workspaces/github-setup")))
        ?.status,
    ).toBe(200);
    expect((await saveSetup(f, []))?.status).toBe(200);
    expect(f.db.query("SELECT * FROM workspace_repository").all()).toEqual([]);
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
    const f = fixture();
    try {
      await signInForRepositorySetup(f);
      if (scenario === "expired") f.advance(600_001);
      if (scenario === "demoted")
        f.db.run("UPDATE workspace_member SET role='member' WHERE user_id='owner'");
      if (scenario === "scope") f.db.run("DELETE FROM workspace_repository");
      if (scenario === "credentials") f.env.PAWS_GITHUB_CLIENT_SECRET = "rotated-scripted-secret";
      if (scenario === "rollback")
        f.db.run(
          "CREATE TRIGGER refuse_activation BEFORE UPDATE ON workspace_github_connection BEGIN SELECT RAISE(ABORT,'synthetic rollback'); END",
        );
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
      expect(f.db.query("SELECT * FROM workspace_github_connection").all()).toEqual([]);
      expect(f.db.query("SELECT count(*) AS n FROM workspace_repository").get()).toEqual({
        n: scenario === "scope" ? 0 : 1,
      });
    } finally {
      await f.close();
    }
  });
}
test("repository setup rechecks owner authority while GitHub verification is held", async () => {
  const f = fixture();
  try {
    await signInForRepositorySetup(f);
    f.setBeforeInstallation(async () => {
      f.db.run("UPDATE workspace_member SET role='member' WHERE user_id='owner'");
    });
    expect((await saveSetup(f))?.status).toBe(403);
    expect(f.db.query("SELECT * FROM workspace_github_connection").all()).toEqual([]);
  } finally {
    await f.close();
  }
});

test("repository choices read every user-accessible page and reject duplicate pagination", async () => {
  const f = fixture();
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
