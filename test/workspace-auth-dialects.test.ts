import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  auditWorkspaceAccessSteps,
  consumeWorkspaceOAuthRequestSteps,
  listUserWorkspacesSteps,
  listWorkspaceMembersSteps,
  listWorkspaceMemberSummariesSteps,
  listWorkspaceRepositoriesSteps,
  listWorkspaceRepositoryNamesSteps,
  memberOpenItemsSteps,
  recordWorkspaceRevocationSteps,
  replaceWorkspaceRepositoriesSteps,
  requireWorkspaceAdminSteps,
  saveWorkspaceOAuthRequestSteps,
  setWorkspaceRoleSteps,
  workspaceMemberSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItemSteps, seed, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  return handle.db;
}

async function seedWorkspace(db: Db) {
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.workspace).values({
        id: "w",
        linearOrganizationId: "org",
        name: "Acme",
        createdAt: 0,
      }),
    (q) =>
      q.orm.insert(q.t.workspaceUser).values([
        { id: "ada", linearUserId: "lin-ada", name: "Ada", email: "ada@x" },
        { id: "bo", linearUserId: "lin-bo", name: "Bo", email: "bo@x" },
        { id: "cy", linearUserId: "lin-cy", name: "Cy", email: "cy@x" },
      ]),
    (q) =>
      q.orm.insert(q.t.workspaceMember).values([
        {
          workspaceId: "w",
          userId: "ada",
          role: "admin",
          source: "linear",
          active: 1,
          checkedAt: 1,
        },
        {
          workspaceId: "w",
          userId: "bo",
          role: "member",
          source: "linear",
          active: 1,
          checkedAt: 1,
        },
        {
          workspaceId: "w",
          userId: "cy",
          role: "member",
          source: "linear",
          active: 1,
          checkedAt: 1,
          revokedAt: 5,
          revokedBy: "ada",
        },
      ]),
    (q) =>
      q.orm.insert(q.t.workspaceUserTeam).values({ workspaceId: "w", userId: "bo", teamId: "t1" }),
  );
}

