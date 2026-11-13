import { expect, test } from "bun:test";
import { putWorkspaceUser, replaceWorkspaceRepositories, syncWorkspaceMember } from "../src/db";
import { createWorkspaceAccess, issueWorkspaceSession, WORKSPACE_COOKIE } from "../src/workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

test("the session reports setup progress from mapped repositories for every role", async () => {
  const { db, close } = await tempStore();
  await seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "workspace", linearOrganizationId: "org", name: "Workspace", createdAt: 0 }),
  );
  for (const [id, role] of [
    ["admin", "admin"],
    ["member", "member"],
  ] as const) {
    await putWorkspaceUser(db, { id, linearUserId: id, name: id, email: `${id}@x.test` });
    await syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: id,
      role,
      active: true,
      teamIds: ["team"],
      now: Date.now(),
    });
  }
  const access = createWorkspaceAccess({
    store: db,
    publicUrl: "http://127.0.0.1:8787",
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
        teamIds: ["team"],
      }),
    },
  });
  const setupOf = async (userId: string) => {
    const session = await issueWorkspaceSession(db, {
      workspaceId: "workspace",
      userId,
      now: Date.now(),
    });
    const response = await access.handle(
      new Request("http://127.0.0.1:8787/api/auth/session", {
        headers: { cookie: `${WORKSPACE_COOKIE}=${session.token}` },
      }),
    );
    expect(response?.status).toBe(200);
    return ((await response!.json()) as { setup: unknown }).setup;
  };
  try {
    expect(await setupOf("admin")).toEqual({ repositories: 0, complete: false });
    expect(await setupOf("member")).toEqual({ repositories: 0, complete: false });
    await replaceWorkspaceRepositories(db, {
      workspaceId: "workspace",
      actorId: "admin",
      repositories: [{ repository: "acme/app", teamId: "team" }],
      now: Date.now(),
    });
    expect(await setupOf("admin")).toEqual({ repositories: 1, complete: true });
    expect(await setupOf("member")).toEqual({ repositories: 1, complete: true });
  } finally {
    await access.stop();
    await close();
  }
});
