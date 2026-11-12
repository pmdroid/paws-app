import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { count, like } from "drizzle-orm";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, createHmac } from "node:crypto";
import {
  attributionReturnPath,
  beginGitHubAttribution,
  consumeGitHubAttributionRequest,
  deleteWorkspaceSession,
  githubAttribution,
  openPawsStore,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { setJournalSink } from "../src/journal";
import { seed } from "./dialects";
import { copyMigratedPglite } from "./pglite";

async function fixture(configured = true) {
  const root = mkdtempSync(join(tmpdir(), "paws-attribution-"));
  const path = join(root, "pglite");
  await copyMigratedPglite(path);
  let database = await openPawsStore({ url: null, pgliteDir: path });
  let db = database.store;
  const now = Date.now();
  await seed(db, (q) =>
    q.orm.insert(q.t.workspace).values([
      { id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: now },
      { id: "other", linearOrganizationId: "other-org", name: "Other", createdAt: now },
    ]),
  );
  for (const id of ["alice", "bob"]) {
    await putWorkspaceUser(db, {
      id,
      linearUserId: `linear-${id}`,
      name: id,
      email: `${id}@example.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: id,
      role: "member",
      active: true,
      teamIds: ["team"],
      now,
    });
  }
  await syncWorkspaceMember(db, {
    workspaceId: "other",
    userId: "alice",
    role: "member",
    active: true,
    teamIds: ["team"],
    now,
  });
  const alice = await issueWorkspaceSession(db, {
    workspaceId: "workspace",
    userId: "alice",
    now,
  });
  const bob = await issueWorkspaceSession(db, {
    workspaceId: "workspace",
    userId: "bob",
    now,
  });
  const other = await issueWorkspaceSession(db, {
    workspaceId: "other",
    userId: "alice",
    now,
  });
  let active = true;
  let guest = false;
  let tokenScope = "";
  let accountType = "User";
  let beforeUser: (() => Promise<void>) | undefined;
  let calls = 0;
  let pkce = "";
  let clock = 0;
  let exchangeGrant: Record<string, unknown> = {};
  const refreshes: string[] = [];
  let refreshAnswer: (refreshToken: string) => Response = () =>
    Response.json({ error: "bad_refresh_token" });
  const provider = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      calls++;
      if (new URL(request.url).pathname === "/login/oauth/access_token") {
        const body = new URLSearchParams(await request.text());
        pkce = body.get("code_verifier")!;
        expect(body.get("client_secret")).toBe("fixture-client-secret");
        if (body.get("grant_type") === "refresh_token") {
          refreshes.push(body.get("refresh_token")!);
          return refreshAnswer(body.get("refresh_token")!);
        }
        return Response.json({
          access_token: "ghu_fixtureIdentityOnly",
          scope: tokenScope,
          ...exchangeGrant,
        });
      }
      expect(request.headers.get("authorization")).toBe(
        `Bearer ${String(exchangeGrant["access_token"] ?? "ghu_fixtureIdentityOnly")}`,
      );
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
      store: db,
      publicUrl: origin,
      clientId: "linear-client",
      installedOrganization: { id: "org", name: "Workspace" },
      now: () => now + clock,
      secretsDir: join(root, "secrets"),
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
  async function begin(body: Record<string, boolean> = { consent: true }) {
    const response = await request("POST", alice, body);
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
    get access() {
      return access;
    },
    refreshes,
    set clock(value: number) {
      clock = value;
    },
    set exchangeGrant(value: Record<string, unknown>) {
      exchangeGrant = value;
    },
    set refreshAnswer(value: (refreshToken: string) => Response) {
      refreshAnswer = value;
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
      await database.close();
      database = await openPawsStore({ url: null, pgliteDir: path });
      db = database.store;
      reconstruct();
    },
    async close() {
      await server.stop(true);
      await provider.stop(true);
      await access.stop();
      await database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("self-link persists verified consent over HTTP and a database restart with single-use PKCE and no token storage", async () => {
  const f = await fixture();
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
    expect(await githubAttribution(f.db, "workspace", "alice")).toEqual({
      id: 12345,
      login: "verified-human",
      name: "Human Injected",
      email: "12345+verified-human@users.noreply.github.com",
    });
    expect((await f.callback(pending)).status).toBe(403);
    expect(f.calls).toBe(2);
    await f.restart();
    expect((await githubAttribution(f.db, "workspace", "alice"))?.id).toBe(12345);
    expect((await f.request("DELETE")).status).toBe(200);
    expect(await githubAttribution(f.db, "workspace", "alice")).toBeNull();
    const audit = await f.db.run((q) =>
      q.all(
        q.orm
          .select({ action: q.t.workspaceAccessAudit.action })
          .from(q.t.workspaceAccessAudit)
          .where(like(q.t.workspaceAccessAudit.action, "github.%")),
      ),
    );
    expect(audit.map((row) => row.action)).toEqual([
      "github.attribution.consented",
      "github.attribution.revoked",
    ]);
    await f.restart();
    const stored = readdirSync(f.path, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => readFileSync(join(entry.parentPath, entry.name)).toString("latin1"));
    expect(stored.length).toBeGreaterThan(0);
    expect(stored.some((text) => text.includes("ghu_fixtureIdentityOnly"))).toBe(false);
    expect(stored.some((text) => text.includes("fixture-client-secret"))).toBe(false);
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
  "expired-session",
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
    const f = await fixture();
    try {
      const pending = await f.begin();
      let session = f.alice;
      let overrides = "";
      if (scenario === "stale-inactive" || scenario === "stale-guest") {
        await seed(f.db, (q) => q.orm.update(q.t.workspaceMember).set({ checkedAt: f.now + 1 }));
        if (scenario === "stale-inactive") f.active = false;
        else f.guest = true;
      }
      if (scenario === "wrong-user") session = f.bob;
      if (scenario === "wrong-workspace") session = f.other;
      if (scenario === "wrong-state") overrides = "&state=duplicate";
      if (scenario === "wrong-browser")
        pending.cookie = `__Host-paws-attribution=${"b".repeat(43)}`;
      if (scenario === "expired-state")
        await seed(f.db, (q) =>
          q.orm.update(q.t.githubAttributionRequest).set({ expiresAt: f.now }),
        );
      if (scenario === "expired-session")
        await seed(f.db, (q) => q.orm.update(q.t.workspaceSession).set({ expiresAt: f.now }));
      if (scenario === "logout") await deleteWorkspaceSession(f.db, f.alice.session.tokenHash);
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
          await deleteWorkspaceSession(f.db, f.alice.session.tokenHash);
        };
      if (scenario === "demote-inflight")
        f.beforeUser = async () => {
          f.guest = true;
        };
      if (scenario === "wrong-state") pending.target.searchParams.set("state", "a".repeat(43));
      expect([401, 403]).toContain((await f.callback(pending, session, overrides)).status);
      expect(await githubAttribution(f.db, "workspace", "alice")).toBeNull();
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
  const f = await fixture(false);
  try {
    const response = await f.request("GET");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: false,
      identity: null,
      pullRequestsAsMember: { available: false, enabled: false },
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
    expect(
      await f.db.run((q) => q.one(q.orm.select({ n: count() }).from(q.t.githubAttributionRequest))),
    ).toEqual({ n: 0 });
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
    expect(await githubAttribution(f.db, "workspace", "alice")).toBeNull();
    expect((await f.callback(pending)).status).toBe(403);
  } finally {
    await f.close();
  }
});

test("an older sign-in can still change its own attribution while the session is valid", async () => {
  const f = await fixture();
  try {
    const pending = await f.begin();
    expect((await f.callback(pending)).status).toBe(303);
    await seed(f.db, (q) =>
      q.orm.update(q.t.workspaceSession).set({ authenticatedAt: f.now - 2 * 24 * 60 * 60_000 }),
    );
    const status = await f.request("GET");
    expect(status.status).toBe(200);
    const body = await status.json();
    expect(body).toMatchObject({ configured: true, identity: { login: "verified-human" } });
    expect(body).not.toHaveProperty("requiresSignIn");
    expect((await f.request("DELETE")).status).toBe(200);
    expect(await githubAttribution(f.db, "workspace", "alice")).toBeNull();
    expect((await f.request("GET", f.other)).status).toBe(403);
    f.guest = true;
    expect((await f.request("GET")).status).toBe(403);
  } finally {
    await f.close();
  }
});

test("the Settings link returns to Settings, and a forged return_path never leaves the two allowed pages", async () => {
  const f = await fixture();
  try {
    const pending = await f.begin();
    expect(
      await f.db.run((q) =>
        q.one(
          q.orm
            .select({ returnPath: q.t.githubAttributionRequest.returnPath })
            .from(q.t.githubAttributionRequest),
        ),
      ),
    ).toEqual({ returnPath: null });
    const back = await f.callback(
      pending,
      f.alice,
      "&return_path=%2Fonboard%2FAAAAAAAAAAAAAAAAAAAAAAAAAA",
    );
    expect(back.headers.get("location")).toBe(
      `${new URL(pending.target.searchParams.get("redirect_uri")!).origin}/dashboard/settings/account`,
    );

    const onboarding = "/onboard/ABCDEFGHJKMNPQRSTVWXYZ0123";
    for (const forged of [
      "https://evil.example/",
      "//evil.example/onboard/ABCDEFGHJKMNPQRSTVWXYZ0123",
      "/onboard/../status",
      "/onboard/ABCDEFGHJKMNPQRSTVWXYZ0123/github",
      "/onboard/ABCDEFGHJKMNPQRSTVWXYZ012?x=1",
      "/status/settings/account/../../admin",
      "/status",
      "/status/settings/account",
      "/dashboard",
      "/dashboard/settings/account/../../admin",
      "",
    ]) {
      expect(attributionReturnPath(forged)).toBe("/dashboard/settings/account");
      await expect(
        beginGitHubAttribution(f.db, binding(f), {
          stateHash: "s".repeat(43),
          browserHash: "b".repeat(43),
          now: f.now,
          returnPath: forged,
        }),
      ).rejects.toThrow();
    }
    expect(attributionReturnPath(onboarding)).toBe(onboarding);
    expect(attributionReturnPath("/dashboard/settings/account")).toBe(
      "/dashboard/settings/account",
    );
    expect(attributionReturnPath(null)).toBe("/dashboard/settings/account");

    // The database refuses a forged path written past the helpers, and a damaged row reads as Settings.
    await beginGitHubAttribution(f.db, binding(f), {
      stateHash: "s".repeat(43),
      browserHash: "b".repeat(43),
      now: f.now,
      returnPath: onboarding,
    });
    await expect(
      seed(f.db, (q) =>
        q.orm.update(q.t.githubAttributionRequest).set({ returnPath: "https://evil.example/" }),
      ),
    ).rejects.toThrow();
    expect(
      (
        await consumeGitHubAttributionRequest(f.db, binding(f), {
          stateHash: "s".repeat(43),
          browserHash: "b".repeat(43),
          now: f.now,
        })
      ).returnPath,
    ).toBe(onboarding);
  } finally {
    await f.close();
  }
});

function binding(f: Awaited<ReturnType<typeof fixture>>) {
  return { workspaceId: "workspace", userId: "alice", sessionHash: f.alice.session.tokenHash };
}

const GRANT = {
  access_token: "ghu_fixtureUserToken",
  expires_in: 28_800,
  refresh_token: "ghr_fixtureRefresh",
  refresh_token_expires_in: 15_897_600,
};

function grantFiles(root: string): string[] {
  if (!existsSync(join(root, "secrets"))) return [];
  return readdirSync(join(root, "secrets")).filter((name) => name.startsWith("github-user-grant-"));
}

test("opting in seals the user grant, refreshes it near expiry and clears it when GitHub refuses", async () => {
  const f = await fixture();
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  try {
    f.exchangeGrant = GRANT;
    expect((await f.callback(await f.begin())).status).toBe(303);
    expect(grantFiles(f.root)).toEqual([]);
    const pending = await f.begin({ consent: true, pullRequestsAsMember: true });
    expect((await f.callback(pending)).status).toBe(303);
    const [name] = grantFiles(f.root);
    const sealed = readFileSync(join(f.root, "secrets", name!), "utf8");
    expect(sealed).toStartWith("paws-envelope-v1\n");
    expect(sealed).not.toMatch(/gh[ur]_/);
    expect(await (await f.request("GET")).json()).toMatchObject({
      pullRequestsAsMember: { available: true, enabled: true },
    });
    expect(await f.access.githubUserToken("workspace", "alice")).toBe("ghu_fixtureUserToken");

    f.clock = (28_800 - 299) * 1000;
    f.refreshAnswer = () =>
      Response.json({ ...GRANT, access_token: "ghu_refreshed", refresh_token: "ghr_rotated" });
    expect(
      await Promise.all([
        f.access.githubUserToken("workspace", "alice"),
        f.access.githubUserToken("workspace", "alice"),
      ]),
    ).toEqual(["ghu_refreshed", "ghu_refreshed"]);
    await f.restart();
    expect(await f.access.githubUserToken("workspace", "alice")).toBe("ghu_refreshed");

    f.clock = 2 * 28_800 * 1000;
    for (const status of [503, 429]) {
      f.refreshAnswer = () => Response.json({ error: "unavailable" }, { status });
      expect(await f.access.githubUserToken("workspace", "alice")).toBeNull();
      expect(grantFiles(f.root)).toHaveLength(1);
    }
    f.refreshAnswer = () => Response.json({ error: "bad_refresh_token" });
    expect(await f.access.githubUserToken("workspace", "alice")).toBeNull();
    expect(f.refreshes).toEqual(["ghr_fixtureRefresh", ...Array(3).fill("ghr_rotated")]);
    expect(grantFiles(f.root)).toEqual([]);
    expect(lines.join("\n")).not.toMatch(/gh[ur]_/);
  } finally {
    restore();
    await f.close();
  }
});

test("opting out and revoking delete the grant; re-linking without the opt-in keeps it", async () => {
  const f = await fixture();
  try {
    f.exchangeGrant = GRANT;
    const optIn = async () => {
      const pending = await f.begin({ consent: true, pullRequestsAsMember: true });
      expect((await f.callback(pending)).status).toBe(303);
      expect(grantFiles(f.root)).toHaveLength(1);
    };
    await optIn();
    expect((await f.request("POST", f.alice, { pullRequestsAsMember: "yes" })).status).toBe(400);
    expect((await f.request("POST", f.alice, { pullRequestsAsMember: false })).status).toBe(200);
    expect(grantFiles(f.root)).toEqual([]);
    expect(await f.access.githubUserToken("workspace", "alice")).toBeNull();
    expect((await githubAttribution(f.db, "workspace", "alice"))?.id).toBe(12345);

    await optIn();
    expect((await f.callback(await f.begin())).status).toBe(303);
    expect(grantFiles(f.root)).toHaveLength(1);

    for (const damaged of ["not an envelope", "paws-envelope-v1\n{"]) {
      if (grantFiles(f.root).length === 0) await optIn();
      writeFileSync(join(f.root, "secrets", grantFiles(f.root)[0]!), damaged);
      const status = await (await f.request("GET")).json();
      expect(status).toMatchObject({ pullRequestsAsMember: { enabled: false } });
      expect(grantFiles(f.root)).toEqual([]);
    }

    await optIn();
    expect((await f.request("DELETE")).status).toBe(200);
    expect(grantFiles(f.root)).toEqual([]);

    f.exchangeGrant = { ...GRANT, refresh_token: "not-a-refresh-token" };
    const unkept = await f.begin({ consent: true, pullRequestsAsMember: true });
    expect((await f.callback(unkept)).status).toBe(303);
    expect(grantFiles(f.root)).toEqual([]);
    expect((await githubAttribution(f.db, "workspace", "alice"))?.id).toBe(12345);
  } finally {
    await f.close();
  }
});
