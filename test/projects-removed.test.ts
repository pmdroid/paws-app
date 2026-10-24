import { expect, test } from "bun:test";
import { migrate, openDatabase, putWorkspaceUser, syncWorkspaceMember } from "../src/db";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";

test("the Projects page and /api/projects are gone for a signed-in member", async () => {
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
  const headers = { cookie: `${WORKSPACE_COOKIE}=${session.token}` };
  const get = (path: string) =>
    fetch(`http://127.0.0.1:${server.port}${path}`, { headers, redirect: "manual" });
  try {
    expect((await get("/status/issues")).status).toBe(200);
    expect((await get("/status/projects")).status).toBe(404);
    expect((await get("/status/projects/approval")).status).toBe(404);
    expect((await get("/api/projects")).status).toBe(404);
  } finally {
    await server.stop(true);
    db.close();
  }
});
