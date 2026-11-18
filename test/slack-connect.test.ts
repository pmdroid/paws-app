import { afterEach, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { consumeWorkspaceBootstrap, putWorkspaceUser, syncWorkspaceMember } from "../src/db";
import { readCredential, writeCredential } from "../src/credentials";
import {
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
} from "../src/workspace";
import { createSlackConnect, revokeSlackTeam, SLACK_INSTALL_SCOPES } from "../src/slack";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const ORIGIN = "https://paws.example";
const env = {
  SLACK_CLIENT_ID: "synthetic-client",
  SLACK_CLIENT_SECRET: "synthetic-client-secret",
  SLACK_SIGNING_SECRET: "synthetic-signing-secret",
};
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

type Capability = { ready: boolean; missing?: string[]; message?: string };
type View = {
  connection: { status: string; teamId: string; source: string };
  capabilities: Record<"threads" | "directMessages" | "agent" | "code", Capability> & {
    granted: string[];
    missing: string[];
  };
  manifest: {
    oauth_config: { redirect_urls: string[] };
    settings: { event_subscriptions: { bot_events: string[] } };
  };
  cli: unknown;
};
type Grant = { team: string; scope?: string; app?: string; bot?: string };

async function fixture() {
  const home = tempHome();
  const { db, close } = await tempStore();
  cleanup.push(close, () => rmSync(home, { recursive: true, force: true }));
  let now = Date.now();
  const grants = new Map<string, Grant>();
  const revoked: string[] = [];
  const slackFetch = async (url: string, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization") ?? "";
    if (url.endsWith("/oauth.v2.access")) {
      const grant = grants.get(new URLSearchParams(String(init?.body)).get("code")!);
      if (!grant) return Response.json({ ok: false, error: env.SLACK_CLIENT_SECRET });
      return Response.json({
        ok: true,
        token_type: "bot",
        access_token: `xoxb-${grant.team}-${grants.size}`,
        scope: grant.scope ?? SLACK_INSTALL_SCOPES.join(","),
        app_id: grant.app ?? "A1",
        bot_user_id: grant.bot ?? `B${grant.team}`,
        team: { id: grant.team, name: `Team ${grant.team}` },
      });
    }
    const team = auth.split("-")[1];
    if (url.endsWith("/auth.test"))
      return Response.json({ ok: true, team_id: team, user_id: `B${team}` });
    if (url.endsWith("/auth.revoke")) revoked.push(auth);
    return Response.json({ ok: true });
  };
  const handle = createSlackConnect({
    store: db,
    home,
    env,
    origin: ORIGIN,
    fetch: slackFetch,
    now: () => now,
  });
  const sessions: Record<string, { cookie: string; csrf: string }> = {};
  async function member(workspaceId: string, userId: string, role: "admin" | "member") {
    await syncWorkspaceMember(db, { workspaceId, userId, role, active: true, teamIds: [], now });
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.workspaceMember)
          .set({ role })
          .where(
            and(
              eq(q.t.workspaceMember.workspaceId, workspaceId),
              eq(q.t.workspaceMember.userId, userId),
            ),
          ),
      ),
    );
  }
  async function workspace(id: string, users: Record<string, "admin" | "member">) {
    const owner = Object.keys(users)[0]!;
    for (const user of Object.keys(users))
      await putWorkspaceUser(db, {
        id: user,
        linearUserId: user,
        name: user,
        email: `${user}@x.invalid`,
      });
    await consumeWorkspaceBootstrap(db, {
      id,
      organizationId: `org-${id}`,
      name: id,
      userId: owner,
      tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, `org-${id}`, now)),
      now,
    });
    for (const [user, role] of Object.entries(users)) {
      await member(id, user, role);
      const issued = await issueWorkspaceSession(db, { workspaceId: id, userId: user, now });
      sessions[user] = {
        cookie: `${WORKSPACE_COOKIE}=${issued.token}`,
        csrf: issued.session.csrfToken,
      };
    }
  }
  async function call(user: string | null, path: string, method = "GET", body?: unknown) {
    const session = user ? sessions[user]! : null;
    const response = await handle(
      new Request(ORIGIN + path, {
        method,
        headers: {
          origin: ORIGIN,
          ...(session ? { cookie: session.cookie, "x-paws-csrf": session.csrf } : {}),
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
    );
    return response!;
  }
  async function start(user: string, intent = "install", returnTo?: object) {
    const response = await call(user, "/api/workspaces/slack/connect", "POST", {
      intent,
      returnTo,
    });
    expect(response.status).toBe(200);
    const url = new URL(((await response.json()) as { url: string }).url);
    expect(url.searchParams.get("scope")).toBe(SLACK_INSTALL_SCOPES.join(","));
    expect(url.searchParams.has("user_scope")).toBe(false);
    return url.searchParams.get("state")!;
  }
  async function finish(user: string, state: string, grant: Grant | "deny") {
    const query = new URLSearchParams({ state });
    if (grant === "deny") query.set("error", "access_denied");
    else {
      const code = `code-${grants.size + 1}`;
      grants.set(code, grant);
      query.set("code", code);
    }
    const response = await call(user, `/oauth/slack/callback?${query}`);
    expect(response.status).toBe(303);
    return response.headers.get("location")!;
  }
  const status = async (user: string) =>
    (await (await call(user, "/api/workspaces/slack")).json()) as View;
  const credentials = () =>
    db.run((q) =>
      q.all(q.orm.select().from(q.t.credential).where(eq(q.t.credential.kind, "slack"))),
    );
  const tick = (ms: number) => (now += ms);
  return { db, home, workspace, member, call, start, finish, status, credentials, tick, revoked };
}

test("an active admin installs Slack and returns to the originating Slack channel", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  const state = await f.start("alice", "install", { teamId: "T111111", channelId: "C111111" });
  const location = await f.finish("alice", state, { team: "T111111" });
  expect(location).toBe("https://slack.com/app_redirect?team=T111111&channel=C111111");
  const view = await f.status("alice");
  expect(view.connection).toMatchObject({
    status: "active",
    teamId: "T111111",
    teamName: "Team T111111",
    appId: "A1",
    botUserId: "BT111111",
    source: "oauth",
  });
  expect(view.capabilities.threads.ready).toBe(true);
  expect(view.capabilities.directMessages.ready).toBe(true);
  expect(view.capabilities.code).toMatchObject({ ready: false });
  expect(view.capabilities.code.message).toContain("Slack Code is not available");
  expect(view.manifest.oauth_config.redirect_urls).toEqual([`${ORIGIN}/oauth/slack/callback`]);
  expect(view.manifest.settings.event_subscriptions.bot_events).toContain("message.im");
  expect(JSON.stringify(view)).not.toContain("xoxb-");
  expect(JSON.stringify(await f.credentials())).not.toContain("xoxb-");
  expect((await f.credentials()).map((row) => row.workspace)).toEqual(["ws1:T111111"]);
});

test("members, demoted admins, other sessions and expired or replayed state cannot install", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin", bob: "member", carol: "admin" });
  expect(
    (await f.call("bob", "/api/workspaces/slack/connect", "POST", { intent: "install" })).status,
  ).toBe(403);
  expect((await f.call(null, "/api/workspaces/slack")).status).toBe(401);

  const demoted = await f.start("alice");
  await f.member("ws1", "alice", "member");
  expect(await f.finish("alice", demoted, { team: "T111111" })).toContain("slack=forbidden");
  await f.member("ws1", "alice", "admin");

  const stolen = await f.start("alice");
  expect(await f.finish("carol", stolen, { team: "T111111" })).toContain("slack=forbidden");

  const expired = await f.start("alice");
  f.tick(11 * 60_000);
  expect(await f.finish("alice", expired, { team: "T111111" })).toContain("slack=expired");

  const replayed = await f.start("alice");
  expect(await f.finish("alice", replayed, { team: "T111111" })).toContain("slack=connected");
  expect(await f.finish("alice", replayed, { team: "T222222" })).toContain("slack=expired");
  expect((await f.status("alice")).connection.teamId).toBe("T111111");
});

