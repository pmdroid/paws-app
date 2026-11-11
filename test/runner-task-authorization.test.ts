import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindWorkItemRepository,
  changeLinearTeamAccess,
  consumeWorkspaceBootstrap,
  insertQueuedItem,
  insertRun,
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordLinearInstallation,
  replaceWorkspaceRepositories,
  syncWorkspaceMember,
  sqliteDb,
} from "../src/db";
import { createLinearMembershipReads } from "../src/linear";
import { createRunnerControl, createRunnerHttp } from "../src/runner-control";
import { initializeRunnerAuthority } from "../src/runner-identity";
import { startServer } from "../src/server";
import {
  createWorkspaceAccess,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceId,
  workspaceTokenHash,
  WORKSPACE_COOKIE,
  type WorkspaceAccess,
} from "../src/workspace";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

type Listed = {
  runners: {
    id: string;
    name: string;
    slots: { used: number; total: number };
    running: unknown[];
  }[];
};

test("GET /api/runners lists only tasks in the caller's authorized sessions", async () => {
  const root = mkdtempSync(join(tmpdir(), "paws-runner-task-authorization-"));
  roots.push(root);
  const db = openDatabase(join(root, "paws.sqlite"));
  migrate(db);
  const now = Date.now();
  const teams: Record<string, string[]> = {
    owner: ["team-a"],
    member: ["team-a"],
    administrator: ["team-a", "team-b"],
    nobody: [],
  };
  const users = {} as Record<keyof typeof teams, string>;
  for (const name of Object.keys(teams))
    users[name] = await putWorkspaceUser(sqliteDb(db), {
      id: workspaceId(),
      linearUserId: name,
      name,
      email: `${name}@example.invalid`,
    });
  const workspace = { id: workspaceId(), organizationId: "org", name: "Workspace" };
  await consumeWorkspaceBootstrap(sqliteDb(db), {
    ...workspace,
    userId: users["owner"]!,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(sqliteDb(db), "org", now)),
    now,
  });
  for (const name of ["member", "administrator", "nobody"])
    await syncWorkspaceMember(sqliteDb(db), {
      workspaceId: workspace.id,
      userId: users[name]!,
      role: name === "administrator" ? "admin" : "member",
      active: true,
      teamIds: teams[name]!,
      now,
    });
  const runnerId = workspaceId();
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at) VALUES(?,?,?,?,'active',?)",
    [runnerId, workspace.id, users["owner"]!, "Shared host", now],
  );
  const runIds: Record<string, string> = {};
  for (const [id, teamId, repo, title] of [
    ["AUDIT-1", "team-a", "team-a", "Audit the login page"],
    ["PRIVATE-42", "team-b", "private-team-b", "Confidential acquisition plan"],
    ["ORPHAN-7", null, null, "Orphaned task"],
  ] as const) {
    insertQueuedItem(db, { id, title, ...(teamId ? { sessionKey: `session-${id}` } : {}) });
    if (teamId && repo) {
      await recordLinearInstallation(sqliteDb(db), {
        sessionId: `session-${id}`,
        organizationId: "org",
        teamId,
        appUserId: "app",
        oauthClientId: "client",
        observedAtMs: now,
      });
      await bindWorkItemRepository(sqliteDb(db), id, {
        owner: "fixture",
        repo,
        remoteUrl: `https://example.invalid/fixture/${repo}`,
      });
    }
    const run = await insertRun(sqliteDb(db), { itemId: id, now, status: "active" });
    runIds[id] = run.id;
    db.run(
      `INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until)
      VALUES(?,?,?,1,0,?,?)`,
      [run.id, runnerId, workspace.id, `cmd-${id}`, now + 600_000],
    );
  }
  const mapping = async (teamA: boolean) =>
    await replaceWorkspaceRepositories(sqliteDb(db), {
      workspaceId: workspace.id,
      actorId: users["owner"]!,
      repositories: [
        ...(teamA ? [{ repository: "fixture/team-a", teamId: "team-a" }] : []),
        { repository: "fixture/private-team-b", teamId: "team-b" },
      ],
      now,
    });
  await mapping(true);
  const control = createRunnerControl({
    store: sqliteDb(db),
    authority: await initializeRunnerAuthority(join(root, "issuer")),
    certificateRoot: join(root, "issuer"),
    disconnect() {},
    serverVersion: "2.3.4",
  });
  const runnerHttp = createRunnerHttp(control);
  const ready = Promise.withResolvers<WorkspaceAccess>();
  const server = startServer({
    hostname: "127.0.0.1",
    port: 0,
    db,
    webhooks: false,
    statusEnv: {},
    workspaceAccess: ready.promise,
    runnerControl: (request, principal, sessionIds) =>
      runnerHttp.browser(request, principal, sessionIds),
  });
  const origin = `http://127.0.0.1:${server.port}`;
  ready.resolve(
    createWorkspaceAccess({
      store: sqliteDb(db),
      publicUrl: origin,
      clientId: "client",
      installedOrganization: { id: "org", name: "Workspace" },
      verifyTeam: async (id) => id === "team-a" || id === "team-b",
      memberships: createLinearMembershipReads({
        async query(_query, variables) {
          const id = String(variables?.["id"]);
          return {
            viewer: { app: true, organization: { id: "org" } },
            user: {
              id,
              active: true,
              guest: false,
              admin: false,
              organization: { id: "org" },
              teams: {
                nodes: (teams[id] ?? []).map((team) => ({ id: team })),
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          };
        },
      }),
    }),
  );
  const cookie = async (name: string) => ({
    cookie: `${WORKSPACE_COOKIE}=${(await issueWorkspaceSession(sqliteDb(db), { workspaceId: workspace.id, userId: users[name]!, now })).token}`,
  });
  const sessions: Record<string, { cookie: string }> = {};
  for (const name of ["member", "administrator", "nobody"]) sessions[name] = await cookie(name);
  const list = async (name: string) => {
    const response = await fetch(`${origin}/api/runners`, { headers: sessions[name] });
    const text = await response.text();
    return { status: response.status, text, body: JSON.parse(text) as Listed };
  };
  const identifiers = (listed: Listed) =>
    listed.runners
      .flatMap((runner) =>
        runner.running.map((task) => (task as { identifier: string }).identifier),
      )
      .sort();
  try {
    const member = await list("member");
    expect(member.status).toBe(200);
    expect(identifiers(member.body)).toEqual(["AUDIT-1"]);
    for (const hidden of ["PRIVATE-42", "Confidential acquisition plan", runIds["PRIVATE-42"]!])
      expect(member.text).not.toContain(hidden);
    expect(member.text).not.toContain(runIds["ORPHAN-7"]!);
    expect(
      (await fetch(`${origin}/api/issues/PRIVATE-42`, { headers: sessions["member"] })).status,
    ).toBe(404);
    expect(
      (await fetch(`${origin}/api/issues/PRIVATE-42`, { headers: sessions["administrator"] }))
        .status,
    ).toBe(200);

    const administrator = await list("administrator");
    expect(identifiers(administrator.body)).toEqual(["AUDIT-1", "PRIVATE-42"]);
    expect(administrator.text).not.toContain(runIds["ORPHAN-7"]!);
    const nobody = await list("nobody");
    expect(identifiers(nobody.body)).toEqual([]);
    for (const listed of [member, administrator, nobody])
      expect(listed.body.runners.map(({ id, name, slots }) => ({ id, name, slots }))).toEqual([
        { id: runnerId, name: "Shared host", slots: { used: 3, total: 1 } },
      ]);

    await mapping(false);
    expect(identifiers((await list("member")).body)).toEqual([]);
    expect(identifiers((await list("administrator")).body)).toEqual(["PRIVATE-42"]);
    await changeLinearTeamAccess(sqliteDb(db), {
      eventKey: "fixture-team-b-removal",
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      createdAtMs: now + 1,
      canAccessAllPublicTeams: true,
      addedTeamIds: [],
      removedTeamIds: ["team-b"],
    });
    expect(identifiers((await list("administrator")).body)).toEqual([]);

    expect((await fetch(`${origin}/api/runners`)).status).toBe(401);
    await syncWorkspaceMember(sqliteDb(db), {
      workspaceId: workspace.id,
      userId: users["member"]!,
      role: "member",
      active: false,
      teamIds: [],
      now: now + 1,
    });
    const revoked = await fetch(`${origin}/api/runners`, { headers: sessions["member"] });
    expect(revoked.status).toBe(401);
    expect(await revoked.text()).not.toContain("AUDIT-1");
  } finally {
    await server.stop(true);
    db.close();
  }
});
