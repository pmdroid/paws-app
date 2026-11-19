import { afterEach, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import {
  consumeWorkspaceBootstrap,
  deleteCredentialCiphertextSteps,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../src/workspace";
import {
  createSlackConnect,
  createSlackRevocation,
  handleSlackWebhook,
  readSlackApp,
  SLACK_INSTALL_SCOPES,
  slackSigningSecret,
} from "../src/slack";
import { startServer } from "../src/server";
import { writeCredential } from "../src/credentials";
import { pawsPaths } from "../src/config";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const ORIGIN = "https://paws.example";
const env = {
  SLACK_CLIENT_ID: "c",
  SLACK_CLIENT_SECRET: "client-secret",
  SLACK_SIGNING_SECRET: "s",
};
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
type View = {
  reconnect: string | null;
  connection: Record<string, string> | null;
  capabilities: Record<string, { ready: boolean; message?: string }> & { missing: string[] };
};
type Grant = { team: string; scope?: string; app?: string; rotate?: boolean; expiresIn?: number };

async function fixture(appEnv: Record<string, string | undefined> = env) {
  const home = tempHome();
  const { db, close } = await tempStore();
  cleanup.push(close, () => rmSync(home, { recursive: true, force: true }));
  let now = Date.now();
  const grants: Grant[] = [];
  const revoked: string[] = [];
  const refreshed: string[] = [];
  let refreshFails = false;
  const handle = createSlackConnect({
    store: db,
    home,
    env: appEnv,
    origin: ORIGIN,
    now: () => now,
    fetch: async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url.endsWith("/auth.revoke")) revoked.push(auth);
      const form = new URLSearchParams(String(init?.body));
      if (form.get("grant_type") === "refresh_token") {
        const old = form.get("refresh_token")!;
        refreshed.push(old);
        if (refreshFails) return Response.json({ ok: false, error: "invalid_refresh_token" });
        return Response.json({
          ok: true,
          token_type: "bot",
          access_token: `${old}-access`,
          refresh_token: `${old}-next`,
          expires_in: 43200,
        });
      }
      const grant = grants[Number(new URLSearchParams(String(init?.body)).get("code"))]!;
      return Response.json({
        ok: true,
        token_type: "bot",
        access_token: `xoxb-${grant.team}-${grants.length}`,
        scope: grant.scope ?? SLACK_INSTALL_SCOPES.join(","),
        app_id: grant.app ?? "A1",
        ...(grant.rotate
          ? { refresh_token: `xoxe-${grant.team}`, expires_in: grant.expiresIn ?? 43200 }
          : {}),
        bot_user_id: `B${grant.team}`,
        team: { id: grant.team, name: `Team ${grant.team}` },
      });
    },
  });
  const sessions: Record<string, string[]> = {};
  const setRole = (userId: string, value: string) =>
    db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.workspaceMember)
          .set({ role: value })
          .where(eq(q.t.workspaceMember.userId, userId)),
      ),
    );
  async function workspace(id: string, users: Record<string, "admin" | "member">) {
    const at = { workspaceId: id, now };
    for (const user of Object.keys(users))
      await putWorkspaceUser(db, {
        id: user,
        linearUserId: user,
        name: user,
        email: "u@x.invalid",
      });
    const tokenHash = workspaceTokenHash(await issueWorkspaceBootstrap(db, id, now));
    const userId = Object.keys(users)[0]!;
    await consumeWorkspaceBootstrap(db, {
      id,
      organizationId: id,
      name: id,
      userId,
      tokenHash,
      now,
    });
    for (const [user, role] of Object.entries(users)) {
      await syncWorkspaceMember(db, { ...at, userId: user, role, active: true, teamIds: [] });
      const { token, session } = await issueWorkspaceSession(db, { ...at, userId: user });
      sessions[user] = [`${WORKSPACE_COOKIE}=${token}`, session.csrfToken];
    }
  }
  async function call(user: string | null, path: string, method = "GET", body?: object) {
    const [cookie, csrf] = user ? sessions[user]! : [];
    const headers = { origin: ORIGIN, ...(cookie ? { cookie, "x-paws-csrf": csrf! } : {}) };
    return (await handle(
      new Request(ORIGIN + path, { method, headers, body: body && JSON.stringify(body) }),
    ))!;
  }
  async function start(user: string, body: object = {}) {
    const response = await call(user, "/api/workspaces/slack/connect", "POST", body);
    const url = new URL(((await response.json()) as { url: string }).url);
    return url.searchParams.get("state")!;
  }
  async function finish(user: string, state: string, grant: Grant | "deny") {
    const query = new URLSearchParams({ state });
    if (grant === "deny") query.set("error", "access_denied");
    else query.set("code", String(grants.push(grant) - 1));
    const response = await call(user, `/oauth/slack/callback?${query}`);
    expect(response.status).toBe(303);
    return response.headers.get("location")!;
  }
  const secret = "s";
  const revoke = createSlackRevocation({ store: db, home, now: () => now });
  async function event(payload: object) {
    const raw = JSON.stringify({ event_time: Math.floor(Date.now() / 1000), ...payload });
    const time = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac("sha256", secret).update(`v0:${time}:${raw}`).digest("hex")}`;
    const request = new Request(`${ORIGIN}/webhooks/slack`, {
      method: "POST",
      headers: { "x-slack-signature": signature, "x-slack-request-timestamp": time },
      body: raw,
    });
    return handleSlackWebhook(request, secret, Date.now(), revoke);
  }
  const audit = () => db.run((q) => q.all(q.orm.select().from(q.t.workspaceAccessAudit)));
  return {
    db,
    home,
    event,
    audit,
    refreshed,
    failRefresh: (value: boolean) => (refreshFails = value),
    owners: async () =>
      (
        await db.run((q) =>
          q.all(q.orm.select().from(q.t.credential).where(eq(q.t.credential.kind, "slack"))),
        )
      )
        .map((row) => row.workspace)
        .filter((name) => name.startsWith("team:"))
        .sort(),
    workspace,
    setRole,
    call,
    start,
    finish,
    revoked,
    again: async (user: string, grant: Grant | "deny") => finish(user, await start(user), grant),
    status: async (user: string) =>
      (await (await call(user, "/api/workspaces/slack")).json()) as View,
    credentials: async (owners = false) =>
      (
        await db.run((q) =>
          q.all(q.orm.select().from(q.t.credential).where(eq(q.t.credential.kind, "slack"))),
        )
      ).filter((row) => owners || !row.workspace.startsWith("team:")),
    login: (token: Partial<Record<string, string | null>> = {}) =>
      writeCredential(
        db,
        pawsPaths(home).secretsDir,
        "slack",
        JSON.stringify({
          accessToken: "xoxb-login",
          refreshToken: null,
          expiresAtMs: null,
          scope: "chat:write,users:read",
          teamId: "T111111",
          botUserId: "BL",
          appId: "A1",
          teamName: "Login team",
          ...token,
        }),
      ),
    tick: (ms: number) => (now += ms),
  };
}

const APP = { clientId: "c-saved", clientSecret: "cs-saved", signingSecret: "ss-saved" };

test("an admin saves the Slack app and reads back only whether it is configured", async () => {
  const f = await fixture({});
  await f.workspace("ws1", { alice: "admin", bob: "member" });
  const read = async (user: string) => (await f.call(user, "/api/settings/slack-app")).json();
  expect(await read("alice")).toEqual({ configured: false, clientId: null });
  expect((await f.call("alice", "/api/settings/slack-app", "PUT", { clientId: "c" })).status).toBe(
    400,
  );
  expect((await f.call("alice", "/api/settings/slack-app", "PUT", APP)).status).toBe(200);
  const body = await read("alice");
  expect(body).toEqual({ configured: true, clientId: "c-saved" });
  expect(JSON.stringify([body, await f.status("alice")])).not.toMatch(/cs-saved|ss-saved/);
  expect(readSlackApp(f.home)).toEqual(APP);
  expect((await f.call("bob", "/api/settings/slack-app")).status).toBe(403);
  expect((await f.call("bob", "/api/settings/slack-app", "PUT", APP)).status).toBe(403);
  expect((await f.call(null, "/api/settings/slack-app", "PUT", APP)).status).toBe(401);
});

test("server environment values override the saved Slack app", async () => {
  const f = await fixture(env);
  await f.workspace("ws1", { alice: "admin" });
  expect((await f.call("alice", "/api/settings/slack-app", "PUT", APP)).status).toBe(200);
  expect(await (await f.call("alice", "/api/settings/slack-app")).json()).toEqual({
    configured: true,
    clientId: "c",
  });
  expect(await f.status("alice")).toMatchObject({ environment: true });
  expect(slackSigningSecret(f.home, env)).toBe("s");
});

test("Slack events verify with a newly saved signing secret without a restart", async () => {
  const f = await fixture({});
  await f.workspace("ws1", { alice: "admin" });
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    webhooks: false,
    slackSigningSecret: () => slackSigningSecret(f.home, {}),
  });
  const raw = JSON.stringify({ type: "url_verification", challenge: "saved" });
  const send = () => {
    const time = String(Math.floor(Date.now() / 1000));
    const hmac = createHmac("sha256", APP.signingSecret).update(`v0:${time}:${raw}`);
    return fetch(`http://127.0.0.1:${server.port}/webhooks/slack`, {
      method: "POST",
      body: raw,
      headers: {
        "x-slack-request-timestamp": time,
        "x-slack-signature": `v0=${hmac.digest("hex")}`,
      },
    });
  };
  try {
    expect((await send()).status).toBe(401);
    expect((await f.call("alice", "/api/settings/slack-app", "PUT", APP)).status).toBe(200);
    const response = await send();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ challenge: "saved" });
  } finally {
    await server.stop(true);
  }
});

