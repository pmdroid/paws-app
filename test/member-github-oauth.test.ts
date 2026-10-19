import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  deleteWorkspaceSession,
  memberGitHubRecord,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import {
  createWorkspaceAccess,
  createMemberGitHubOAuth,
  issueWorkspaceSession,
  WORKSPACE_COOKIE,
} from "../src/workspace";
import { startServer } from "../src/server";

const PATH = "/api/workspaces/member-github";
const CALLBACK = "/auth/member-github/callback";
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture(configured = true) {
  const root = mkdtempSync(join(tmpdir(), "paws-member-oauth-"));
  const path = join(root, "db.sqlite");
  let db = openDatabase(path);
  migrate(db);
  let now = Date.now();
  for (const id of ["w", "other"])
    db.run("INSERT INTO workspace VALUES(?,?,?,?)", [id, id, id, now]);
  for (const userId of ["alice", "bob"]) {
    putWorkspaceUser(db, {
      id: userId,
      linearUserId: userId,
      name: userId,
      email: `${userId}@example.invalid`,
    });
    for (const workspaceId of ["w", "other"])
      syncWorkspaceMember(db, {
        workspaceId,
        userId,
        role: "member",
        active: true,
        teamIds: [],
        now,
      });
  }
  const alice = issueWorkspaceSession(db, { workspaceId: "w", userId: "alice", now });
  const bob = issueWorkspaceSession(db, { workspaceId: "w", userId: "bob", now });
  const other = issueWorkspaceSession(db, { workspaceId: "other", userId: "alice", now });
  let grant: unknown = {
    access_token: "ghu_fixtureMemberToken",
    token_type: "bearer",
    expires_in: 28800,
    refresh_token: "ghr_fixtureIgnored",
  };
  let account = { id: 123, login: "human", type: "User" };
  let beforeIdentity: (() => Promise<void>) | undefined;
  let beforeExchange: (() => Promise<void>) | undefined;
  let refresh: (() => Promise<void>) | undefined;
  let onboardingAllowed = true;
  const exchanges: URLSearchParams[] = [];
  const http = (async (input, init) => {
    const url = String(input);
    expect(init?.redirect).toBe("error");
    if (url === "https://github.com/login/oauth/access_token") {
      exchanges.push(new URLSearchParams(String(init?.body)));
      await beforeExchange?.();
      return Response.json(grant);
    }
    expect(url).toBe("https://api.github.com/user");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer ghu_fixtureMemberToken");
    await beforeIdentity?.();
    return Response.json(account);
  }) as typeof fetch;
  let handler: ReturnType<typeof createMemberGitHubOAuth>;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(incoming) {
      return (await handler.handle(incoming)) ?? new Response(null, { status: 404 });
    },
  });
  const origin = `http://127.0.0.1:${server.port}`;
  function reconstruct() {
    handler = createMemberGitHubOAuth({
      db,
      origin,
      secretsDir: join(root, "secrets"),
      client: configured
        ? { clientId: "fixture-app-client", clientSecret: "fixture-app-secret" }
        : undefined,
      now: () => now,
      onboarding: (sessionId, generation, binding) =>
        onboardingAllowed &&
        sessionId === "fixture-session" &&
        generation === 0 &&
        binding.userId === "alice",
      fetch: http,
      refresh: async () => {
        await refresh?.();
      },
    });
  }
  reconstruct();
  async function request(
    pathname = PATH,
    method = "GET",
    who = alice,
    cookie = "",
    headers: Record<string, string> = {},
    body?: string,
  ) {
    return fetch(`${origin}${pathname}`, {
      method,
      redirect: "manual",
      headers: {
        cookie: `${WORKSPACE_COOKIE}=${who.token}${cookie ? `; ${cookie}` : ""}`,
        origin,
        "x-paws-csrf": who.session.csrfToken,
        "content-type": "application/json",
        ...headers,
      },
      body,
    });
  }
  async function begin(who = alice) {
    const response = await request(PATH, "POST", who, "", {}, "{}");
    expect(response.status).toBe(200);
    const target = new URL(((await response.json()) as { authorizeUrl: string }).authorizeUrl);
    return { target, cookie: response.headers.get("set-cookie")!.split(";")[0]!, response };
  }
  function callback(pending: Awaited<ReturnType<typeof begin>>, who = alice, query = "") {
    return request(
      `${CALLBACK}?state=${pending.target.searchParams.get("state")}&code=fixture-code${query}`,
      "GET",
      who,
      pending.cookie,
    );
  }
  cleanups.push(() => {
    server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    get db() {
      return db;
    },
    origin,
    alice,
    bob,
    other,
    request,
    begin,
    callback,
    exchanges,
    reconstruct,
    restart() {
      db.close();
      db = openDatabase(path);
      reconstruct();
    },
    advance(ms: number) {
      now += ms;
    },
    setOnboardingAllowed(value: boolean) {
      onboardingAllowed = value;
    },
    setGrant(value: unknown) {
      grant = value;
    },
    setAccount(value: typeof account) {
      account = value;
    },
    beforeIdentity(value: () => Promise<void>) {
      beforeIdentity = value;
    },
    beforeExchange(value: () => Promise<void>) {
      beforeExchange = value;
    },
    refresh(value: () => Promise<void>) {
      refresh = value;
    },
    remove() {
      syncWorkspaceMember(db, {
        workspaceId: "w",
        userId: "alice",
        role: "member",
        active: false,
        teamIds: [],
        now: ++now,
      });
    },
  };
}

