import { expect, test } from "bun:test";
import {
  consumeWorkspaceBootstrap,
  listJobs,
  putWorkspaceUser,
  replaceWorkspaceRepositories,
  syncWorkspaceMember,
  workspaceMember,
  type Db,
} from "../src/db";
import { eq } from "drizzle-orm";
import {
  handleWorkspaceGitHubIntegration,
  issueWorkspaceBootstrap,
  issueWorkspaceSession,
  workspaceTokenHash,
  type WorkspacePrincipal,
} from "../src/workspace";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

function audits(db: Db, action: string) {
  return db.run((q) =>
    q.all(
      q.orm
        .select()
        .from(q.t.workspaceAccessAudit)
        .where(eq(q.t.workspaceAccessAudit.action, action)),
    ),
  );
}

async function fixture() {
  const { db, close } = await tempStore();
  const now = 1000000;
  await putWorkspaceUser(db, {
    id: "owner",
    linearUserId: "linear-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  await consumeWorkspaceBootstrap(db, {
    id: "workspace",
    organizationId: "org",
    name: "Workspace",
    userId: "owner",
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", now)),
    now,
  });
  for (const role of ["admin", "member"] as const) {
    await putWorkspaceUser(db, {
      id: role,
      linearUserId: `linear-${role}`,
      name: role,
      email: `${role}@example.invalid`,
    });
    await syncWorkspaceMember(db, {
      workspaceId: "workspace",
      userId: role,
      role,
      active: true,
      teamIds: ["team"],
      now,
    });
  }
  await replaceWorkspaceRepositories(db, {
    workspaceId: "workspace",
    actorId: "owner",
    repositories: [{ repository: "acme/widgets", teamId: "team" }],
    now,
  });
  return {
    db,
    close,
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
      const issued = await issueWorkspaceSession(db, {
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
          store: db,
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

test("signed-in admins, including the one who connected the workspace, can revalidate the App regardless of sign-in age", async () => {
  const f = await fixture();
  try {
    for (const role of ["owner", "admin"]) expect((await f.request(role)).status).toBe(200);
    expect((await f.request("member")).status).toBe(403);
    expect((await f.request("admin", { stale: true })).status).toBe(200);
    expect((await f.request("admin", { csrf: false })).status).toBe(403);
    expect((await f.request("admin", { origin: "https://other.example" })).status).toBe(403);
    expect(await listJobs(f.db)).toHaveLength(3);
    expect(await audits(f.db, "github.integration.revalidated")).toHaveLength(3);
    expect((await workspaceMember(f.db, "workspace", "admin"))?.role).toBe("admin");
  } finally {
    await f.close();
  }
});

test("Paws admin permission never overrides missing GitHub installation authority", async () => {
  const f = await fixture();
  try {
    expect((await f.request("admin", { check: async () => false })).status).toBe(409);
    expect(await listJobs(f.db)).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("in-flight administrator demotion rejects recovery transaction and is audited", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.request("admin", {
          check: async () => {
            await seed(f.db, (q) =>
              q.orm
                .update(q.t.workspaceMember)
                .set({ role: "member" })
                .where(eq(q.t.workspaceMember.userId, "admin")),
            );
            return true;
          },
        })
      ).status,
    ).toBe(403);
    expect(await listJobs(f.db)).toHaveLength(0);
    expect(await audits(f.db, "access.denied")).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("repository scope mutation during revalidation cannot enqueue recovery", async () => {
  const f = await fixture();
  try {
    expect(
      (
        await f.request("owner", {
          check: async () => {
            await replaceWorkspaceRepositories(f.db, {
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
    expect(await listJobs(f.db)).toHaveLength(0);
  } finally {
    await f.close();
  }
});
