import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import {
  deleteWorkspaceSession,
  githubAttribution,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";

function fixture(configured = true) {
  const root = mkdtempSync(join(tmpdir(), "paws-attribution-"));
  const path = join(root, "db.sqlite");
  let db = openDatabase(path);
  migrate(db);
  const now = Date.now();
  db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',?)", [now]);
  db.run("INSERT INTO workspace VALUES('other','other-org','Other',?)", [now]);
  for (const id of ["alice", "bob"]) {
    putWorkspaceUser(db, {
      id,
      linearUserId: `linear-${id}`,
      name: id,
      email: `${id}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: id,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
  }
  syncWorkspaceMember(db, {
    workspaceId: "other",
    userId: "alice",
    role: "member",
    active: true,
    teamIds: ["team"],
    now,
  });
  const alice = issueWorkspaceSession(db, { workspaceId: "workspace", userId: "alice", now });
  const bob = issueWorkspaceSession(db, { workspaceId: "workspace", userId: "bob", now });
  const other = issueWorkspaceSession(db, { workspaceId: "other", userId: "alice", now });
  let active = true;
  let guest = false;
  let tokenScope = "";
  let accountType = "User";
  let beforeUser: (() => Promise<void>) | undefined;
  let calls = 0;
  let pkce = "";
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++;
      if (new URL(request.url).pathname === "/login/oauth/access_token") {
        const body = new URLSearchParams(await request.text());
        pkce = body.get("code_verifier")!;
        expect(body.get("client_secret")).toBe("fixture-client-secret");
        return Response.json({ access_token: "ghu_fixtureIdentityOnly", scope: tokenScope });
      }
      expect(request.headers.get("authorization")).toBe("Bearer ghu_fixtureIdentityOnly");
      await beforeUser?.();
      return Response.json({
        id: 12345,
        login: "verified-human",
        type: accountType,
        name: "Human\r\n<Injected>\u202e",
      });
    },
  });
  let access: ReturnType<typeof createWorkspaceAccess>;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      return (await access.handle(request)) ?? new Response(null, { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  function reconstruct() {
    access = createWorkspaceAccess({
      db,
      publicUrl: origin,
      clientId: "linear-client",
      installedOrganization: { id: "org", name: "Workspace" },
      now: () => now,
      githubAttributionClient: configured
        ? { clientId: "app-client", clientSecret: "fixture-client-secret" }
        : undefined,
      memberships: {
        async installation() {
          return { id: "org", name: "Workspace" };
        },
        async member(organizationId, userId) {
          return { organizationId, userId, active, guest, admin: false, teamIds: ["team"] };
        },
      },
      fetch: ((input, init) => {
        const url = new URL(String(input));
        expect(["https://github.com", "https://api.github.com"]).toContain(url.origin);
        expect(["/login/oauth/access_token", "/user"]).toContain(url.pathname);
        return fetch(`http://127.0.0.1:${provider.port}${url.pathname}`, init);
      }) as typeof fetch,
    });
  }
  reconstruct();
  const request = (
    method: string,
    session = alice,
    body?: unknown,
    csrf = session.session.csrfToken,
  ) =>
    fetch(`${origin}/api/workspaces/github-attribution`, {
      method,
      headers: {
        cookie: `${WORKSPACE_COOKIE}=${session.token}`,
        origin,
        "x-paws-csrf": csrf,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  async function begin() {
    const response = await request("POST", alice, { consent: true });
    expect(response.status).toBe(200);
    const target = new URL(((await response.json()) as { authorizeUrl: string }).authorizeUrl);
    expect(target.searchParams.has("scope")).toBe(false);
    expect(target.pathname).toBe("/login/oauth/authorize");
    const cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    return { target, cookie };
  }
  const callback = (pending: Awaited<ReturnType<typeof begin>>, session = alice, overrides = "") =>
    fetch(
      `${origin}/auth/github-attribution/callback?state=${pending.target.searchParams.get("state")}&code=fixture${overrides}`,
      {
        redirect: "manual",
        headers: { cookie: `${WORKSPACE_COOKIE}=${session.token}; ${pending.cookie}` },
      },
    );
  return {
    root,
    path,
    now,
    alice,
    bob,
    other,
    request,
    begin,
    callback,
    get db() {
      return db;
    },
    get calls() {
      return calls;
    },
    get pkce() {
      return pkce;
    },
    set active(value: boolean) {
      active = value;
    },
    set guest(value: boolean) {
      guest = value;
    },
    set scope(value: string) {
      tokenScope = value;
    },
    set type(value: string) {
      accountType = value;
    },
    set beforeUser(value: (() => Promise<void>) | undefined) {
      beforeUser = value;
    },
    async restart(nextConfigured = configured) {
      configured = nextConfigured;
      await access.stop();
      db.close();
      db = openDatabase(path);
      reconstruct();
    },
    async close() {
      await server.stop(true);
      await provider.stop(true);
      await access.stop();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("self-link persists verified consent over HTTP and SQLite restart with single-use PKCE and no token storage", async () => {
  const f = fixture();
  try {
    expect((await f.request("POST", f.alice, { consent: false })).status).toBe(400);
    expect((await f.request("POST", f.alice, { consent: true }, "wrong")).status).toBe(403);
    const pending = await f.begin();
    await f.restart();
    expect((await f.callback(pending)).status).toBe(303);
    expect(createHash("sha256").update(f.pkce).digest("base64url")).toBe(
      pending.target.searchParams.get("code_challenge")!,
    );
    expect(f.pkce).toBe(
      createHmac("sha256", pending.cookie.split("=")[1]!)
        .update(pending.target.searchParams.get("state")!)
        .digest("base64url"),
    );
    expect(githubAttribution(f.db, "workspace", "alice")).toEqual({
      id: 12345,
      login: "verified-human",
      name: "Human Injected",
      email: "12345+verified-human@users.noreply.github.com",
    });
    expect((await f.callback(pending)).status).toBe(403);
    expect(f.calls).toBe(2);
    await f.restart();
    expect(githubAttribution(f.db, "workspace", "alice")?.id).toBe(12345);
    expect((await f.request("DELETE")).status).toBe(200);
    expect(githubAttribution(f.db, "workspace", "alice")).toBeNull();
    const audit = f.db
      .query<{ action: string }, []>(
        "SELECT action FROM workspace_access_audit WHERE action LIKE 'github.%'",
      )
      .all();
    expect(audit.map((row) => row.action)).toEqual([
      "github.attribution.consented",
      "github.attribution.revoked",
    ]);
    expect(readFileSync(f.path).includes(Buffer.from("ghu_fixtureIdentityOnly"))).toBe(false);
    expect(readFileSync(f.path).includes(Buffer.from("fixture-client-secret"))).toBe(false);
  } finally {
    await f.close();
  }
});

for (const scenario of [
  "wrong-user",
  "wrong-workspace",
  "wrong-state",
  "wrong-browser",
  "expired-state",
  "stale-auth",
  "stale-inactive",
  "stale-guest",
  "logout",
  "demotion",
  "removed",
  "personal-scope",
  "bot",
  "revoke-inflight",
  "logout-inflight",
  "demote-inflight",
] as const) {
  test(`self-link rejects ${scenario}`, async () => {
    const f = fixture();
    try {
      const pending = await f.begin();
      let session = f.alice;
      let overrides = "";
      if (scenario === "stale-inactive" || scenario === "stale-guest") {
        f.db.run("UPDATE workspace_member SET checked_at=?", [f.now + 1]);
        if (scenario === "stale-inactive") f.active = false;
        else f.guest = true;
      }
      if (scenario === "wrong-user") session = f.bob;
      if (scenario === "wrong-workspace") session = f.other;
      if (scenario === "wrong-state") overrides = "&state=duplicate";
      if (scenario === "wrong-browser")
        pending.cookie = `__Host-paws-attribution=${"b".repeat(43)}`;
      if (scenario === "expired-state")
        f.db.run("UPDATE github_attribution_request SET expires_at=?", [f.now]);
      if (scenario === "stale-auth")
        f.db.run("UPDATE workspace_session SET authenticated_at=?", [f.now - 900_001]);
      if (scenario === "logout") deleteWorkspaceSession(f.db, f.alice.session.tokenHash);
      if (scenario === "demotion") f.guest = true;
      if (scenario === "removed") f.active = false;
      if (scenario === "personal-scope") f.scope = "repo";
      if (scenario === "bot") f.type = "Bot";
      if (scenario === "revoke-inflight")
        f.beforeUser = async () => {
          expect((await f.request("DELETE")).status).toBe(200);
        };
      if (scenario === "logout-inflight")
        f.beforeUser = async () => {
          deleteWorkspaceSession(f.db, f.alice.session.tokenHash);
        };
      if (scenario === "demote-inflight")
        f.beforeUser = async () => {
          f.guest = true;
        };
      if (scenario === "wrong-state") pending.target.searchParams.set("state", "a".repeat(43));
      expect([401, 403]).toContain((await f.callback(pending, session, overrides)).status);
      expect(githubAttribution(f.db, "workspace", "alice")).toBeNull();
      if (
        ["wrong-user", "wrong-workspace", "wrong-state", "logout", "demotion", "removed"].includes(
          scenario,
        )
      )
        expect(f.calls).toBe(0);
    } finally {
      await f.close();
    }
  });
}

test("missing App credentials keep attribution readable and revocable without starting OAuth", async () => {
  const f = fixture(false);
  try {
    const response = await f.request("GET");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: false,
      identity: null,
      requiresSignIn: false,
    });
    const start = await f.request("POST", f.alice, { consent: true });
    expect(start.status).toBe(503);
    expect(await start.json()).toEqual({
      error: "Ask the Paws operator to configure the GitHub App on the server, then restart Paws.",
    });
    expect((await f.request("POST", f.alice, { consent: true }, "wrong")).status).toBe(403);
    expect((await f.request("GET", f.other)).status).toBe(403);
    expect((await f.request("GET", { ...f.alice, token: "invalid" })).status).toBe(401);
    expect(f.calls).toBe(0);
    expect(f.db.query("SELECT count(*) AS n FROM github_attribution_request").get()).toEqual({
      n: 0,
    });
    await f.restart(true);
    const interrupted = await f.begin();
    await f.restart(false);
    expect((await f.callback(interrupted)).status).toBe(503);
    await f.restart(true);
    expect((await f.callback(interrupted)).status).toBe(403);
    const pending = await f.begin();
    expect((await f.callback(pending)).status).toBe(303);
    await f.restart(false);
    const saved = await f.request("GET");
    expect(await saved.json()).toMatchObject({
      configured: false,
      identity: { login: "verified-human" },
    });
    expect((await f.request("DELETE")).status).toBe(200);
    expect(githubAttribution(f.db, "workspace", "alice")).toBeNull();
    expect((await f.callback(pending)).status).toBe(403);
  } finally {
    await f.close();
  }
});

test("stale sign-in keeps own attribution readable and requires fresh sign-in before changes", async () => {
  const f = fixture();
  try {
    const pending = await f.begin();
    expect((await f.callback(pending)).status).toBe(303);
    f.db.run("UPDATE workspace_session SET authenticated_at=?", [f.now - 900_001]);
    const status = await f.request("GET");
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      configured: true,
      identity: { login: "verified-human" },
      requiresSignIn: true,
    });
    for (const method of ["POST", "DELETE"]) {
      const denied = await f.request(
        method,
        f.alice,
        method === "POST" ? { consent: true } : undefined,
      );
      expect(denied.status).toBe(403);
      expect(await denied.json()).toMatchObject({ code: "reauth_required" });
    }
    expect(githubAttribution(f.db, "workspace", "alice")?.login).toBe("verified-human");
    expect((await f.request("GET", f.other)).status).toBe(403);
    f.guest = true;
    expect((await f.request("GET")).status).toBe(403);
  } finally {
    await f.close();
  }
});