test("production HTTP OAuth survives reconstruction and restart, binds PKCE and stores only private member tokens", async () => {
  const f = fixture();
  f.advance(24 * 60 * 60_000);
  const pending = await f.begin();
  expect(pending.target.origin).toBe("https://github.com");
  expect(pending.target.searchParams.get("client_id")).toBe("fixture-app-client");
  expect(pending.target.searchParams.has("scope")).toBe(false);
  expect(pending.response.headers.get("set-cookie")).toContain("Secure; HttpOnly; SameSite=Lax");
  const stored = JSON.stringify(f.db.query("SELECT * FROM member_github_oauth_request").all());
  expect(stored).not.toContain(pending.target.searchParams.get("state")!);
  expect(stored).not.toContain(pending.cookie.split("=")[1]!);
  expect(stored).not.toContain("verifier");
  f.restart();
  const completed = await f.callback(pending);
  expect(completed.status).toBe(303);
  expect(completed.headers.get("location")).toBe(`${f.origin}/status/settings/account`);
  expect(completed.headers.get("set-cookie")).toContain("Max-Age=0");
  const exchange = f.exchanges[0]!;
  expect(exchange.get("client_secret")).toBe("fixture-app-secret");
  expect(exchange.get("redirect_uri")).toBe(`${f.origin}${CALLBACK}`);
  expect(createHash("sha256").update(exchange.get("code_verifier")!).digest("base64url")).toBe(
    pending.target.searchParams.get("code_challenge")!,
  );
  const status = await f.request();
  expect(status.headers.get("cache-control")).toBe("no-store");
  expect(await status.json()).toMatchObject({
    configured: true,
    identity: { id: 123, login: "human" },
  });
  expect(JSON.stringify(f.db.query("SELECT * FROM member_github_account").all())).not.toContain(
    "ghu_",
  );
  for (const file of readdirSync(join(f.root, "secrets"))) {
    const text = readFileSync(join(f.root, "secrets", file)).toString();
    expect(text).not.toContain("ghu_fixture");
    expect(text).not.toContain("ghr_fixture");
  }
  expect((await f.callback(pending)).status).toBe(403);
  expect(f.exchanges.length).toBe(1);
  expect((await f.request(PATH, "DELETE")).status).toBe(200);
  expect(memberGitHubRecord(f.db, "w", "alice")?.secretId).toBeNull();
});

