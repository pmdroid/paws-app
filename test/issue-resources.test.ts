import { expect, test } from "bun:test";
import {
  applyWorkItemEvent,
  beginImplementRun,
  insertQueuedItem,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

test("issue and question resources need a Paws session, show only the member's sessions and follow membership changes", async () => {
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
  for (const [session, team] of [
    ["session-mine", "team"],
    ["session-other", "other-team"],
  ])
    await seed(db, (q) =>
      q.orm.insert(q.t.linearSession).values({
        sessionId: session!,
        organizationId: "org",
        oauthClientId: "fixture",
        appUserId: "app",
        teamId: team!,
        installationObservedAt: 1,
        createdAt: 0,
      }),
    );
  for (const [item, session] of [
    ["PAS-1", "session-mine"],
    ["PAS-2", "session-other"],
  ] as const) {
    await insertQueuedItem(db, { id: item, sessionKey: session });
    await beginImplementRun(db, item, Date.now());
    await applyWorkItemEvent(db, item, "blocking_question");
    await seed(db, (q) =>
      q.orm.insert(q.t.question).values({
        id: `q-${item}`,
        itemId: item,
        sessionId: session,
        body: "Which way?",
        status: "open",
        createdAt: 1,
      }),
    );
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
  const url = (path: string, resource = "issues") =>
    `http://127.0.0.1:${server.port}/api/${resource}${path}`;
  const cookie = `${WORKSPACE_COOKIE}=${session.token}`;
  const signedIn = (headers: Record<string, string> = {}) => ({ headers: { cookie, ...headers } });
  const listed = async () =>
    (
      (await (await fetch(url(""), signedIn())).json()) as { issues: Array<{ id: string }> }
    ).issues.map((issue) => issue.id);
  const asked = async () =>
    (
      (await (await fetch(url("", "questions"), signedIn())).json()) as {
        questions: Array<{ id: string; issue: { id: string } }>;
      }
    ).questions.map((question) => `${question.id}@${question.issue.id}`);
  try {
    for (const path of ["", "/PAS-1", "/PAS-1/attempts/1/checks/test/log"])
      expect((await fetch(url(path))).status).toBe(401);
    for (const path of ["", "/q-PAS-1"])
      expect((await fetch(url(path, "questions"))).status).toBe(401);

    expect(await listed()).toEqual(["PAS-1"]);
    const mine = await fetch(url("/PAS-1"), signedIn());
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    const etag = mine.headers.get("etag")!;
    expect(((await mine.json()) as { issue: { id: string } }).issue.id).toBe("PAS-1");
    expect((await fetch(url("/PAS-1"), signedIn({ "If-None-Match": etag }))).status).toBe(304);

    const other = await fetch(url("/PAS-2"), signedIn());
    const unknown = await fetch(url("/PAS-404"), signedIn());
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await other.text()).toBe(await unknown.text());
    expect((await fetch(url("/PAS-2/attempts/1/checks/test/log"), signedIn())).status).toBe(404);
    expect(await asked()).toEqual(["q-PAS-1@PAS-1"]);
    const question = await fetch(url("/q-PAS-1", "questions"), signedIn());
    expect(question.status).toBe(200);
    expect(question.headers.get("cache-control")).toBe("no-store");
    const questionTag = question.headers.get("etag")!;
    const hidden = await fetch(url("/q-PAS-2", "questions"), signedIn());
    expect(hidden.status).toBe(404);
    expect(await hidden.text()).toBe(
      await (await fetch(url("/q-404", "questions"), signedIn())).text(),
    );

    teamIds = ["other-team"];
    await member();
    const revoked = await fetch(url("/PAS-1"), signedIn({ "If-None-Match": etag }));
    expect(revoked.status).toBe(404);
    expect(await listed()).toEqual(["PAS-2"]);
    const stale = await fetch(
      url("/q-PAS-1", "questions"),
      signedIn({ "If-None-Match": questionTag }),
    );
    expect(stale.status).toBe(404);
    expect(await asked()).toEqual(["q-PAS-2@PAS-2"]);
    expect((await fetch(url("/PAS-2"), signedIn())).status).toBe(200);
  } finally {
    await server.stop(true);
    await close();
  }
});
