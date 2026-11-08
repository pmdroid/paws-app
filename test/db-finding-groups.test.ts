import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  findingGroupingAdminsSteps,
  findingGroupingEnabledSteps,
  findingGroupSourcesSteps,
  getFindingGroupSteps,
  lastFindingGroupRunSteps,
  listFindingGroupsSteps,
  recoverFindingGroupRunsSteps,
  removeFindingFromOpenGroupsSteps,
  setFindingGroupingSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem, json, seed, withoutForeignKeys } from "./dialects";

type GroupSeed = {
  id: string;
  memberIds: number[];
  createdAt?: number;
  status?: string;
  action?: string;
  workspaceId?: string;
};

function seedGroup(db: Db, group: GroupSeed) {
  return seed(db, (q) =>
    q.orm.insert(q.t.findingGroup).values({
      id: group.id,
      workspaceId: group.workspaceId ?? "w",
      repository: "o/r",
      teamId: "team",
      title: group.id,
      summary: "summary",
      scope: "scope",
      memberIds: json(db, group.memberIds),
      createdAt: group.createdAt ?? 1,
      runId: "run",
      status: group.status ?? "open",
      action: group.action ?? null,
    }),
  );
}

function seedRun(db: Db, id: string, day: string, startedAt: number, status = "completed") {
  return seed(db, (q) =>
    q.orm
      .insert(q.t.findingGroupRun)
      .values({ id, workspaceId: "w", day, startedAt, fingerprint: "f", status }),
  );
}

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened = await open();
    try {
      await withoutForeignKeys(opened.db);
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  test("groups list open first, then newest, and a negative limit lists all", () =>
    withDb(async (db) => {
      await seedGroup(db, { id: "dismissed", memberIds: [1], createdAt: 9, status: "dismissed" });
      await seedGroup(db, { id: "old", memberIds: [2], createdAt: 1 });
      await seedGroup(db, { id: "new", memberIds: [3, 4], createdAt: 5 });
      await seedGroup(db, { id: "elsewhere", memberIds: [5], workspaceId: "other" });
      const ids = async (limit?: number) =>
        (await db.run((q) => listFindingGroupsSteps(q, "w", limit))).map((group) => group.id);
      expect(await ids()).toEqual(["new", "old", "dismissed"]);
      expect(await ids(2)).toEqual(["new", "old"]);
      expect((await db.run((q) => getFindingGroupSteps(q, "w", "new")))?.memberIds).toEqual([3, 4]);
      expect(await db.run((q) => getFindingGroupSteps(q, "other", "new"))).toBeNull();
    }));

  test("a removed finding leaves only untouched open groups and empties delete them", () =>
    withDb(async (db) => {
      await seedGroup(db, { id: "keeps-order", memberIds: [9, 7, 3] });
      await seedGroup(db, { id: "emptied", memberIds: [7] });
      await seedGroup(db, { id: "unrelated", memberIds: [70] });
      await seedGroup(db, { id: "claimed", memberIds: [7], action: "file" });
      await seedGroup(db, { id: "filed", memberIds: [7], status: "filed" });
      await seedGroup(db, { id: "elsewhere", memberIds: [7], workspaceId: "other" });
      await db.run((q) => removeFindingFromOpenGroupsSteps(q, "w", 7));
      const members = async (workspace: string) =>
        Object.fromEntries(
          (await db.run((q) => listFindingGroupsSteps(q, workspace))).map((group) => [
            group.id,
            group.memberIds,
          ]),
        );
      expect(await members("w")).toEqual({
        "keeps-order": [9, 3],
        unrelated: [70],
        claimed: [7],
        filed: [7],
      });
      expect(await members("other")).toEqual({ elsewhere: [7] });
    }));

  test("the last run is the latest started, and a tie goes to the later day", () =>
    withDb(async (db) => {
      expect(await db.run((q) => lastFindingGroupRunSteps(q, "w"))).toBeNull();
      await seedRun(db, "first", "2026-11-01", 10);
      await seedRun(db, "tied", "2026-11-02", 10);
      expect(await db.run((q) => lastFindingGroupRunSteps(q, "w"))).toEqual({
        id: "tied",
        startedAt: 10,
        finishedAt: null,
        status: "completed",
        tokens: null,
        groupCount: 0,
        error: null,
        skipReason: null,
      });
    }));

  test("only runs past the command lifetime are recovered as failed", () =>
    withDb(async (db) => {
      const now = 60 * 60_000;
      await seedRun(db, "expired", "2026-11-01", now - 11 * 60_000, "running");
      await seedRun(db, "live", "2026-11-02", now - 11 * 60_000 + 1, "running");
      await db.run((q) => recoverFindingGroupRunsSteps(q, now));
      const status = (id: string) =>
        db.run(function* (q) {
          const { findingGroupRun } = q.t;
          return yield* q.one(
            q.orm
              .select({ status: findingGroupRun.status, error: findingGroupRun.error })
              .from(findingGroupRun)
              .where(eq(findingGroupRun.id, id)),
          );
        });
      expect(await status("expired")).toEqual({
        status: "failed",
        error: "Grouping interrupted before completion",
      });
      expect(await status("live")).toEqual({ status: "running", error: null });
    }));

  test("sources come from the workspace's sessions that have a team, once each", () =>
    withDb(async (db) => {
      await insertWorkItem(db, "A");
      await insertWorkItem(db, "B");
      await insertWorkItem(db, "no-team");
      const session = async (itemId: string, sessionId: string) =>
        seed(db, (q) =>
          q.orm
            .update(q.t.workItem)
            .set({ sessionKey: sessionId })
            .where(eq(q.t.workItem.id, itemId)),
        );
      await session("A", "s1");
      await session("B", "s1");
      await session("no-team", "s2");
      await seed(
        db,
        (q) =>
          q.orm
            .insert(q.t.workspace)
            .values({ id: "w", linearOrganizationId: "org", name: "w", createdAt: 0 }),
        (q) =>
          q.orm
            .insert(q.t.linearSession)
            .values({ sessionId: "s1", organizationId: "org", teamId: "team", createdAt: 0 }),
        (q) =>
          q.orm.insert(q.t.linearSession).values({
            sessionId: "s2",
            organizationId: "org",
            teamId: null,
            createdAt: 0,
          }),
        (q) =>
          q.orm.insert(q.t.reviewFindingItem).values([
            { findingId: 1, itemId: "A", headSha: "h", seenAt: 0 },
            { findingId: 1, itemId: "B", headSha: "h", seenAt: 0 },
            { findingId: 2, itemId: "no-team", headSha: "h", seenAt: 0 },
          ]),
      );
      expect(await db.run((q) => findingGroupSourcesSteps(q, "w"))).toEqual([
        { id: 1, teamId: "team", sessionId: "s1" },
      ]);
      expect(await db.run((q) => findingGroupSourcesSteps(q, "other"))).toEqual([]);
    }));

  test("admins are usable owners and admins of the workspace", () =>
    withDb(async (db) => {
      const member = (
        userId: string,
        role: string,
        overrides: { active?: number; revokedAt?: number; workspaceId?: string } = {},
      ) =>
        seed(db, (q) =>
          q.orm.insert(q.t.workspaceMember).values({
            workspaceId: "w",
            userId,
            role,
            source: "manual",
            active: 1,
            checkedAt: 0,
            ...overrides,
          }),
        );
      await member("owner", "owner");
      await member("admin", "admin");
      await member("plain", "member");
      await member("inactive", "owner", { active: 0 });
      await member("revoked", "admin", { revokedAt: 5 });
      await member("elsewhere", "owner", { workspaceId: "other" });
      expect(await db.run((q) => findingGroupingAdminsSteps(q, "w"))).toEqual([
        { userId: "admin" },
        { userId: "owner" },
      ]);
    }));

  test("grouping is on until it is switched off, and switching twice is harmless", () =>
    withDb(async (db) => {
      const enabled = () => db.run((q) => findingGroupingEnabledSteps(q, "w"));
      expect(await enabled()).toBe(true);
      await db.run((q) => setFindingGroupingSteps(q, "w", false));
      await db.run((q) => setFindingGroupingSteps(q, "w", false));
      expect(await enabled()).toBe(false);
      await db.run((q) => setFindingGroupingSteps(q, "w", true));
      await db.run((q) => setFindingGroupingSteps(q, "w", true));
      expect(await enabled()).toBe(true);
    }));
});