for (const fault of [
  "wrong-user",
  "wrong-workspace",
  "new-session",
  "state",
  "browser",
  "expired",
  "logout",
  "removed",
  "observer",
  "unlink",
  "newer",
] as const) {
  test(`OAuth refuses ${fault} without exchanging a token`, async () => {
    const f = fixture();
    const pending = await f.begin();
    let who = f.alice;
    if (fault === "wrong-user") who = f.bob;
    if (fault === "wrong-workspace") who = f.other;
    if (fault === "new-session")
      who = issueWorkspaceSession(f.db, { workspaceId: "w", userId: "alice", now: Date.now() });
    if (fault === "state") pending.target.searchParams.set("state", "a".repeat(43));
    if (fault === "browser") pending.cookie = `__Host-paws-member-github=${"b".repeat(43)}`;
    if (fault === "expired") f.advance(600_001);
    if (fault === "logout") deleteWorkspaceSession(f.db, f.alice.session.tokenHash);
    if (fault === "removed") f.remove();
    if (fault === "observer")
      f.db.run(
        "UPDATE workspace_member SET role='observer' WHERE workspace_id='w' AND user_id='alice'",
      );
    if (fault === "unlink") await f.request(PATH, "DELETE");
    if (fault === "newer") await f.begin();
    expect([401, 403]).toContain((await f.callback(pending, who)).status);
    expect(f.exchanges.length).toBe(0);
    expect(memberGitHubRecord(f.db, "w", "alice")?.githubId).toBeNull();
  });
}

for (const fault of [
  "membership",
  "logout",
  "unlink",
  "newer",
  "refresh-outage",
  "provider-secret",
] as const) {
  test(`OAuth publication refuses ${fault} during external reads`, async () => {
    const f = fixture();
    const pending = await f.begin();
    f.beforeIdentity(async () => {
      if (fault === "membership") f.remove();
      if (fault === "logout") deleteWorkspaceSession(f.db, f.alice.session.tokenHash);
      if (fault === "unlink") await f.request(PATH, "DELETE");
      if (fault === "newer") await f.begin();
      if (fault === "refresh-outage")
        f.refresh(async () => {
          throw new Error("private-membership-detail");
        });
      if (fault === "provider-secret") throw new Error("ghu_fixtureMemberToken");
    });
    const response = await f.callback(pending);
    expect(response.status).toBe(403);
    expect(await response.text()).not.toContain("ghu_fixture");
    expect(memberGitHubRecord(f.db, "w", "alice")?.githubId).toBeNull();
    expect((await f.callback(pending)).status).not.toBe(303);
  });
}

test("OAuth mutation origin, CSRF, workspace, method and body gates fail closed", async () => {
  const f = fixture();
  for (const headers of [
    { origin: "https://attacker.invalid" },
    { "x-paws-csrf": "bad" },
    { "x-paws-workspace": "other" },
    { host: "attacker.invalid" },
  ] as Record<string, string>[])
    expect((await f.request(PATH, "POST", f.alice, "", headers, "{}")).status).toBe(403);
  expect((await f.request(PATH, "POST", f.alice, "", {}, '{"userId":"bob"}')).status).toBe(400);
  expect((await f.request(PATH, "PUT")).status).toBe(405);
  expect(f.db.query("SELECT * FROM member_github_oauth_request").all()).toEqual([]);
});

test("unconfigured OAuth remains readable and unlinkable but cannot authorize", async () => {
  const f = fixture(false);
  expect(await (await f.request()).json()).toEqual({ configured: false, identity: null });
  expect((await f.request(PATH, "POST", f.alice, "", {}, "{}")).status).toBe(503);
  expect((await f.request(PATH, "DELETE")).status).toBe(200);
  expect(f.exchanges).toEqual([]);
});

for (const grant of [
  { access_token: "ghp_unexpected" },
  { access_token: "ghu_fixtureMemberToken", scope: "repo" },
  { access_token: "ghu_fixtureMemberToken", expires_in: 0 },
  { access_token: "ghu_fixtureMemberToken", expires_in: "3600" },
  { access_token: "ghu_fixtureMemberToken", token_type: "unexpected" },
]) {
  test("invalid or overbroad grant is consumed once without publishing secrets", async () => {
    const f = fixture();
    const pending = await f.begin();
    f.setGrant(grant);
    expect((await f.callback(pending)).status).toBe(403);
    expect((await f.callback(pending)).status).toBe(403);
    expect(f.exchanges.length).toBe(1);
    expect(memberGitHubRecord(f.db, "w", "alice")?.githubId).toBeNull();
  });
}

