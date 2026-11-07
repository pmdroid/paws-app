import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  auditWorkspaceAccessSteps,
  saveWorkspaceIdentityLinkSteps,
  sessionRepositoriesAllowedSteps,
  workspaceIdentityCandidatesSteps,
  workspaceIdentityLinksSteps,
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

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  const db = handle.db;
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
});
