import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  applyLinearUserChangeSteps,
  auditWorkspaceAccessSteps,
  consumeWorkspaceBootstrapSteps,
  createWorkspaceBootstrapSteps,
  deleteWorkspaceSessionSteps,
  getWorkspaceSteps,
  lastPausedBySteps,
  listWorkspaceAuditSteps,
  putWorkspaceUserSteps,
  readWorkspaceSessionSteps,
  saveWorkspaceIdentityLinkSteps,
  saveWorkspaceSessionSteps,
  sessionRepositoriesAllowedSteps,
  syncWorkspaceMemberSteps,
  workspaceForOrganizationSteps,
  workspaceIdentityCandidatesSteps,
  workspaceIdentityLinksSteps,
  workspaceLinearMemberSteps,
  workspaceMemberSteps,
  workspaceSessionCandidatesSteps,
  type Db,
  type WorkspaceIdentityLink,
} from "../src/db";
import { forEachDialect, insertWorkItemSteps, seed, type DialectDb } from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function empty(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  return handle.db;
}

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const db = await empty(open);
  const people = [
    { id: "u1", name: "Ada", role: "admin", revokedAt: null },
    { id: "u2", name: "Bob", role: "member", revokedAt: null },
    { id: "u3", name: "Cy", role: "member", revokedAt: 5 },
  ];
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "w", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
    (q) =>
      q.orm.insert(q.t.workspaceUser).values(
        people.map((p) => ({
          id: p.id,
          linearUserId: `linear-${p.id}`,
          name: p.name,
          email: `${p.id}@acme.test`,
        })),
      ),
    (q) =>
      q.orm.insert(q.t.workspaceMember).values(
        people.map((p) => ({
          workspaceId: "w",
          userId: p.id,
          role: p.role,
          source: "linear",
          active: 1,
          checkedAt: 1,
          revokedAt: p.revokedAt,
        })),
      ),
    (q) =>
      q.orm.insert(q.t.workspaceUserTeam).values([
        { workspaceId: "w", userId: "u2", teamId: "team-b" },
        { workspaceId: "w", userId: "u2", teamId: "team-a" },
      ]),
  );
  return db;
}

const link = (input: Partial<WorkspaceIdentityLink & { actorId: string }>) => ({
  workspaceId: "w",
  userId: "u2",
  provider: "slack" as const,
  externalId: "S2",
  installationId: "T1",
  method: "email" as const,
  status: "linked" as const,
  checkedAt: 10,
  ...input,
});

function seedWorkspace(db: Db) {
  return seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "w", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
    (q) =>
      q.orm
        .insert(q.t.workspaceUser)
        .values({ id: "u", linearUserId: "lin-u", name: "Ada", email: "ada@example.com" }),
  );
}

const storedSession = {
  tokenHash: "t",
  userId: "u",
  workspaceId: "w",
  csrfToken: "csrf",
  authenticatedAt: 10,
  lastSeenAt: 10,
  expiresAt: 100,
};

