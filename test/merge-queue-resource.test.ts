import { expect, test } from "bun:test";
import {
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

test("the merge queue needs a Paws session, shows only the member's sessions and follows membership changes", async () => {
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
  let teamIds = ["team"];
  const member = async () =>
    await syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: "member",
      role: "member",
      active: true,
      teamIds,
      now: Date.now(),
    });
  await member();
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
        teamId,
        installationObservedAt: 1,
        createdAt: 0,
      })),
    ),
  );
  const head = "c".repeat(40);
  for (const [id, sessionKey] of [
    ["PAS-1", "session-mine"],
    ["PAS-2", "session-other"],
  ] as const) {
    await insertQueuedItem(db, { id, sessionKey });
    await beginImplementRun(db, id, Date.now());
    await enterMergeQueue(db, id, {
      phase: "merge_queue",
      baseSha: head,
      wipCommit: head,
    });
  }
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
  const url = `http://127.0.0.1:${server.port}/api/merge-queue`;
  const cookie = `${WORKSPACE_COOKIE}=${session.token}`;
  const signedIn = (headers: Record<string, string> = {}) => ({ headers: { cookie, ...headers } });
  const queued = async (response: Response) =>
    ((await response.json()) as { entries: Array<{ itemId: string }> }).entries.map(
      (entry) => entry.itemId,
    );
  try {
    expect((await fetch(url)).status).toBe(401);

    const mine = await fetch(url, signedIn());
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    const etag = mine.headers.get("etag")!;
    expect(await queued(mine)).toEqual(["PAS-1"]);
    expect((await fetch(url, signedIn({ "If-None-Match": etag }))).status).toBe(304);
    expect((await fetch(url, { headers: { "If-None-Match": etag } })).status).toBe(401);

    teamIds = ["other-team"];
    await member();
    const revoked = await fetch(url, signedIn({ "If-None-Match": etag }));
    expect(revoked.status).toBe(200);
    expect(await queued(revoked)).toEqual(["PAS-2"]);
  } finally {
    await server.stop(true);
    await close();
  }
});
