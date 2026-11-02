import { expect, test } from "bun:test";
import {
  applyWorkItemEvent,
  beginImplementRun,
  insertQueuedItem,
  migrate,
  openDatabase,
  putWorkspaceUser,
  syncWorkspaceMember,
} from "../src/db";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";

test("question resources need a Paws session, show only the member's sessions and follow membership changes", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  db.run(
    "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES('workspace','org','Workspace',0)",
  );
  putWorkspaceUser(db, { id: "member", linearUserId: "member", name: "member", email: "m@x.test" });
  let teamIds = ["team"];
  const member = () =>
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: "member",
      role: "member",
      active: true,
      teamIds,
      now: Date.now(),
    });
  member();
  for (const [session, team] of [
    ["session-mine", "team"],
    ["session-other", "other-team"],
  ])
    db.run(
      `INSERT INTO linear_session (session_id, organization_id, oauth_client_id, app_user_id, team_id,
        installation_observed_at, created_at) VALUES (?, 'org', 'fixture', 'app', ?, 1, 0)`,
      [session!, team!],
    );
  for (const [item, session, question] of [
    ["PAS-1", "session-mine", "q-mine"],
    ["PAS-2", "session-other", "q-other"],
  ] as const) {
    insertQueuedItem(db, { id: item, title: `Title ${item}`, sessionKey: session });
    beginImplementRun(db, item, Date.now());
    applyWorkItemEvent(db, item, "blocking_question");
    db.run(
      "INSERT INTO question (id, item_id, session_id, body, options, status, created_at) VALUES (?, ?, ?, 'Which way?', '[]', 'open', 1)",
      [question, item, session],
    );
  }
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
  const session = issueWorkspaceSession(db, {
    workspaceId: "workspace",
    userId: "member",
    now: Date.now(),
  });
  const url = (path: string) => `http://127.0.0.1:${server.port}/api/questions${path}`;
  const cookie = `${WORKSPACE_COOKIE}=${session.token}`;
  const signedIn = (headers: Record<string, string> = {}) => ({ headers: { cookie, ...headers } });
  const listed = async () =>
    (
      (await (await fetch(url(""), signedIn())).json()) as {
        questions: Array<{ id: string; issue: { id: string } }>;
      }
    ).questions.map((question) => `${question.id}@${question.issue.id}`);
  try {
    for (const path of ["", "/q-mine"]) expect((await fetch(url(path))).status).toBe(401);

    expect(await listed()).toEqual(["q-mine@PAS-1"]);
    const mine = await fetch(url("/q-mine"), signedIn());
    expect(mine.status).toBe(200);
    expect(mine.headers.get("cache-control")).toBe("no-store");
    const etag = mine.headers.get("etag")!;
    expect(((await mine.json()) as { question: { issue: { id: string } } }).question.issue.id).toBe(
      "PAS-1",
    );
    expect((await fetch(url("/q-mine"), signedIn({ "If-None-Match": etag }))).status).toBe(304);

    const other = await fetch(url("/q-other"), signedIn());
    const unknown = await fetch(url("/q-404"), signedIn());
    expect(other.status).toBe(404);
    expect(unknown.status).toBe(404);
    expect(await other.text()).toBe(await unknown.text());

    teamIds = ["other-team"];
    member();
    const revoked = await fetch(url("/q-mine"), signedIn({ "If-None-Match": etag }));
    expect(revoked.status).toBe(404);
    expect(await listed()).toEqual(["q-other@PAS-2"]);
    expect((await fetch(url("/q-other"), signedIn())).status).toBe(200);
  } finally {
    await server.stop(true);
    db.close();
  }
});