test("a claimed callback excludes concurrent replay while exchange is pending", async () => {
  const f = fixture();
  const pending = await f.begin();
  let release!: () => void;
  let entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.beforeExchange(async () => {
    entered();
    await held;
  });
  const first = f.callback(pending);
  await started;
  try {
    expect((await f.callback(pending)).status).toBe(403);
    expect(f.exchanges.length).toBe(1);
  } finally {
    release();
  }
  expect((await first).status).toBe(303);
});

test("two members complete separate links, replacement and unlink preserve the other member", async () => {
  const f = fixture();
  const alice = await f.begin();
  const bob = await f.begin(f.bob);
  expect((await f.callback(alice)).status).toBe(303);
  f.setAccount({ id: 456, login: "second-human", type: "User" });
  expect((await f.callback(bob, f.bob)).status).toBe(303);
  const replacement = await f.begin();
  f.setAccount({ id: 789, login: "replacement", type: "User" });
  expect((await f.callback(replacement)).status).toBe(303);
  f.restart();
  expect(memberGitHubRecord(f.db, "w", "alice")?.githubId).toBe(789);
  expect(memberGitHubRecord(f.db, "w", "bob")?.githubId).toBe(456);
  expect((await f.request(PATH, "DELETE")).status).toBe(200);
  expect(memberGitHubRecord(f.db, "w", "bob")?.githubId).toBe(456);
});

test("provider denial consumes state without exchange or link publication", async () => {
  const f = fixture();
  const pending = await f.begin();
  expect((await f.callback(pending, f.alice, "&error=access_denied")).status).toBe(403);
  expect((await f.callback(pending)).status).toBe(403);
  expect(f.exchanges).toEqual([]);
  expect(memberGitHubRecord(f.db, "w", "alice")?.githubId).toBeNull();
});

test("bot identity refuses a human member connection", async () => {
  const f = fixture();
  const pending = await f.begin();
  f.setAccount({ id: 123, login: "fixture-bot", type: "Bot" });
  expect((await f.callback(pending)).status).toBe(403);
  expect(memberGitHubRecord(f.db, "w", "alice")?.githubId).toBeNull();
});

