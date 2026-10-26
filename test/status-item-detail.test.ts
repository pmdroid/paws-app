import { expect, test } from "bun:test";
import {
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
  workspaceSessionIds,
} from "../src/db";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";

test("the item detail endpoint needs a Paws session and shows only the member's sessions", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','org','Workspace',0)",
  );
  putWorkspaceUser(db, { id: "member", linearUserId: "member", name: "member", email: "m@x.test" });
  syncWorkspaceMember(db, {
    workspaceId: "workspace",
    userId: "member",
    role: "member",
    active: true,
    teamIds: ["team"],
    now: Date.now(),
  });
  for (const [session, team] of [
    ["session-mine", "team"],
    ["session-other", "other-team"],
  ])
    db.run(
      `INSERT INTO linear_session (session_id, organization_id, oauth_client_id, app_user_id, team_id,
        installation_observed_at, created_at) VALUES (?, 'org', 'fixture', 'app', ?, 1, 0)`,
      [session!, team!],
    );
  expect(workspaceSessionIds(db, "workspace", "member", "fixture")).toEqual(["session-mine"]);
  insertQueuedItem(db, { id: "PAS-1", sessionKey: "session-mine" });
  insertQueuedItem(db, { id: "PAS-2", sessionKey: "session-other" });
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
        teamIds: ["team"],
      }),
    },
  });
  const server = startServer({ port, hostname: "127.0.0.1", db, workspaceAccess: access });
  const session = issueWorkspaceSession(db, {
    workspaceId: "workspace",
    userId: "member",
    now: Date.now(),
  });
  const url = (id: string) => `http://127.0.0.1:${server.port}/api/status/items/${id}`;
  const signedIn = { headers: { cookie: `${WORKSPACE_COOKIE}=${session.token}` } };
  try {
    expect((await fetch(url("PAS-1"))).status).toBe(401);
    const mine = await fetch(url("PAS-1"), signedIn);
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as { id: string; items: Array<{ id: string }> };
    expect(body.id).toBe("PAS-1");
    expect(body.items.map((item) => item.id)).toEqual(["PAS-1"]);
    const other = await fetch(url("PAS-2"), signedIn);
    const unknown = await fetch(url("PAS-404"), signedIn);
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await other.text()).toBe(await unknown.text());
  } finally {
    await server.stop(true);
    db.close();
  }
});