test("a denial or a different team keeps the valid connection, and teams never cross workspaces", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  await f.workspace("ws2", { dave: "admin" });
  const [first, second] = [await f.start("alice"), await f.start("dave")];
  await Promise.all([
    f.finish("alice", first, { team: "T111111" }),
    f.finish("dave", second, { team: "T222222" }),
  ]);
  expect(await f.finish("alice", await f.start("alice", "reconnect"), "deny")).toContain(
    "slack=denied",
  );
  expect(
    await f.finish("alice", await f.start("alice", "reconnect"), { team: "T333333" }),
  ).toContain("slack=different_team");
  expect(await f.finish("dave", await f.start("dave", "replace"), { team: "T111111" })).toContain(
    "slack=team_taken",
  );
  expect(
    await f.finish("alice", await f.start("alice", "reconnect"), { team: "T111111", app: "A9" }),
  ).toContain("slack=different_team");
  expect((await f.status("alice")).connection).toMatchObject({
    status: "active",
    teamId: "T111111",
  });
  expect((await f.status("dave")).connection).toMatchObject({
    status: "active",
    teamId: "T222222",
  });
  const stored = (await f.credentials()).map((row) => row.workspace).sort();
  expect(stored).toEqual(["ws1:T111111", "ws2:T222222"]);

  expect(await f.finish("alice", await f.start("alice", "replace"), { team: "T333333" })).toContain(
    "slack=connected",
  );
  expect((await f.credentials()).map((row) => row.workspace).sort()).toEqual([
    "ws1:T333333",
    "ws2:T222222",
  ]);
});