test("an admin installs Slack, returns to Integrations and sees its capabilities", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  const scope = SLACK_INSTALL_SCOPES.filter((name) => name !== "im:history").join(",");
  const location = await f.again("alice", { team: "T111111", scope });
  expect(location).toBe("https://paws.example/dashboard/workspace/integrations?slack=connected");
  const view = await f.status("alice");
  expect(view.connection).toMatchObject({ teamId: "T111111", appId: "A1", botUserId: "BT111111" });
  expect(view.capabilities.threads!.ready).toBe(true);
  expect(view.capabilities.directMessages!.message).toBe("Reconnect Slack to grant im:history.");
  expect(view.capabilities.code!.ready).toBe(false);
  const rows = await f.credentials();
  expect(rows.map((row) => row.workspace)).toEqual(["ws1"]);
  expect(JSON.stringify([view, rows])).not.toContain("xoxb-");
});

test("members, demoted admins, other sessions and expired or replayed state cannot install", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin", bob: "member", carol: "admin" });
  expect((await f.call("bob", "/api/workspaces/slack/connect", "POST", {})).status).toBe(403);
  expect((await f.call(null, "/api/workspaces/slack")).status).toBe(401);
  const demoted = await f.start("alice");
  await f.setRole("alice", "member");
  expect(await f.finish("alice", demoted, { team: "T111111" })).toContain("slack=forbidden");
  await f.setRole("alice", "admin");
  const stolen = await f.start("alice");
  expect(await f.finish("carol", stolen, { team: "T111111" })).toContain("slack=expired");
  const expired = await f.start("alice");
  f.tick(11 * 60_000);
  expect(await f.finish("alice", expired, { team: "T111111" })).toContain("slack=expired");
  const replayed = await f.start("alice");
  expect(await f.finish("alice", replayed, { team: "T111111" })).toContain("slack=connected");
  expect(await f.finish("alice", replayed, { team: "T222222" })).toContain("slack=expired");
  expect((await f.status("alice")).connection!.teamId).toBe("T111111");
});

