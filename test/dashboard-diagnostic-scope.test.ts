import { expect, test } from "bun:test";
import {
  putWorkspaceUser,
  recordPushOutage,
  savePolicyRunnerWarning,
  sessionRepositoriesAllowed,
  syncWorkspaceMember,
  workspaceSessionIds,
} from "../src/db";
import { startServer } from "../src/server";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { seed as insert } from "./dialects";
import { tempStore } from "./pglite";

const REPOSITORIES = ["fixture/team-a", "fixture/private-team-b", "Fixture/Catalog"];

async function seed() {
  const { db, close } = await tempStore();
  const workspaces = [
    ["workspace", "org"],
    ["foreign", "org-foreign"],
  ];
  const repositories = [
    ["workspace", "fixture/team-a", "team-a"],
    ["workspace", "fixture/private-team-b", "team-b"],
    ["foreign", "fixture/private-team-b", "team-a"],
  ];
  const sessions = [
    ["session-a", "org", "team-a"],
    ["session-b", "org", "team-b"],
    ["session-c", "org", "team-c"],
    ["session-foreign", "org-foreign", "team-a"],
  ];
  await insert(
    db,
    (q) =>
      q.orm.insert(q.t.workspace).values(
        workspaces.map(([id, org]) => ({
          id: id!,
          linearOrganizationId: org!,
          name: "Workspace",
          createdAt: 0,
        })),
      ),
    (q) =>
      q.orm.insert(q.t.workspaceRepository).values(
        repositories.map(([workspaceId, repository, teamId]) => ({
          workspaceId: workspaceId!,
          repository: repository!,
          teamId: teamId!,
        })),
      ),
    (q) =>
      q.orm.insert(q.t.repositoryCatalog).values({
        repository: "fixture/catalog",
        owner: "Fixture",
        repo: "Catalog",
        remoteUrl: "https://github.com/Fixture/Catalog.git",
        defaultBranch: "main",
        refreshedAt: 0,
      }),
    (q) =>
      q.orm.insert(q.t.linearSession).values(
        sessions.map(([sessionId, organizationId, teamId]) => ({
          sessionId: sessionId!,
          organizationId: organizationId!,
          oauthClientId: "fixture",
          appUserId: "app",
          teamId: teamId!,
          installationObservedAt: 1,
          createdAt: 0,
        })),
      ),
  );
  for (const repository of REPOSITORIES) {
    await recordPushOutage(db, {
      repository,
      error: `Synthetic diagnostic for ${repository}`,
      jobId: null,
      installationUrl: `https://github.com/settings/installations/${repository.length}`,
      now: 0,
      delayMs: () => 60_000,
    });
    await savePolicyRunnerWarning(db, {
      repository,
      policyDigest: `sha256:policy-${repository}`,
      runnerVersion: "0.1.0",
      keys: [],
      checkedAt: 0,
    });
  }
  return { db, close };
}

test("diagnostics follow the team repository policy of the authorized sessions", async () => {
  const { db, close } = await seed();
  const allowed = async (sessions: string[]) => [
    ...(await sessionRepositoriesAllowed(db, sessions, REPOSITORIES)),
  ];
  expect(await allowed([])).toEqual([]);
  expect(await allowed(["session-a"])).toEqual(["fixture/team-a"]);
  expect(await allowed(["session-c"])).toEqual(["Fixture/Catalog"]);
  expect(await allowed(["session-missing"])).toEqual([]);
  expect(await allowed(["session-a", "session-b"])).toEqual([
    "fixture/team-a",
    "fixture/private-team-b",
  ]);
  await close();
});

test("a member's overview, merge queue and issue list hold only their teams' diagnostics", async () => {
  const { db, close } = await seed();
  for (const [user, role, teams] of [
    ["member", "member", ["team-a"]],
    ["admin", "admin", []],
  ] as const) {
    await putWorkspaceUser(db, {
      id: user,
      linearUserId: user,
      name: user,
      email: `${user}@x.test`,
    });
    await syncWorkspaceMember(db, {
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
        admin: userId === "admin",
        teamIds: userId === "admin" ? [] : ["team-a"],
      }),
    },
  });
  const server = startServer({ port, hostname: "127.0.0.1", db, workspaceAccess: access });
  const cookie = async (userId: string) => ({
    headers: {
      cookie: `${WORKSPACE_COOKIE}=${(await issueWorkspaceSession(db, { workspaceId: "workspace", userId, now: Date.now() })).token}`,
    },
  });
  const member = await cookie("member");
  const admin = await cookie("admin");
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
    expect(await workspaceSessionIds(db, "workspace", "admin", "fixture")).toEqual([
      "session-a",
      "session-b",
      "session-c",
    ]);
    await syncWorkspaceMember(db, {
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
    await close();
  }
});
