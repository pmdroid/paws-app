import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  getLinearSessionAccessSteps,
  postgresDb,
  restoreLinearInstallation,
  revokeLinearInstallation,
  workspaceSessionCandidatesSteps,
  workspaceSessionIds,
  type Db,
} from "../src/db";
import { insertWorkItemSteps, seed } from "./pglite-fixtures";
import { pgliteDb, tempStore } from "./pglite";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

const PEOPLE = [
  ["admin", "admin", null, []],
  ["member", "member", null, ["team-a"]],
  ["gone", "member", 5, ["team-a"]],
] as const;

async function workspace(db: Db, sessions: { sessionId: string; [key: string]: unknown }[]) {
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.workspace)
        .values({ id: "w", linearOrganizationId: "org", name: "Acme", createdAt: 0 }),
    (q) =>
      q.orm.insert(q.t.workspaceUser).values(
        PEOPLE.map(([id]) => ({
          id,
          linearUserId: `linear-${id}`,
          name: id,
          email: `${id}@acme.test`,
        })),
      ),
    (q) =>
      q.orm.insert(q.t.workspaceMember).values(
        PEOPLE.map(([userId, role, revokedAt]) => ({
          workspaceId: "w",
          userId,
          role,
          source: "linear",
          active: 1,
          checkedAt: 0,
          revokedAt,
        })),
      ),
    (q) =>
      q.orm
        .insert(q.t.workspaceUserTeam)
        .values(
          PEOPLE.flatMap(([userId, , , teams]) =>
            teams.map((teamId) => ({ workspaceId: "w", userId, teamId })),
          ),
        ),
    (q) =>
      q.orm.insert(q.t.linearSession).values(
        sessions.map((session) => ({
          organizationId: "org",
          oauthClientId: "client",
          appUserId: "app",
          teamId: "team-a",
          installationObservedAt: 1,
          createdAt: 0,
          ...session,
        })),
      ),
  );
}

const visible = (db: Db, userId: string) => workspaceSessionIds(db, "w", userId, "client");

const reference = (db: Db, userId: string) =>
  db.run(function* (q) {
    const ids: string[] = [];
    for (const id of yield* workspaceSessionCandidatesSteps(q, "w", userId, "client"))
      if ((yield* getLinearSessionAccessSteps(q, id)) === "allowed") ids.push(id);
    return ids;
  });

test("the visible session list follows membership, team, repository, identity and revocation", async () => {
  const { db, close } = await tempStore();
  closes.push(close);
  await workspace(db, [
    { sessionId: "a" },
    { sessionId: "b", teamId: "team-b" },
    { sessionId: "granted" },
    { sessionId: "missing-app", appUserId: null },
    { sessionId: "blank-app", appUserId: "" },
    { sessionId: "blank-org", organizationId: "" },
    { sessionId: "removed" },
    { sessionId: "excluded" },
  ]);
  await seed(db, (q) =>
    q.orm.insert(q.t.linearTeamAccess).values(
      [
        ["team-a", 1],
        ["team-b", 1],
      ].map(([teamId, allowed]) => ({
        organizationId: "org",
        oauthClientId: "client",
        appUserId: "app",
        teamId: teamId as string,
        allowed: allowed as number,
        observedAt: 1,
      })),
    ),
  );
  await db.run(function* (q) {
    yield* q.exec(
      q.orm
        .update(q.t.linearSession)
        .set({ appUserId: "removed-app" })
        .where(eq(q.t.linearSession.sessionId, "removed")),
    );
    yield* q.exec(
      q.orm.insert(q.t.linearTeamAccess).values({
        organizationId: "org",
        oauthClientId: "client",
        appUserId: "removed-app",
        teamId: "team-a",
        allowed: 0,
        observedAt: 1,
      }),
    );
    yield* insertWorkItemSteps(q, "item");
    yield* q.exec(
      q.orm.update(q.t.workItem).set({ sessionKey: "excluded" }).where(eq(q.t.workItem.id, "item")),
    );
    yield* q.exec(
      q.orm
        .insert(q.t.workItemRepository)
        .values({ itemId: "item", owner: "acme", repo: "secret", remoteUrl: "x" }),
    );
  });
  const expected = { admin: ["a", "b", "granted"], member: ["a", "granted"], gone: [] };
  const check = async (lists: Record<string, string[]>) => {
    for (const [userId, ids] of Object.entries(lists)) {
      expect(await visible(db, userId)).toEqual(ids);
      expect(await reference(db, userId)).toEqual(ids);
    }
  };
  await check(expected);
  await seed(db, (q) =>
    q.orm
      .update(q.t.linearTeamAccess)
      .set({ allowed: 0 })
      .where(eq(q.t.linearTeamAccess.teamId, "team-b")),
  );
  await check({ ...expected, admin: ["a", "granted"] });
  const installation = { organizationId: "org", oauthClientId: "client" };
  await revokeLinearInstallation(db, { ...installation, eventKey: "revoke", createdAtMs: 10 });
  await check({ admin: [], member: [], gone: [] });
  expect(
    await restoreLinearInstallation(db, {
      ...installation,
      appUserId: "app",
      generation: 1,
      grantStartedAtMs: 20,
      credentialFingerprint: "fingerprint",
    }),
  ).toBe(true);
  await check({ ...expected, admin: ["a", "granted"] });
});

test("the visible session list takes the same number of statements for 10 and 1,000 sessions", async () => {
  const counts: number[] = [];
  for (const size of [10, 1000]) {
    let statements = 0;
    const pg = await pgliteDb({ logger: { logQuery: () => void (statements += 1) } });
    const db = postgresDb(pg);
    closes.push(() => pg.$client.close());
    const ids = Array.from({ length: size }, (_, n) => `s${String(n).padStart(4, "0")}`);
    await workspace(
      db,
      ids.map((sessionId) => ({ sessionId })),
    );
    statements = 0;
    expect(await visible(db, "member")).toEqual(ids);
    counts.push(statements);
  }
  expect(counts).toEqual([1, 1]);
});