test("a denial, another team or app keeps the connection, and teams never cross workspaces", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  await f.workspace("ws2", { dave: "admin" });
  await f.again("alice", { team: "T111111" });
  await f.again("dave", { team: "T222222" });
  expect(await f.again("alice", "deny")).toContain("slack=denied");
  expect(await f.again("alice", { team: "T333333" })).toContain("slack=different_team");
  expect(await f.again("alice", { team: "T111111", app: "A9" })).toContain("slack=different_team");
  expect((await f.status("alice")).connection!.teamId).toBe("T111111");
  expect((await f.call("dave", "/api/workspaces/slack", "DELETE")).status).toBe(200);
  expect(f.revoked).toHaveLength(1);
  expect(await f.again("dave", { team: "T111111" })).toContain("slack=team_taken");
  expect(await f.again("dave", { team: "T333333" })).toContain("slack=connected");
  expect((await f.credentials()).map((row) => row.workspace).sort()).toEqual(["ws1", "ws2"]);
});

test("one Slack team binds to one workspace under a race", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  await f.workspace("ws2", { dave: "admin" });
  const [a, b] = [await f.start("alice"), await f.start("dave")];
  const results = await Promise.all([
    f.finish("alice", a, { team: "T111111" }),
    f.finish("dave", b, { team: "T111111" }),
  ]);
  expect(results.map((to) => to.split("slack=")[1]).sort()).toEqual(["connected", "team_taken"]);
});