test("concurrent reconnects of one workspace commit only one", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  const [a, b] = [await f.start("alice"), await f.start("alice")];
  const results = await Promise.all([
    f.finish("alice", a, { team: "T111111" }),
    f.finish("alice", b, { team: "T222222" }),
  ]);
  expect(results.filter((location) => location.includes("slack=connected"))).toHaveLength(1);
  expect(await f.credentials()).toHaveLength(1);
});

test("revocation and disconnect end only that installation and keep no token", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  await f.workspace("ws2", { dave: "admin" });
  await f.finish("alice", await f.start("alice"), { team: "T111111" });
  await f.finish("dave", await f.start("dave"), { team: "T222222" });
  expect(await revokeSlackTeam(f.db, { teamId: "T111111", appId: "A9" })).toBe(false);
  expect(await revokeSlackTeam(f.db, { teamId: "T111111", appId: "A1" })).toBe(true);
  expect((await f.status("alice")).connection.status).toBe("revoked");
  expect((await f.status("alice")).capabilities).toBeNull();
  expect((await f.status("dave")).connection.status).toBe("active");
  expect((await f.credentials()).map((row) => row.workspace)).toEqual(["ws2:T222222"]);

  const response = await f.call("dave", "/api/workspaces/slack", "DELETE");
  expect(await response.json()).toEqual({ ok: true });
  expect(f.revoked).toHaveLength(1);
  expect((await f.status("dave")).connection.status).toBe("disconnected");
  expect(await f.credentials()).toEqual([]);
});

test("missing scopes name the reconnect instead of claiming a ready capability", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin" });
  const scope = SLACK_INSTALL_SCOPES.filter(
    (name) => name !== "assistant:write" && name !== "im:history",
  ).join(",");
  await f.finish("alice", await f.start("alice"), { team: "T111111", scope });
  const { capabilities } = await f.status("alice");
  expect(capabilities.threads.ready).toBe(true);
  expect(capabilities.directMessages).toMatchObject({
    ready: false,
    message: "Reconnect Slack to grant im:history.",
  });
  expect(capabilities.agent).toMatchObject({
    ready: false,
    message: "Reconnect Slack to grant assistant:write.",
  });
  expect(capabilities.missing.sort()).toEqual(["assistant:write", "im:history"]);
});

test("an admin adopts the paws login slack connection without new scopes", async () => {
  const f = await fixture();
  await f.workspace("ws1", { alice: "admin", bob: "member" });
  const cli = {
    accessToken: "xoxb-T111111-cli",
    refreshToken: null,
    expiresAtMs: null,
    scope: "chat:write,im:write,users:read,users:read.email,channels:read",
    teamId: "T111111",
    botUserId: "BT111111",
  };
  await writeCredential(f.db, join(f.home, "secrets"), "slack", JSON.stringify(cli));
  expect((await f.status("alice")).cli).toEqual({ teamId: "T111111", botUserId: "BT111111" });
  expect((await f.call("bob", "/api/workspaces/slack/adopt", "POST")).status).toBe(403);
  expect(await (await f.call("alice", "/api/workspaces/slack/adopt", "POST")).json()).toEqual({
    ok: true,
    teamId: "T111111",
  });
  const view = await f.status("alice");
  expect(view.connection).toMatchObject({ source: "cli", teamId: "T111111" });
  expect(view.capabilities.granted).toEqual(cli.scope.split(",").sort());
  expect(view.capabilities.threads.ready).toBe(false);
  expect(await readCredential(f.db, join(f.home, "secrets"), "slack")).toBeNull();
  expect((await f.call("alice", "/api/workspaces/slack/adopt", "POST")).status).toBe(404);
});
