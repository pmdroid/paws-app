import { expect, test } from "bun:test";
import {
  insertQueuedItem,
  insertRun,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
  sqliteDb,
} from "../src/db";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";

const DAY = 24 * 60 * 60 * 1000;

test("run, session and verdict links resolve through stored records the signed-in member can see", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','org','Workspace',0)",
  );
  await putWorkspaceUser(sqliteDb(db), {
    id: "member",
    linearUserId: "member",
    name: "member",
    email: "m@x.test",
  });
  let teamIds = ["team"];
  const member = async () =>
    await syncWorkspaceMember(sqliteDb(db), {
      workspaceId: "workspace",
      userId: "member",
      role: "member",
      active: true,
      teamIds,
      now: Date.now(),
    });
  await member();
  for (const [session, team] of [
    ["session-mine", "team"],
    ["session-other", "other-team"],
  ])
    db.run(
      `INSERT INTO linear_session (session_id, organization_id, oauth_client_id, app_user_id, team_id,
        installation_observed_at, created_at) VALUES (?, 'org', 'fixture', 'app', ?, 1, 0)`,
      [session!, team!],
    );
  const old = Date.now() - 30 * DAY;
  insertQueuedItem(db, { id: "PAS-1", sessionKey: "session-mine", now: old });
  insertQueuedItem(db, { id: "PAS-5", sessionKey: "session-mine", now: old + 1 });
  insertQueuedItem(db, { id: "PAS-2", sessionKey: "session-other", now: old });
  const runs = [];
  for (const at of [0, 1])
    runs.push((await insertRun(sqliteDb(db), { itemId: "PAS-1", now: old + at })).id);
  const hidden = (await insertRun(sqliteDb(db), { itemId: "PAS-2", now: old })).id;
  db.run("UPDATE work_item SET state = 'merged'");
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const access = createWorkspaceAccess({
    db,
    publicUrl: `http://127.0.0.1:${port}`,
    clientId: "fixture",
    installedOrganization: { id: "org", name: "Workspace" },
    memberships: {
      installation: async () => ({ id: "org", name: "Workspace" }),
      member: async (organizationId, userId) => ({
        organizationId,
        userId,
        active: true,
        guest: false,
        admin: false,
        teamIds,
      }),
    },
  });
  const server = startServer({ port, hostname: "127.0.0.1", db, workspaceAccess: access });
  const base = `http://127.0.0.1:${server.port}`;
  const alias = (path: string) => `${base}/api/aliases${path}`;
  const resolve = async (path: string, cookie: string) => {
    const response = await fetch(alias(path), { headers: { cookie } });
    return { status: response.status, body: await response.text() };
  };
  try {
    for (const path of [`/runs/${runs[0]}`, "/sessions/session-mine", "/verdicts/PAS-1"])
      expect((await fetch(alias(path))).status).toBe(401);
    const session = await issueWorkspaceSession(db, {
      workspaceId: "workspace",
      userId: "member",
      now: Date.now(),
    });
    const cookie = `${WORKSPACE_COOKIE}=${session.token}`;
    const listed = await fetch(`${base}/api/issues`, { headers: { cookie } });
    expect(((await listed.json()) as { issues: unknown[] }).issues).toEqual([]);

    const resolved = { status: 200, body: JSON.stringify({ issueId: "PAS-1" }) };
    for (const run of runs) expect(await resolve(`/runs/${run}`, cookie)).toEqual(resolved);
    expect(await resolve("/sessions/session-mine", cookie)).toEqual(resolved);
    expect(await resolve("/verdicts/PAS-1", cookie)).toEqual(resolved);
    expect(await resolve(`/verdicts/${runs[1]}`, cookie)).toEqual(resolved);
    const shown = await fetch(alias("/sessions/session-mine"), { headers: { cookie } });
    expect(shown.headers.get("cache-control")).toBe("no-store");

    const unknown = await resolve("/sessions/unknown", cookie);
    expect(unknown.status).toBe(404);
    for (const path of [
      "/sessions/session-other",
      `/runs/${hidden}`,
      "/verdicts/PAS-2",
      "/runs/unknown",
      "/verdicts/PAS-404",
      `/runs/${runs[0]}/transcript`,
      `/issues/PAS-1`,
    ])
      expect(await resolve(path, cookie)).toEqual(unknown);

    teamIds = ["other-team"];
    await member();
    expect(await resolve(`/runs/${runs[0]}`, cookie)).toEqual(unknown);
    expect(await resolve("/sessions/session-other", cookie)).toEqual({
      status: 200,
      body: JSON.stringify({ issueId: "PAS-2" }),
    });

    for (const prefix of ["/status", "/dashboard"])
      for (const path of [`/runs/${runs[0]}`, "/sessions/session-mine", "/verdicts/PAS-1"]) {
        const page = await fetch(`${base}${prefix}${path}?tab=closeout`, { redirect: "manual" });
        if (prefix === "/status") {
          expect(page.status).toBe(307);
          expect(page.headers.get("location")).toBe(`/dashboard${path}?tab=closeout`);
        } else expect(page.status).toBe(200);
      }
    const transcript = await fetch(`${base}/status/runs/${runs[0]}/transcript`, {
      redirect: "manual",
    });
    expect(transcript.headers.get("location")).toBe(`/dashboard/runs/${runs[0]}/transcript`);
  } finally {
    await server.stop(true);
    db.close();
  }
});
