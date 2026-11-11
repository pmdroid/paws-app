import { expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  migrate,
  openDatabase,
  putWorkspaceUser,
  recordPushOutage,
  savePolicyRunnerWarning,
  sessionRepositoriesAllowed,
  syncWorkspaceMember,
  workspaceSessionIds,
  sqliteDb,
} from "../src/db";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";

const REPOSITORIES = ["fixture/team-a", "fixture/private-team-b", "Fixture/Catalog"];

async function seed(): Promise<Database> {
  const db = openDatabase(":memory:");
  migrate(db);
  for (const [id, org] of [
    ["workspace", "org"],
    ["foreign", "org-foreign"],
  ])
    db.run(
      "INSERT INTO workspace(id,linear_organization_id,name,created_at) VALUES(?,?,'Workspace',0)",
      [id!, org!],
    );
  for (const [workspace, repository, team] of [
    ["workspace", "fixture/team-a", "team-a"],
    ["workspace", "fixture/private-team-b", "team-b"],
    ["foreign", "fixture/private-team-b", "team-a"],
  ])
    db.run("INSERT INTO workspace_repository(workspace_id,repository,team_id) VALUES(?,?,?)", [
      workspace!,
      repository!,
      team!,
    ]);
  db.run(
    `INSERT INTO repository_catalog(repository, owner, repo, remote_url, default_branch, refreshed_at)
     VALUES ('fixture/catalog', 'Fixture', 'Catalog', 'https://github.com/Fixture/Catalog.git', 'main', 0)`,
  );
  for (const [session, org, team] of [
    ["session-a", "org", "team-a"],
    ["session-b", "org", "team-b"],
    ["session-c", "org", "team-c"],
    ["session-foreign", "org-foreign", "team-a"],
  ])
    db.run(
      `INSERT INTO linear_session (session_id, organization_id, oauth_client_id, app_user_id, team_id,
        installation_observed_at, created_at) VALUES (?, ?, 'fixture', 'app', ?, 1, 0)`,
      [session!, org!, team!],
    );
  for (const repository of REPOSITORIES) {
    await recordPushOutage(sqliteDb(db), {
      repository,
      error: `Synthetic diagnostic for ${repository}`,
      jobId: null,
      installationUrl: `https://github.com/settings/installations/${repository.length}`,
      now: 0,
      delayMs: () => 60_000,
    });
    await savePolicyRunnerWarning(sqliteDb(db), {
      repository,
      policyDigest: `sha256:policy-${repository}`,
      runnerVersion: "0.1.0",
      keys: [],
      checkedAt: 0,
    });
  }
  return db;
}

test("diagnostics follow the team repository policy of the authorized sessions", async () => {
  const db = await seed();
  const allowed = async (sessions: string[]) => [
    ...(await sessionRepositoriesAllowed(sqliteDb(db), sessions, REPOSITORIES)),
  ];
  expect(await allowed([])).toEqual([]);
  expect(await allowed(["session-a"])).toEqual(["fixture/team-a"]);
  expect(await allowed(["session-c"])).toEqual(["Fixture/Catalog"]);
  expect(await allowed(["session-missing"])).toEqual([]);
  expect(await allowed(["session-a", "session-b"])).toEqual([
    "fixture/team-a",
    "fixture/private-team-b",
  ]);
  db.close();
});

test("a member's overview, merge queue and issue list hold only their teams' diagnostics", async () => {
  const db = await seed();
  for (const [user, role, teams] of [
    ["member", "member", ["team-a"]],
    ["admin", "admin", []],
  ] as const) {
    putWorkspaceUser(db, { id: user, linearUserId: user, name: user, email: `${user}@x.test` });
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: user,
      role,
      active: true,
      teamIds: teams,
      now: Date.now(),
    });
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
        admin: userId === "admin",
        teamIds: userId === "admin" ? [] : ["team-a"],
      }),
    },
  });
  const server = startServer({ port, hostname: "127.0.0.1", db, workspaceAccess: access });
  const cookie = (userId: string) => ({
    headers: {
      cookie: `${WORKSPACE_COOKIE}=${issueWorkspaceSession(db, { workspaceId: "workspace", userId, now: Date.now() }).token}`,
    },
  });
  const member = cookie("member");
  const admin = cookie("admin");
  const read = async (path: string, init: RequestInit) => {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, init);
    expect(response.status).toBe(200);
    return (await response.json()) as {
      pushOutages?: Array<{ repository: string }>;
      policyRunnerWarnings?: Array<{ repository: string }>;
    };
  };
  const repositories = (body: Awaited<ReturnType<typeof read>>) => [
    body.pushOutages?.map((row) => row.repository).sort(),
    body.policyRunnerWarnings?.map((row) => row.repository).sort(),
  ];
  try {
    for (let round = 0; round < 2; round += 1) {
      const all = ["Fixture/Catalog", "fixture/private-team-b", "fixture/team-a"];
      expect(repositories(await read("/api/overview", admin))).toEqual([all, all]);
      expect(repositories(await read("/api/merge-queue", admin))).toEqual([all, all]);
      for (const path of ["/api/overview", "/api/merge-queue", "/api/issues"]) {
        const body = await read(path, member);
        if (path !== "/api/issues")
          expect(repositories(body)).toEqual([["fixture/team-a"], ["fixture/team-a"]]);
        const text = JSON.stringify(body);
        for (const hidden of ["private-team-b", "Catalog", "installations/22", "installations/15"])
          expect(text).not.toContain(hidden);
      }
    }
    expect(workspaceSessionIds(db, "workspace", "admin", "fixture")).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ]);
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: "member",
      role: "member",
      active: true,
      teamIds: [],
      now: Date.now() + 1,
    });
    expect(repositories(await read("/api/overview", member))).toEqual([[], []]);
  } finally {
    await server.stop(true);
    db.close();
  }
});
