import { expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostedGitHubConnect } from "../src/server";
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
  const now = Date.now();
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
      if (url.pathname === "/user") return Response.json({ id: 7, login: "installer" });
      if (url.pathname === "/app") return Response.json({ id: 99, client_id: "Iv1.fake" });
      if (url.pathname === "/repos/acme/widgets/installation") return Response.json({ id: 22 });
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
      `http://127.0.0.1:${provider.port}${new URL(String(url)).pathname}`,
      init,
    )) as typeof fetch;
  const handler = () =>
    createHostedGitHubConnect({
      db,
      home,
      env,
      origin: "https://paws.example",
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
    request,
    get db() {
      return db;
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