test("concurrent reconnects commit once, and a stale disconnect keeps the newer token", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  const [a, b] = [await f.start("alice"), await f.start("alice")];
  const results = await Promise.all([
    f.finish("alice", a, { team: "T111111" }),
    f.finish("alice", b, { team: "T111111" }),
  ]);
  expect(results.map((to) => to.split("slack=")[1]).sort()).toEqual(["conflict", "connected"]);
  const stale = (await f.credentials())[0]!.updatedAt;
  await f.again("alice", { team: "T111111" });
  const key = { kind: "slack" as const, workspace: "ws1" };
  expect(await f.db.run((q) => deleteCredentialCiphertextSteps(q, key, stale))).toBe(false);
  expect(await f.credentials()).toHaveLength(1);
});

test("an install started from Slack returns to its channel or the app DM", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  const connect = (body: object) => f.call("alice", "/api/workspaces/slack/connect", "POST", body);
  for (const body of [
    { teamId: "t1" },
    { teamId: "T111111", channelId: "X1" },
    { channelId: "C123456" },
    { teamId: "T111111", channelId: "C1&team=T9" },
  ])
    expect((await connect(body)).status).toBe(400);
  const started = (await (await connect({ teamId: "T111111", channelId: "C123456" })).json()) as {
    url: string;
  };
  const authorize = new URL(started.url);
  expect(authorize.searchParams.get("team")).toBe("T111111");
  const state = authorize.searchParams.get("state")!;
  expect(await f.finish("alice", state, { team: "T111111" })).toBe(
    "https://slack.com/app_redirect?channel=C123456&team=T111111",
  );
  expect(
    await f.finish("alice", await f.start("alice", { teamId: "T111111" }), { team: "T111111" }),
  ).toBe("https://slack.com/app_redirect?app=A1&team=T111111");
  const other = await f.start("alice", { teamId: "T222222", channelId: "C123456" });
  expect(await f.finish("alice", other, { team: "T333333" })).toContain("slack=different_team");
  const denied = await f.start("alice", { teamId: "T111111", channelId: "C123456" });
  expect(await f.finish("alice", denied, "deny")).toContain("slack=denied");
});

test("an admin adopts the paws login slack connection with its scopes, once", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin", bob: "member" });
  await f.workspace("ws2", { dave: "admin" });
  const adopt = (user: string) => f.call(user, "/api/workspaces/slack/adopt", "POST", {});
  expect((await adopt("alice")).status).toBe(404);
  await f.login();
  const view = (await f.status("alice")) as View & { login: Record<string, string> };
  expect(view.login).toEqual({
    teamId: "T111111",
    teamName: "Login team",
    appId: "A1",
    botUserId: "BL",
  });
  expect(JSON.stringify(view)).not.toContain("xoxb-");
  expect((await adopt("bob")).status).toBe(403);
  expect((await f.call(null, "/api/workspaces/slack/adopt", "POST", {})).status).toBe(401);
  const [a, b] = await Promise.all([adopt("alice"), adopt("dave")]);
  expect([a.status, b.status].filter((code) => code === 200)).toHaveLength(1);
  const winner = a.status === 200 ? "alice" : "dave";
  const after = await f.status(winner);
  expect(after.connection).toMatchObject({ teamId: "T111111", botUserId: "BL" });
  expect(after.capabilities.threads!.ready).toBe(false);
  const rows = await f.credentials(true);
  expect(rows.map((row) => row.workspace).sort()).toEqual([
    "team:T111111",
    winner === "alice" ? "ws1" : "ws2",
  ]);
  expect((await adopt(winner)).status).toBe(404);
  const audit = await f.db.run((q) => q.all(q.orm.select().from(q.t.workspaceAccessAudit)));
  expect(audit.filter((row) => row.action === "slack.adopted")).toHaveLength(1);
});

test("adoption refuses a taken team, a rotating token or no app and keeps the login row", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  await f.workspace("ws2", { dave: "admin" });
  await f.again("alice", { team: "T111111" });
  await f.login();
  const adopt = async (user: string) =>
    (
      (await (await f.call(user, "/api/workspaces/slack/adopt", "POST", {})).json()) as {
        code?: string;
      }
    ).code;
  expect(await adopt("alice")).toBe("conflict");
  expect(await adopt("dave")).toBe("team_taken");
  await f.login({ teamId: "T222222", refreshToken: "xoxe-r" });
  expect(await adopt("dave")).toBe("rotating");
  await f.login({ teamId: "T222222", appId: null });
  expect(await adopt("dave")).toBe("different_team");
  expect((await f.credentials(true)).map((row) => row.workspace).sort()).toEqual([
    "installation",
    "team:T111111",
    "ws1",
  ]);
});