test("public workspace composition exposes member OAuth through the real server route", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-member-oauth-server-"));
  const db = openDatabase(join(root, "db.sqlite"));
  migrate(db);
  const now = Date.now();
  db.run("INSERT INTO workspace VALUES('w','org','Workspace',?)", [now]);
  putWorkspaceUser(db, {
    id: "alice",
    linearUserId: "alice",
    name: "Alice",
    email: "alice@example.invalid",
  });
  syncWorkspaceMember(db, {
    workspaceId: "w",
    userId: "alice",
    role: "member",
    active: true,
    teamIds: [],
    now,
  });
  const alice = issueWorkspaceSession(db, { workspaceId: "w", userId: "alice", now });
  const ready = Promise.withResolvers<ReturnType<typeof createWorkspaceAccess>>();
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    db,
    webhooks: false,
    workspaceAccess: ready.promise,
  });
  const origin = server.url.origin;
  let membershipActive = true;
  let reads = 0;
  const access = createWorkspaceAccess({
    db,
    publicUrl: origin,
    clientId: "linear-client",
    installedOrganization: { id: "org", name: "Workspace" },
    memberGitHub: {
      secretsDir: join(root, "secrets"),
      client: { clientId: "fixture-app-client", clientSecret: "fixture-app-secret" },
    },
    now: () => now,
    memberships: {
      async installation() {
        return { id: "org", name: "Workspace" };
      },
      async member(organizationId, userId) {
        reads++;
        return {
          organizationId,
          userId,
          active: membershipActive,
          guest: false,
          admin: false,
          teamIds: [],
        };
      },
    },
    fetch: (async (input, init) => {
      if (String(input) === "https://github.com/login/oauth/access_token") {
        expect(new URLSearchParams(String(init?.body)).get("client_secret")).toBe(
          "fixture-app-secret",
        );
        return Response.json({ access_token: "ghu_fixtureMemberToken", token_type: "bearer" });
      }
      expect(String(input)).toBe("https://api.github.com/user");
      return Response.json({ id: 123, login: "human", type: "User" });
    }) as typeof fetch,
  });
  ready.resolve(access);
  await Promise.resolve();
  const headers = {
    cookie: `${WORKSPACE_COOKIE}=${alice.token}`,
    origin,
    "x-paws-csrf": alice.session.csrfToken,
    "content-type": "application/json",
  };
  try {
    const status = await fetch(`${origin}${PATH}`, { headers });
    expect(status.status).toBe(200);
    expect(await status.json()).toEqual({ configured: true, identity: null });
    const begin = await fetch(`${origin}${PATH}`, { method: "POST", headers, body: "{}" });
    expect(begin.status).toBe(200);
    const target = new URL(((await begin.json()) as { authorizeUrl: string }).authorizeUrl);
    const callback = `${origin}${CALLBACK}?code=fixture-code&state=${target.searchParams.get("state")}`;
    const completed = await fetch(callback, {
      redirect: "manual",
      headers: { cookie: `${headers.cookie}; ${begin.headers.get("set-cookie")!.split(";")[0]}` },
    });
    expect(completed.status).toBe(303);
    expect(reads).toBe(4);
    expect(memberGitHubRecord(db, "w", "alice")?.githubId).toBe(123);
    const removed = await fetch(`${origin}${PATH}`, { method: "DELETE", headers });
    expect(removed.status).toBe(200);
    expect(memberGitHubRecord(db, "w", "alice")?.secretId).toBeNull();
    membershipActive = false;
    expect((await fetch(`${origin}${PATH}`, { headers })).status).toBe(403);
  } finally {
    await server.stop(true);
    await access.stop();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("workspace member OAuth stays disabled without its explicit workspace configuration", async () => {
  const f = fixture();
  const access = createWorkspaceAccess({
    db: f.db,
    publicUrl: f.origin,
    clientId: "linear-client",
    installedOrganization: { id: "w", name: "Workspace" },
    memberships: {
      async installation() {
        return { id: "w", name: "Workspace" };
      },
      async member(organizationId, userId) {
        return { organizationId, userId, active: true, guest: false, admin: false, teamIds: [] };
      },
    },
  });
  try {
    expect(await access.handle(new Request(`${f.origin}${PATH}`))).toBeNull();
    expect(await access.handle(new Request(`${f.origin}${CALLBACK}`))).toBeNull();
  } finally {
    await access.stop();
  }
});

for (const fault of [
  "none",
  "tampered-cookie",
  "revoked-destination",
  "revoked-during-user",
] as const) {
  test(`onboarding OAuth return remains projection-authorized: ${fault}`, async () => {
    const f = fixture();
    const response = await f.request(
      PATH,
      "POST",
      f.alice,
      "",
      {},
      JSON.stringify({ onboarding: { sessionId: "fixture-session", generation: 0 } }),
    );
    expect(response.status).toBe(200);
    const target = new URL(((await response.json()) as { authorizeUrl: string }).authorizeUrl);
    let cookie = response.headers.get("set-cookie")!.split(";")[0]!;
    if (fault === "tampered-cookie") cookie += "a";
    if (fault === "revoked-destination") f.setOnboardingAllowed(false);
    if (fault === "revoked-during-user")
      f.beforeIdentity(async () => {
        f.setOnboardingAllowed(false);
      });
    f.restart();
    const completed = await f.request(
      `${CALLBACK}?state=${target.searchParams.get("state")}&code=fixture-code`,
      "GET",
      f.alice,
      cookie,
    );
    expect(completed.status).toBe(fault === "none" ? 303 : 403);
    if (fault === "none")
      expect(completed.headers.get("location")).toBe(
        `${f.origin}/status/onboarding/fixture-session/0`,
      );
    else expect(memberGitHubRecord(f.db, "w", "alice")?.githubId).toBeNull();
  });
}

test("onboarding sign-in rejects foreign projections and arbitrary redirects", async () => {
  const f = fixture();
  for (const body of [
    { onboarding: { sessionId: "foreign", generation: 0 } },
    { returnTo: "https://attacker.invalid" },
  ])
    expect((await f.request(PATH, "POST", f.alice, "", {}, JSON.stringify(body))).status).toBe(
      body.onboarding ? 403 : 400,
    );
  expect(f.db.query("SELECT * FROM member_github_oauth_request").all()).toEqual([]);
});
