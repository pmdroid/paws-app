import { afterEach, expect, test } from "bun:test";
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
import { createSlackConnect, SLACK_INSTALL_SCOPES } from "../src/slack";
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
  connection: Record<string, string> | null;
  capabilities: Record<string, { ready: boolean; message?: string }> & { missing: string[] };
};
type Grant = { team: string; scope?: string; app?: string; rotate?: boolean };

async function fixture() {
  const home = tempHome();
  const { db, close } = await tempStore();
  cleanup.push(close, () => rmSync(home, { recursive: true, force: true }));
  let now = Date.now();
  const grants: Grant[] = [];
  const revoked: string[] = [];
  const handle = createSlackConnect({
    store: db,
    home,
    env,
    origin: ORIGIN,
    now: () => now,
    fetch: async (url, init) => {
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url.endsWith("/auth.revoke")) revoked.push(auth);
      const grant = grants[Number(new URLSearchParams(String(init?.body)).get("code"))]!;
      return Response.json({
        ok: true,
        token_type: "bot",
        access_token: `xoxb-${grant.team}-${grants.length}`,
        scope: grant.scope ?? SLACK_INSTALL_SCOPES.join(","),
        app_id: grant.app ?? "A1",
        ...(grant.rotate ? { refresh_token: "xoxe-refresh", expires_in: 43200 } : {}),
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
  async function start(user: string) {
    const response = await call(user, "/api/workspaces/slack/connect", "POST", {});
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
  return {
    db,
    workspace,
    setRole,
    call,
    start,
    finish,
    revoked,
    again: async (user: string, grant: Grant | "deny") => finish(user, await start(user), grant),
    status: async (user: string) =>
      (await (await call(user, "/api/workspaces/slack")).json()) as View,
    credentials: async () =>
      (
        await db.run((q) =>
          q.all(q.orm.select().from(q.t.credential).where(eq(q.t.credential.kind, "slack"))),
        )
      ).filter((row) => !row.workspace.startsWith("team:")),
    tick: (ms: number) => (now += ms),
  };
}

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
  expect(await f.again("dave", { team: "T222222", rotate: true })).toContain("slack=rotating");
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
