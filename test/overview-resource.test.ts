import { expect, test } from "bun:test";
import {
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
  sqliteDb,
} from "../src/db";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";

test("the overview needs a Paws session, shows only the member's sessions and follows membership changes", async () => {
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
  await insertQueuedItem(db, { id: "PAS-1", sessionKey: "session-mine" });
  await insertQueuedItem(db, { id: "PAS-2", sessionKey: "session-other" });
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
  const session = await issueWorkspaceSession(db, {
    workspaceId: "workspace",
    userId: "member",
    now: Date.now(),
  });
  const url = `http://127.0.0.1:${server.port}/api/overview`;
  const cookie = `${WORKSPACE_COOKIE}=${session.token}`;
  const signedIn = (headers: Record<string, string> = {}) => ({ headers: { cookie, ...headers } });
  const shown = async (response: Response) =>
    ((await response.json()) as { issues: Array<{ id: string }> }).issues.map((issue) => issue.id);
  try {
    expect((await fetch(url)).status).toBe(401);

    const mine = await fetch(url, signedIn());
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    expect(mine.headers.get("paws-generated-at")).not.toBeNull();
    const etag = mine.headers.get("etag")!;
    expect(await shown(mine)).toEqual(["PAS-1"]);
    expect((await fetch(url, signedIn({ "If-None-Match": etag }))).status).toBe(304);
    expect((await fetch(url, { headers: { "If-None-Match": etag } })).status).toBe(401);

    teamIds = ["other-team"];
    await member();
    const revoked = await fetch(url, signedIn({ "If-None-Match": etag }));
    expect(revoked.status).toBe(200);
    expect(await shown(revoked)).toEqual(["PAS-2"]);
  } finally {
    await server.stop(true);
    db.close();
  }
});