test("a rotating token refreshes for its own workspace, and a failed refresh asks for a reconnect", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  await f.workspace("ws2", { dave: "admin" });
  await f.workspace("ws3", { erin: "admin" });
  expect(await f.again("alice", { team: "T111111", rotate: true, expiresIn: 30 })).toContain(
    "slack=connected",
  );
  await f.again("dave", { team: "T222222", rotate: true });
  await f.again("erin", { team: "T333333", rotate: true, expiresIn: 30 });
  const before = Object.fromEntries((await f.credentials()).map((row) => [row.workspace, row]));
  expect((await f.status("alice")).reconnect).toBeNull();
  expect((await f.status("dave")).reconnect).toBeNull();
  expect(f.refreshed).toEqual(["xoxe-T111111"]);
  const after = Object.fromEntries((await f.credentials()).map((row) => [row.workspace, row]));
  expect(after.ws1!.updatedAt).toBeGreaterThan(before.ws1!.updatedAt);
  expect(after.ws2).toEqual(before.ws2!);
  expect(after.ws3).toEqual(before.ws3!);
  expect((await f.status("alice")).connection!.teamId).toBe("T111111");
  expect(f.refreshed).toEqual(["xoxe-T111111"]);
  f.failRefresh(true);
  const failed = await f.status("erin");
  expect(failed.reconnect).toBe("Slack could not refresh its token. Reconnect Slack.");
  expect(JSON.stringify(failed)).not.toContain("xoxe");
  expect((await f.credentials()).find((row) => row.workspace === "ws3")).toEqual(after.ws3!);
  expect((await f.status("dave")).reconnect).toBeNull();
});

test("app_uninstalled and bot tokens_revoked end only that team's installation", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  await f.workspace("ws2", { dave: "admin" });
  await f.again("alice", { team: "T111111" });
  await f.again("dave", { team: "T222222" });
  const revoked = (team: string, bot: string[], oauth: string[] = []) => ({
    type: "event_callback",
    team_id: team,
    api_app_id: "A1",
    event: { type: "tokens_revoked", tokens: { oauth, bot } },
  });
  expect((await f.event(revoked("T111111", [], ["U1"]))).status).toBe(400);
  expect((await f.event(revoked("T111111", ["BT999999"]))).status).toBe(200);
  expect(
    (
      await f.event({
        ...revoked("T111111", []),
        event: { type: "app_uninstalled" },
        api_app_id: "A9",
      })
    ).status,
  ).toBe(200);
  expect((await f.credentials()).map((row) => row.workspace).sort()).toEqual(["ws1", "ws2"]);
  expect((await f.event(revoked("T111111", ["BT111111"]))).status).toBe(200);
  expect((await f.credentials()).map((row) => row.workspace)).toEqual(["ws2"]);
  expect(await f.owners()).toEqual(["team:T222222"]);
  expect((await f.status("alice")).connection).toBeNull();
  const uninstall = {
    type: "event_callback",
    team_id: "T222222",
    api_app_id: "A1",
    event: { type: "app_uninstalled" },
  };
  expect((await f.event(uninstall)).status).toBe(200);
  expect((await f.event(uninstall)).status).toBe(200);
  expect(await f.credentials()).toEqual([]);
  expect(await f.owners()).toEqual([]);
  const audits = (await f.audit()).filter((row) => row.action === "slack.revoked");
  expect(audits.map((row) => [row.workspaceId, row.subject, row.userId])).toEqual([
    ["ws1", "slack:T111111", null],
    ["ws2", "slack:T222222", null],
  ]);
  expect(await f.again("alice", { team: "T222222" })).toContain("slack=connected");
});

test("a delayed or replayed revocation from before a reconnect keeps the newer installation", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  await f.again("alice", { team: "T111111" });
  const uninstall = (event_time?: number) => ({
    type: "event_callback",
    team_id: "T111111",
    api_app_id: "A1",
    event_time,
    event: { type: "app_uninstalled" },
  });
  const earlier = Math.floor(Date.now() / 1000) - 5;
  expect((await f.event(uninstall(earlier))).status).toBe(200);
  expect((await f.event({ ...uninstall(), event_time: "soon" })).status).toBe(400);
  expect((await f.credentials()).map((row) => row.workspace)).toEqual(["ws1"]);
  expect(await f.owners()).toEqual(["team:T111111"]);
  expect((await f.audit()).filter((row) => row.action === "slack.revoked")).toEqual([]);
  expect((await f.event(uninstall(earlier + 10))).status).toBe(200);
  expect(await f.credentials()).toEqual([]);
});