forEachDialect((open) => {
  test("a member loads with their teams and audit rows are written", async () => {
    const db = await connect(open);
    expect(await db.run((q) => workspaceMemberSteps(q, "w", "u2"))).toEqual({
      workspaceId: "w",
      userId: "u2",
      linearUserId: "linear-u2",
      name: "Bob",
      email: "u2@acme.test",
      role: "member",
      source: "linear",
      active: true,
      revokedAt: null,
      revokedBy: null,
      checkedAt: 1,
      teamIds: ["team-a", "team-b"],
    });
    expect(await db.run((q) => workspaceMemberSteps(q, "w", "nobody"))).toBeNull();
    await db.run((q) =>
      auditWorkspaceAccessSteps(q, {
        workspaceId: "w",
        userId: null,
        action: "a",
        subject: "s",
        now: 3,
      }),
    );
    const audit = await db.run((q) =>
      q.all(
        q.orm
          .select()
          .from(q.t.workspaceAccessAudit)
          .where(eq(q.t.workspaceAccessAudit.workspaceId, "w")),
      ),
    );
    expect(audit.map(({ id: _, ...row }) => row)).toEqual([
      { workspaceId: "w", userId: null, action: "a", subject: "s", createdAt: 3 },
    ]);
  });

  test("identity links save, keep a manual choice and refuse non-admins", async () => {
    const db = await connect(open);
    const save = (input: Parameters<typeof link>[0]) =>
      db.transaction((q) => saveWorkspaceIdentityLinkSteps(q, link(input)));
    const audits = () =>
      db.run((q) =>
        q.all(
          q.orm
            .select({ subject: q.t.workspaceAccessAudit.subject })
            .from(q.t.workspaceAccessAudit),
        ),
      );
    expect(await db.run((q) => workspaceIdentityCandidatesSteps(q, "w"))).toEqual([
      { userId: "u1", email: "u1@acme.test" },
      { userId: "u2", email: "u2@acme.test" },
    ]);
    await save({});
    await save({ method: "manual", externalId: "S9", actorId: "u1", checkedAt: 11 });
    await save({ externalId: "S3", checkedAt: 12 });
    await save({ userId: "u1", provider: "github", externalId: "G1", checkedAt: 4 });
    await save({ userId: "u1", provider: "github", externalId: "G0", checkedAt: 3 });
    await expect(save({ userId: "u3" })).rejects.toThrow("Choose an active workspace member.");
    await expect(save({ actorId: "u2" })).rejects.toThrow("Workspace administration is required.");
    expect(await db.run((q) => workspaceIdentityLinksSteps(q, "w"))).toEqual([
      {
        userId: "u1",
        name: "Ada",
        email: "u1@acme.test",
        provider: "github",
        externalId: "G1",
        installationId: "T1",
        method: "email",
        status: "linked",
        checkedAt: 4,
      },
      {
        userId: "u2",
        name: "Bob",
        email: "u2@acme.test",
        provider: "slack",
        externalId: "S9",
        installationId: "T1",
        method: "manual",
        status: "linked",
        checkedAt: 11,
      },
    ]);
    expect((await audits()).map((a) => a.subject)).toEqual([
      "u2:slack:email:linked:S2",
      "u2:slack:manual:linked:S9",
      "u1:github:email:linked:G1",
    ]);
    expect(await db.run((q) => workspaceIdentityCandidatesSteps(q, "w"))).toEqual([
      { userId: "u1", email: "u1@acme.test" },
    ]);
  });

  test("session scope follows teams, linked repositories and the catalog", async () => {
    const db = await connect(open);
    const session = (sessionId: string, teamId: string | null, observed: number | null = 1) => ({
      sessionId,
      organizationId: "org",
      oauthClientId: "client",
      teamId,
      installationObservedAt: observed,
      createdAt: 0,
    });
    await seed(
      db,
      (q) =>
        q.orm
          .insert(q.t.linearSession)
          .values([
            session("s1", "team-a"),
            session("s2", "team-c"),
            session("s3", "team-a"),
            session("s4", "team-a", null),
            session("s5", null),
            { ...session("s6", "team-a"), oauthClientId: "other" },
          ]),
      (q) =>
        q.orm.insert(q.t.workspaceRepository).values({
          workspaceId: "w",
          repository: "Acme/App",
          teamId: "team-a",
        }),
      (q) =>
        q.orm.insert(q.t.repositoryCatalog).values({
          repository: "acme/cat",
          owner: "acme",
          repo: "cat",
          remoteUrl: "https://github.com/acme/cat.git",
          defaultBranch: "main",
          refreshedAt: 0,
        }),
    );
    await db.run(function* (q) {
      yield* insertWorkItemSteps(q, "i1");
      yield* insertWorkItemSteps(q, "i3");
      yield* q.exec(
        q.orm.update(q.t.workItem).set({ sessionKey: "s1" }).where(eq(q.t.workItem.id, "i1")),
      );
      yield* q.exec(
        q.orm.update(q.t.workItem).set({ sessionKey: "s3" }).where(eq(q.t.workItem.id, "i3")),
      );
      yield* q.exec(
        q.orm.insert(q.t.workItemRepository).values([
          { itemId: "i1", owner: "ACME", repo: "app", remoteUrl: "x" },
          { itemId: "i3", owner: "acme", repo: "other", remoteUrl: "x" },
        ]),
      );
    });
    const candidates = (userId: string) =>
      db.run((q) => workspaceSessionCandidatesSteps(q, "w", userId, "client"));
    expect(await candidates("u1")).toEqual(["s1", "s2"]);
    expect(await candidates("u2")).toEqual(["s1"]);
    expect(await candidates("u3")).toEqual([]);
    const allowed = (sessions: string[], repositories: string[]) =>
      db.run((q) => sessionRepositoriesAllowedSteps(q, sessions, repositories));
    expect(await allowed(["s1"], ["acme/APP", "acme/other", "acme/cat"])).toEqual(
      new Set(["acme/APP"]),
    );
    expect(await allowed(["s2", "s5"], ["acme/app", "Acme/Cat"])).toEqual(new Set(["Acme/Cat"]));
    expect(await allowed([], ["acme/app"])).toEqual(new Set());
    expect(await allowed(["s1"], [])).toEqual(new Set());
  });

  test("a bootstrap is claimed once and creates the workspace with its admin", async () => {
    const db = await empty(open);
    expect(await db.run((q) => getWorkspaceSteps(q, "w"))).toBeNull();
    await db.run((q) =>
      createWorkspaceBootstrapSteps(q, { tokenHash: "b", organizationId: "org", expiresAt: 100 }),
    );
    const user = { id: "u", linearUserId: "lin-u", name: "Ada", email: "a@example.com" };
    expect(await db.run((q) => putWorkspaceUserSteps(q, user))).toBe("u");
    expect(
      await db.run((q) => putWorkspaceUserSteps(q, { ...user, id: "other", name: "Ada L" })),
    ).toBe("u");
    const claim = { id: "w", organizationId: "org", name: "Acme", tokenHash: "b", userId: "u" };
    await expect(
      db.transaction((q) => consumeWorkspaceBootstrapSteps(q, { ...claim, now: 100 })),
    ).rejects.toThrow("Workspace bootstrap is invalid or expired.");
    expect(
      await db.transaction((q) => consumeWorkspaceBootstrapSteps(q, { ...claim, now: 50 })),
    ).toEqual({ id: "w", organizationId: "org", name: "Acme" });
    await expect(
      db.transaction((q) => consumeWorkspaceBootstrapSteps(q, { ...claim, now: 60 })),
    ).rejects.toThrow("Workspace bootstrap is invalid or expired.");
    const record = { id: "w", organizationId: "org", name: "Acme" };
    expect(await db.run((q) => getWorkspaceSteps(q, "w"))).toEqual(record);
    expect(await db.run((q) => workspaceForOrganizationSteps(q, "org"))).toEqual(record);
    expect(await db.run((q) => workspaceLinearMemberSteps(q, "w", "lin-u"))).toEqual({
      workspaceId: "w",
      userId: "u",
      linearUserId: "lin-u",
      name: "Ada L",
      email: "a@example.com",
      role: "admin",
      source: "manual",
      active: true,
      revokedAt: null,
      revokedBy: null,
      checkedAt: 50,
      teamIds: [],
    });
    expect(await db.run((q) => workspaceLinearMemberSteps(q, "w", "nobody"))).toBeNull();
    const audit = await db.run((q) => listWorkspaceAuditSteps(q, "w", Number.MAX_SAFE_INTEGER));
    expect(audit.nextBefore).toBeNull();
    expect(audit.entries).toEqual([
      {
        id: expect.any(Number),
        actorId: "u",
        actorName: "Ada L",
        action: "workspace.bootstrapped",
        subject: "w",
        createdAt: 50,
      },
    ]);
  });

  test("a member sync keeps manual roles, skips stale checks and revokes sessions", async () => {
    const db = await empty(open);
    await seedWorkspace(db);
    const sync = { workspaceId: "w", userId: "u", role: "member" as const, active: true };
    expect(
      await db.transaction((q) =>
        syncWorkspaceMemberSteps(q, { ...sync, teamIds: ["b", "a", "a"], now: 10 }),
      ),
    ).toBe(true);
    expect(await db.run((q) => workspaceMemberSteps(q, "w", "u"))).toMatchObject({
      role: "member",
      source: "linear",
      active: true,
      checkedAt: 10,
      teamIds: ["a", "b"],
    });
    expect(
      await db.transaction((q) => syncWorkspaceMemberSteps(q, { ...sync, teamIds: [], now: 5 })),
    ).toBe(false);
    await db.run((q) =>
      q.exec(
        q.orm
          .update(q.t.workspaceMember)
          .set({ source: "manual", role: "admin" })
          .where(eq(q.t.workspaceMember.userId, "u")),
      ),
    );
    await db.transaction((q) => syncWorkspaceMemberSteps(q, { ...sync, teamIds: ["a"], now: 11 }));
    const manual = await db.run((q) =>
      q.one(
        q.orm
          .select({ role: q.t.workspaceMember.role, manualRole: q.t.workspaceMember.manualRole })
          .from(q.t.workspaceMember),
      ),
    );
    expect(manual).toEqual({ role: "admin", manualRole: "admin" });
    await db.run((q) => saveWorkspaceSessionSteps(q, storedSession));
    expect(
      await db.transaction((q) =>
        syncWorkspaceMemberSteps(q, { ...sync, active: false, teamIds: ["a"], now: 20 }),
      ),
    ).toBe(true);
    expect(await db.run((q) => workspaceMemberSteps(q, "w", "u"))).toMatchObject({
      role: "admin",
      active: false,
      checkedAt: 20,
      teamIds: [],
    });
    expect(await db.transaction((q) => readWorkspaceSessionSteps(q, "t", 15, 50))).toBeNull();
    const audit = await db.run((q) => listWorkspaceAuditSteps(q, "w", Number.MAX_SAFE_INTEGER));
    expect(audit.entries.map((entry) => [entry.action, entry.createdAt])).toEqual([
      ["membership.revoked", 20],
      ["membership.synced", 11],
      ["membership.synced", 10],
    ]);
  });

  test("a Linear user change rechecks the member or removes a guest", async () => {
    const db = await empty(open);
    await seedWorkspace(db);
    const change = { organizationId: "org", userId: "lin-u", active: true, guest: false };
    expect(
      await db.transaction((q) =>
        applyLinearUserChangeSteps(q, { ...change, organizationId: "nope", now: 1 }),
      ),
    ).toBe(false);
    expect(await db.transaction((q) => applyLinearUserChangeSteps(q, { ...change, now: 1 }))).toBe(
      false,
    );
    await db.transaction((q) =>
      syncWorkspaceMemberSteps(q, {
        workspaceId: "w",
        userId: "u",
        role: "member",
        active: true,
        teamIds: ["a"],
        now: 30,
      }),
    );
    expect(await db.transaction((q) => applyLinearUserChangeSteps(q, { ...change, now: 40 }))).toBe(
      true,
    );
    expect(await db.run((q) => workspaceMemberSteps(q, "w", "u"))).toMatchObject({
      active: true,
      checkedAt: 0,
      teamIds: ["a"],
    });
    await db.transaction((q) =>
      syncWorkspaceMemberSteps(q, {
        workspaceId: "w",
        userId: "u",
        role: "member",
        active: true,
        teamIds: ["a"],
        now: 50,
      }),
    );
    expect(
      await db.transaction((q) =>
        applyLinearUserChangeSteps(q, { ...change, guest: true, now: 45 }),
      ),
    ).toBe(true);
    expect(await db.run((q) => workspaceMemberSteps(q, "w", "u"))).toMatchObject({
      active: false,
      checkedAt: 50,
      teamIds: [],
    });
  });

  test("a session is extended while live and removed once expired", async () => {
    const db = await empty(open);
    await seedWorkspace(db);
    await db.run((q) => saveWorkspaceSessionSteps(q, storedSession));
    expect(await db.transaction((q) => readWorkspaceSessionSteps(q, "t", 5, 50))).toBeNull();
    expect(await db.transaction((q) => readWorkspaceSessionSteps(q, "t", 20, 50))).toEqual({
      ...storedSession,
      lastSeenAt: 20,
      expiresAt: 70,
    });
    expect(await db.transaction((q) => readWorkspaceSessionSteps(q, "t", 70, 50))).toBeNull();
    await db.run((q) => saveWorkspaceSessionSteps(q, storedSession));
    expect(await db.transaction((q) => readWorkspaceSessionSteps(q, "t", 20, 50))).not.toBeNull();
    await db.run((q) => deleteWorkspaceSessionSteps(q, "t"));
    expect(await db.transaction((q) => readWorkspaceSessionSteps(q, "t", 20, 50))).toBeNull();
  });

  test("the access audit pages by id and names who paused an item", async () => {
    const db = await empty(open);
    await seedWorkspace(db);
    expect(await db.run((q) => lastPausedBySteps(q, "item"))).toBeNull();
    await db.run(function* (q) {
      for (let now = 1; now <= 52; now += 1)
        yield* auditWorkspaceAccessSteps(q, {
          workspaceId: "w",
          userId: now === 52 ? null : "u",
          action: now % 2 === 0 ? "execution.pause" : "execution.resume",
          subject: "item",
          now,
        });
    });
    const first = await db.run((q) => listWorkspaceAuditSteps(q, "w", Number.MAX_SAFE_INTEGER));
    expect(first.entries).toHaveLength(50);
    expect(first.entries[0]).toMatchObject({ actorId: null, actorName: null, createdAt: 52 });
    expect(first.nextBefore).toBe(first.entries[49]!.id);
    const second = await db.run((q) => listWorkspaceAuditSteps(q, "w", first.nextBefore!));
    expect(second.entries.map((entry) => entry.createdAt)).toEqual([2, 1]);
    expect(second.nextBefore).toBeNull();
    expect(await db.run((q) => lastPausedBySteps(q, "item"))).toBe("Ada");
  });
});