forEachDialect((open) => {
  test("OAuth requests are saved, capped and consumed once", async () => {
    const db = await connect(open);
    const request = { stateHash: "s", browserHash: "b", bootstrapHash: null, expiresAt: 1_000_000 };
    expect(await db.transaction((q) => saveWorkspaceOAuthRequestSteps(q, request))).toBe(true);
    expect(await db.run((q) => consumeWorkspaceOAuthRequestSteps(q, "s", "other", 0))).toBeNull();
    expect(
      await db.run((q) => consumeWorkspaceOAuthRequestSteps(q, "s", "b", 2_000_000)),
    ).toBeNull();
    expect(await db.run((q) => consumeWorkspaceOAuthRequestSteps(q, "s", "b", 0))).toEqual({
      ...request,
      assignmentHash: null,
    });
    expect(await db.run((q) => consumeWorkspaceOAuthRequestSteps(q, "s", "b", 0))).toBeNull();

    await seed(db, (q) =>
      q.orm.insert(q.t.workspaceOauthRequest).values(
        Array.from({ length: 1_009 }, (_, n) => ({
          stateHash: `full-${n}`,
          browserHash: "b",
          verifier: "",
          expiresAt: n < 10 ? 100 : 2_000_000,
        })),
      ),
    );
    const next = { ...request, stateHash: "n", expiresAt: 600_100 };
    expect(await db.transaction((q) => saveWorkspaceOAuthRequestSteps(q, next))).toBe(true);
    expect(
      await db.transaction((q) => saveWorkspaceOAuthRequestSteps(q, { ...next, stateHash: "m" })),
    ).toBe(false);
  });

  test("members, workspaces and the admin check read usable membership", async () => {
    const db = await connect(open);
    await seedWorkspace(db);
    expect(await db.run((q) => workspaceMemberSteps(q, "w", "bo"))).toEqual({
      workspaceId: "w",
      userId: "bo",
      linearUserId: "lin-bo",
      name: "Bo",
      email: "bo@x",
      role: "member",
      source: "linear",
      active: true,
      revokedAt: null,
      revokedBy: null,
      checkedAt: 1,
      teamIds: ["t1"],
    });
    expect(await db.run((q) => workspaceMemberSteps(q, "w", "nobody"))).toBeNull();
    expect(await db.run((q) => listUserWorkspacesSteps(q, "ada"))).toEqual([
      { id: "w", name: "Acme", role: "admin" },
    ]);
    expect(await db.run((q) => listUserWorkspacesSteps(q, "cy"))).toEqual([]);
    expect(await db.run((q) => listWorkspaceMembersSteps(q, "w"))).toEqual([
      { id: "ada", name: "Ada", role: "admin", active: 1, revokedAt: null, revokedBy: null },
      { id: "bo", name: "Bo", role: "member", active: 1, revokedAt: null, revokedBy: null },
      { id: "cy", name: "Cy", role: "member", active: 1, revokedAt: 5, revokedBy: "ada" },
    ]);
    await db.run((q) => requireWorkspaceAdminSteps(q, "w", "ada"));
    expect(db.run((q) => requireWorkspaceAdminSteps(q, "w", "bo"))).rejects.toThrow(
      "Workspace administration is required.",
    );
  });

  test("roles change manually, keep an admin and are audited", async () => {
    const db = await connect(open);
    await seedWorkspace(db);
    const change = { workspaceId: "w", actorId: "ada", now: 10 };
    expect(
      db.transaction((q) => setWorkspaceRoleSteps(q, { ...change, userId: "ada", role: "member" })),
    ).rejects.toThrow("The workspace must keep an active admin.");
    expect(
      db.transaction((q) => setWorkspaceRoleSteps(q, { ...change, userId: "cy", role: "admin" })),
    ).rejects.toThrow("An active workspace member is required.");
    await db.transaction((q) =>
      setWorkspaceRoleSteps(q, { ...change, userId: "bo", role: "admin" }),
    );
    const bo = await db.run((q) => workspaceMemberSteps(q, "w", "bo"));
    expect([bo?.role, bo?.source]).toEqual(["admin", "manual"]);
    await db.transaction((q) =>
      setWorkspaceRoleSteps(q, { ...change, userId: "ada", role: "member" }),
    );
    const audit = await db.run((q) =>
      q.all(
        q.orm
          .select({
            userId: q.t.workspaceAccessAudit.userId,
            subject: q.t.workspaceAccessAudit.subject,
          })
          .from(q.t.workspaceAccessAudit)
          .orderBy(q.t.workspaceAccessAudit.id),
      ),
    );
    expect(audit).toEqual([
      { userId: "ada", subject: "bo:admin" },
      { userId: "ada", subject: "ada:member" },
    ]);
  });

  test("repositories are replaced and listed with connected ones", async () => {
    const db = await connect(open);
    await seedWorkspace(db);
    await seed(db, (q) =>
      q.orm
        .insert(q.t.workspaceGithubConnection)
        .values({ workspaceId: "w", repositories: JSON.stringify(["acme/web", "ACME/API", 3]) }),
    );
    const repositories = [
      { repository: "acme/web", teamId: "t2" },
      { repository: "acme/api", teamId: "t1" },
    ];
    await db.transaction((q) =>
      replaceWorkspaceRepositoriesSteps(q, {
        workspaceId: "w",
        actorId: "ada",
        repositories,
        now: 1,
      }),
    );
    expect(await db.run((q) => listWorkspaceRepositoriesSteps(q, "w"))).toEqual([
      { repository: "acme/api", teamId: "t1" },
      { repository: "acme/web", teamId: "t2" },
    ]);
    expect(await db.run((q) => listWorkspaceRepositoryNamesSteps(q, "w"))).toEqual([
      "acme/api",
      "acme/web",
    ]);
    expect(await db.run((q) => listWorkspaceRepositoryNamesSteps(q, "other"))).toEqual([]);
    expect(
      db.transaction((q) =>
        replaceWorkspaceRepositoriesSteps(q, {
          workspaceId: "w",
          actorId: "bo",
          repositories: [],
          now: 2,
        }),
      ),
    ).rejects.toThrow("Workspace administration is required.");
    expect(await db.run((q) => listWorkspaceRepositoriesSteps(q, "w"))).toHaveLength(2);
  });

  test("revocation records the cut-off, unbinds VMs and lists open work", async () => {
    const db = await connect(open);
    await seedWorkspace(db);
    await seed(
      db,
      (q) =>
        q.orm.insert(q.t.runner).values({
          id: "box",
          workspaceId: "w",
          ownerUserId: "bo",
          name: "box",
          status: "active",
          createdAt: 0,
        }),
      (q) =>
        q.orm.insert(q.t.memberVm).values({
          id: "vm",
          workspaceId: "w",
          userId: "bo",
          vmName: "bo-vm",
          step: "ready",
          runnerId: "box",
          stepStartedAt: 0,
          createdAt: 0,
          updatedAt: 0,
        }),
      (q) =>
        q.orm.insert(q.t.workspaceAccessAudit).values([
          {
            workspaceId: "w",
            userId: "bo",
            action: "session.created",
            subject: "bo",
            createdAt: 7,
          },
          {
            workspaceId: "w",
            userId: "bo",
            action: "session.created",
            subject: "bo",
            createdAt: 9,
          },
        ]),
    );
    await db.run(function* (q) {
      for (const id of ["b-owned", "a-delegated", "c-done", "d-other"])
        yield* insertWorkItemSteps(q, id);
      const item = q.t.workItem;
      yield* q.exec(q.orm.update(item).set({ ownerUserId: "bo" }).where(eq(item.id, "b-owned")));
      yield* q.exec(
        q.orm.update(item).set({ delegatedBy: "lin-bo" }).where(eq(item.id, "a-delegated")),
      );
      yield* q.exec(
        q.orm.update(item).set({ ownerUserId: "bo", state: "merged" }).where(eq(item.id, "c-done")),
      );
      yield* q.exec(
        q.orm.update(item).set({ delegatedBy: "lin-ada" }).where(eq(item.id, "d-other")),
      );
      yield* auditWorkspaceAccessSteps(q, {
        workspaceId: "w",
        userId: "ada",
        action: "member.role.changed",
        subject: "x",
        now: 1,
      });
    });

    expect(await db.run((q) => memberOpenItemsSteps(q, "w", "bo", "lin-bo"))).toEqual([
      { id: "a-delegated" },
      { id: "b-owned" },
    ]);
    const summaries = await db.run((q) => listWorkspaceMemberSummariesSteps(q, "w"));
    expect(
      summaries.map((member) => [member.id, member.lastSignInAt, member.runners, member.openItems]),
    ).toEqual([
      ["ada", null, 0, 1],
      ["bo", 9, 1, 2],
      ["cy", null, 0, 0],
    ]);
    expect(summaries[2]).toMatchObject({ revokedAt: 5, revokedBy: "ada", revokedByName: "Ada" });

    const input = { workspaceId: "w", actorId: "ada", userId: "bo", revoked: true, now: 20 };
    await db.transaction((q) => recordWorkspaceRevocationSteps(q, input));
    const vm = () =>
      db.run((q) =>
        q.one(
          q.orm
            .select({ runnerId: q.t.memberVm.runnerId, updatedAt: q.t.memberVm.updatedAt })
            .from(q.t.memberVm),
        ),
      );
    expect(await vm()).toEqual({ runnerId: null, updatedAt: 20 });
    const bo = await db.run((q) => workspaceMemberSteps(q, "w", "bo"));
    expect([bo?.revokedAt, bo?.revokedBy]).toEqual([20, "ada"]);

    await db.transaction((q) =>
      recordWorkspaceRevocationSteps(q, { ...input, revoked: false, now: 30 }),
    );
    const restored = await db.run((q) => workspaceMemberSteps(q, "w", "bo"));
    expect([restored?.revokedAt, restored?.revokedBy]).toEqual([null, null]);
    expect(await vm()).toEqual({ runnerId: null, updatedAt: 20 });
  });
});
