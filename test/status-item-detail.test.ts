import { expect, test } from "bun:test";
import {
  insertQueuedItem,
  putWorkspaceUser,
  syncWorkspaceMember,
  workspaceSessionIds,
} from "../src/db";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

test("the issue endpoint needs a Paws session and shows only the member's sessions", async () => {
  const { db, close } = await tempStore();
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
  );
  await putWorkspaceUser(db, {
    id: "member",
    linearUserId: "member",
    name: "member",
    email: "m@x.test",
  });
  await syncWorkspaceMember(db, {
    workspaceId: "workspace",
    userId: "member",
    role: "member",
    active: true,
    teamIds: ["team"],
    now: Date.now(),
  });
  await seed(db, (q) =>
    q.orm.insert(q.t.linearSession).values(
      [
        ["session-mine", "team"],
        ["session-other", "other-team"],
      ].map(([sessionId, teamId]) => ({
        sessionId: sessionId!,
        organizationId: "org",
        oauthClientId: "fixture",
        appUserId: "app",
        teamId: teamId!,
        installationObservedAt: 1,
        createdAt: 0,
      })),
    ),
  );
  expect(await workspaceSessionIds(db, "workspace", "member", "fixture")).toEqual(["session-mine"]);
  await insertQueuedItem(db, { id: "PAS-1", sessionKey: "session-mine" });
  await insertQueuedItem(db, { id: "PAS-2", sessionKey: "session-other" });
  const reservation = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const access = createWorkspaceAccess({
    store: db,
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
  const session = await issueWorkspaceSession(db, {
    workspaceId: "workspace",
    userId: "member",
    now: Date.now(),
  });
  const url = (id: string) => `http://127.0.0.1:${server.port}/api/issues/${id}`;
  const signedIn = { headers: { cookie: `${WORKSPACE_COOKIE}=${session.token}` } };
  try {
    expect((await fetch(url("PAS-1"))).status).toBe(401);
    const mine = await fetch(url("PAS-1"), signedIn);
    expect(mine.status).toBe(200);
    const body = (await mine.json()) as {
      issue: { id: string };
      earlierSessions: Array<{ id: string }>;
    };
    expect(body.issue.id).toBe("PAS-1");
    expect(body.earlierSessions).toEqual([]);
    const other = await fetch(url("PAS-2"), signedIn);
    const unknown = await fetch(url("PAS-404"), signedIn);
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await other.text()).toBe(await unknown.text());
  } finally {
    await server.stop(true);
    await close();
  }
});
