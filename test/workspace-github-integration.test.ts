import { expect, test } from "bun:test";
import {
  consumeWorkspaceBootstrap,
  listJobs,
  migrate,
  openDatabase,
  putWorkspaceUser,
  replaceWorkspaceRepositories,
  syncWorkspaceMember,
  workspaceMember,
} from "../src/db";
import {
  handleWorkspaceGitHubIntegration,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";

function fixture() {
  const db = openDatabase(":memory:");
  migrate(db);
  const now = 1000000;
  putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "linear-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Workspace",
    userId: "owner",
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const role of ["admin", "member", "observer"] as const) {
    putWorkspaceUser(db, {
      id: role,
      linearUserId: `linear-${role}`,
      name: role,
      email: `${role}@example.invalid`,
    });
    syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: role,
      role,
      active: true,
      teamIds: ["team"],
      now,
    });
  }
  replaceWorkspaceRepositories(db, {
    workspaceId: "workspace",
    actorId: "owner",
    repositories: [{ repository: "acme/widgets", teamId: "team" }],
    now,
  });
  return {
    db,
    now,
    async request(
      role: string,
      options: {
        stale?: boolean;
        csrf?: boolean;
        origin?: string;
        check?: () => Promise<boolean>;
      } = {},
    ) {
      const issued = issueWorkspaceSession(db, {
        workspaceId: "workspace",
        userId: role,
        now: options.stale ? now - 16 * 60000 : now,
      });
      const principal = {
        workspaceId: "workspace",
        userId: role,
        role,
        authenticatedAt: issued.session.authenticatedAt,
      } as WorkspacePrincipal;
      return (await handleWorkspaceGitHubIntegration(
        new Request("https://paws.example/api/workspaces/github-integration", {
          method: "POST",
          headers: {
            origin: options.origin ?? "https://paws.example",
            ...(options.csrf === false ? {} : { "x-paws-csrf": issued.session.csrfToken }),
          },
        }),
        {
          db,
          principal,
          session: issued.session,
          origin: "https://paws.example",
          now: () => now,
          check: options.check ?? (async () => true),
        },
      ))!;
    },
  };
}

test("signed-in owners and administrators can revalidate the App regardless of sign-in age", async () => {
  const f = fixture();
  try {
    for (const role of ["owner", "admin"]) expect((await f.request(role)).status).toBe(200);
    for (const role of ["member", "observer"]) expect((await f.request(role)).status).toBe(403);
    expect((await f.request("admin", { stale: true })).status).toBe(200);
    expect((await f.request("admin", { csrf: false })).status).toBe(403);
    expect((await f.request("admin", { origin: "https://other.example" })).status).toBe(403);
    expect(listJobs(f.db)).toHaveLength(3);
    expect(
      f.db
        .query("SELECT * FROM workspace_access_audit WHERE action='github.integration.revalidated'")
        .all(),
    ).toHaveLength(3);
    expect(workspaceMember(f.db, "workspace", "admin")?.role).toBe("admin");
  } finally {
    f.db.close();
  }
});

test("Paws admin permission never overrides missing GitHub installation authority", async () => {
  const f = fixture();
  try {
    expect((await f.request("admin", { check: async () => false })).status).toBe(409);
    expect(listJobs(f.db)).toHaveLength(0);
  } finally {
    f.db.close();
  }
});

test("in-flight administrator demotion rejects recovery transaction and is audited", async () => {
  const f = fixture();
  try {
    expect(
      (
        await f.request("admin", {
          check: async () => {
            f.db.run("UPDATE workspace_member SET role='member' WHERE user_id='admin'");
            return true;
          },
        })
      ).status,
    ).toBe(403);
    expect(listJobs(f.db)).toHaveLength(0);
    expect(
      f.db.query("SELECT * FROM workspace_access_audit WHERE action='access.denied'").all(),
    ).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

test("repository scope mutation during revalidation cannot enqueue recovery", async () => {
  const f = fixture();
  try {
    expect(
      (
        await f.request("owner", {
          check: async () => {
            replaceWorkspaceRepositories(f.db, {
              workspaceId: "workspace",
              actorId: "owner",
              repositories: [{ repository: "acme/other", teamId: "team" }],
              now: f.now,
            });
            return true;
          },
        })
      ).status,
    ).toBe(403);
    expect(listJobs(f.db)).toHaveLength(0);
  } finally {
    f.db.close();
  }
});
