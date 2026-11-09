import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  claimFindingGroupActionSteps,
  closeFindingGroupSteps,
  distinctWorkspaceRepositoriesSteps,
  enabledRunnerIdsSteps,
  findingHasGroupActionSteps,
  firstWorkspaceIdSteps,
  latestCloseoutProgressMarkerSteps,
  listWorkspaceIdsSteps,
  missingSnapshotTargetsSteps,
  oldestWorkspaceNameSteps,
  openDelegationWorkspaceIdSteps,
  recordWakeSteps,
  releaseFindingGroupActionSteps,
  runnerAgentReadinessSteps,
  runnerNameAndOwnerSteps,
  workspaceOrganizationIdsSteps,
  workspaceUserLinearIdSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, insertWorkItemSteps, json, seed, withoutForeignKeys } from "./dialects";

function workspaces(db: Db) {
  return seed(
    db,
    (q) =>
      q.orm.insert(q.t.workspace).values({
        id: "w2",
        linearOrganizationId: "org-2",
        name: "Second",
        createdAt: 1,
      }),
    (q) =>
      q.orm.insert(q.t.workspace).values({
        id: "w1",
        linearOrganizationId: "org-1",
        name: "First",
        createdAt: 2,
      }),
  );
}

function* itemSteps(q: Q, id: string, delegationId: string, sessionKey: string, state = "queued") {
  yield* insertWorkItemSteps(q, id);
  yield* q.exec(
    q.orm
      .update(q.t.workItem)
      .set({ delegationId, sessionKey, state })
      .where(eq(q.t.workItem.id, id)),
  );
}

forEachDialect((open) => {
  test("workspace reads", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      expect(await db.run((q) => firstWorkspaceIdSteps(q))).toBeNull();
      expect(await db.run((q) => oldestWorkspaceNameSteps(q))).toBeNull();
      await workspaces(db);
      expect(await db.run((q) => firstWorkspaceIdSteps(q))).toBe("w1");
      expect(await db.run((q) => oldestWorkspaceNameSteps(q))).toBe("Second");
      expect(await db.run((q) => workspaceOrganizationIdsSteps(q, 1))).toEqual(["org-1"]);
      expect((await db.run((q) => listWorkspaceIdsSteps(q))).sort()).toEqual(["w1", "w2"]);
      await seed(db, (q) =>
        q.orm
          .insert(q.t.workspaceUser)
          .values({ id: "ada", linearUserId: "lin-ada", name: "Ada", email: "a@x" }),
      );
      expect(await db.run((q) => workspaceUserLinearIdSteps(q, "ada"))).toBe("lin-ada");
      expect(await db.run((q) => workspaceUserLinearIdSteps(q, "bob"))).toBeNull();
      await db.run((q) => itemSteps(q, "open", "d1", "s1"));
      await db.run((q) => itemSteps(q, "done", "d2", "s2", "merged"));
      expect(await db.run((q) => openDelegationWorkspaceIdSteps(q, "org-1", "d1"))).toBe("w1");
      expect(await db.run((q) => openDelegationWorkspaceIdSteps(q, "org-1", "d2"))).toBeNull();
      expect(await db.run((q) => openDelegationWorkspaceIdSteps(q, "org-3", "d1"))).toBeNull();
    } finally {
      await close();
    }
  });

  test("repository, runner and Closeout progress reads", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      const mapping = (workspaceId: string, repository: string, teamId: string) => (q: Q) =>
        q.orm.insert(q.t.workspaceRepository).values({ workspaceId, repository, teamId });
      await seed(
        db,
        mapping("w1", "acme/b", "t1"),
        mapping("w1", "acme/a", "t2"),
        mapping("w2", "acme/b", "t1"),
      );
      expect(await db.run((q) => distinctWorkspaceRepositoriesSteps(q))).toEqual([
        "acme/a",
        "acme/b",
      ]);
      const runner =
        (id: string, name: string, status = "active") =>
        (q: Q) =>
          q.orm
            .insert(q.t.runner)
            .values({ id, workspaceId: "w1", ownerUserId: "ada", name, status, createdAt: 0 });
      await seed(
        db,
        runner("r1", "beta"),
        runner("r2", "alpha"),
        runner("r3", "gamma"),
        runner("r4", "paused", "paused"),
        (q) =>
          q.orm.insert(q.t.runner).values({
            id: "r5",
            workspaceId: "w1",
            ownerUserId: "ada",
            name: "revoked",
            status: "active",
            revokedAt: 1,
            createdAt: 0,
          }),
        (q) =>
          q.orm
            .insert(q.t.workspaceUser)
            .values({ id: "ada", linearUserId: "lin-ada", name: "Ada", email: "a@x" }),
        (q) =>
          q.orm.insert(q.t.runnerAgentPolicy).values({ runnerId: "r1", agent: "codex", ready: 1 }),
        (q) =>
          q.orm
            .insert(q.t.runnerAgentPolicy)
            .values({ runnerId: "r3", agent: "codex", ready: 1, authExpired: 1 }),
      );
      expect(await db.run((q) => runnerNameAndOwnerSteps(q, "r1"))).toEqual({
        name: "beta",
        ownerName: "Ada",
      });
      expect(await db.run((q) => runnerNameAndOwnerSteps(q, "none"))).toBeNull();
      const enabled = await db.run((q) => enabledRunnerIdsSteps(q));
      expect(enabled.map((row) => row.id).sort()).toEqual(["r1", "r2", "r3"]);
      expect(await db.run((q) => runnerAgentReadinessSteps(q, "codex"))).toEqual([
        { name: "alpha", ready: false },
        { name: "beta", ready: true },
        { name: "gamma", ready: false },
      ]);
      expect(await db.run((q) => latestCloseoutProgressMarkerSteps(q, "item"))).toBeNull();
      const progress = (id: string, updatedAt: number) => (q: Q) =>
        q.orm.insert(q.t.closeoutProgress).values({
          id,
          itemId: "item",
          taskId: "task",
          base: "b",
          head: `h-${id}`,
          policyDigest: "p",
          startedAt: 0,
          updatedAt,
        });
      await seed(db, progress("x", 5), progress("y", 9), progress("z", 9));
      expect(await db.run((q) => latestCloseoutProgressMarkerSteps(q, "item"))).toEqual({
        id: "z",
        head: "h-z",
        base: "b",
        policy_digest: "p",
        decision: null,
      });
    } finally {
      await close();
    }
  });

  test("a delegation without a dependency snapshot is picked at its first open item", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await workspaces(db);
      await seed(
        db,
        (q) =>
          q.orm
            .insert(q.t.linearSession)
            .values({ sessionId: "s1", organizationId: "org-1", createdAt: 0 }),
        (q) =>
          q.orm
            .insert(q.t.linearSession)
            .values({ sessionId: "s2", organizationId: "org-2", createdAt: 0, stoppedAt: 1 }),
      );
      await db.run(function* (q) {
        yield* itemSteps(q, "a", "d1", "s1");
        yield* itemSteps(q, "b", "d1", "s1");
        yield* itemSteps(q, "c", "d2", "s2");
        yield* q.exec(
          q.orm.update(q.t.workItem).set({ position: 1 }).where(eq(q.t.workItem.id, "a")),
        );
      });
      expect(await db.run((q) => missingSnapshotTargetsSteps(q))).toEqual([
        { itemId: "b", workspaceId: "w1" },
      ]);
      const snapshot = (itemId: string) => (q: Q) =>
        q.orm.insert(q.t.itemDependencySnapshot).values({
          itemId,
          workspaceId: "w1",
          generation: 1,
          scope: json(db, []),
          linearStates: json(db, {}),
        });
      await seed(db, snapshot("a"), snapshot("b"));
      expect(await db.run((q) => missingSnapshotTargetsSteps(q))).toEqual([]);
    } finally {
      await close();
    }
  });

  test("a finding group action is claimed, released and closed", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await seed(db, (q) =>
        q.orm.insert(q.t.findingGroup).values({
          id: "g",
          workspaceId: "w1",
          repository: "acme/a",
          teamId: "t",
          title: "Group",
          summary: "s",
          scope: "x",
          memberIds: json(db, [1]),
          createdAt: 0,
          runId: "run",
        }),
      );
      expect(await db.run((q) => findingHasGroupActionSteps(q, "w1", 2))).toBe(false);
      expect(await db.run((q) => claimFindingGroupActionSteps(q, "g", "file", [2, 3]))).toBe(1);
      expect(await db.run((q) => findingHasGroupActionSteps(q, "w1", 2))).toBe(true);
      expect(await db.run((q) => findingHasGroupActionSteps(q, "w1", 1))).toBe(false);
      expect(await db.run((q) => findingHasGroupActionSteps(q, "w2", 2))).toBe(false);
      expect(await db.run((q) => claimFindingGroupActionSteps(q, "g", "dismiss", [2]))).toBe(0);
      expect(await db.run((q) => claimFindingGroupActionSteps(q, "g", "file", [2]))).toBe(1);
      await db.run((q) => releaseFindingGroupActionSteps(q, "g", "dismiss"));
      expect(await db.run((q) => findingHasGroupActionSteps(q, "w1", 2))).toBe(true);
      await db.run((q) => releaseFindingGroupActionSteps(q, "g", "file"));
      expect(await db.run((q) => findingHasGroupActionSteps(q, "w1", 2))).toBe(false);
      await db.run((q) =>
        closeFindingGroupSteps(q, {
          id: "g",
          status: "filed",
          reason: null,
          by: "Ada",
          now: 7,
          filedIssue: "PAS-1",
        }),
      );
      const row = await db.run((q) =>
        q.one(
          q.orm
            .select({
              status: q.t.findingGroup.status,
              by: q.t.findingGroup.statusBy,
              at: q.t.findingGroup.statusAt,
              issue: q.t.findingGroup.filedIssue,
            })
            .from(q.t.findingGroup),
        ),
      );
      expect(row).toEqual({ status: "filed", by: "Ada", at: 7, issue: "PAS-1" });
      expect(await db.run((q) => claimFindingGroupActionSteps(q, "g", "file", [2]))).toBe(0);
    } finally {
      await close();
    }
  });

  test("a wake is recorded once per starting wall clock", async () => {
    const { db, close } = await open();
    try {
      const wake = { fromWall: 10, toWall: 20, sleptMs: 10, now: 21 };
      expect(await db.run((q) => recordWakeSteps(q, wake))).toBe(true);
      expect(await db.run((q) => recordWakeSteps(q, { ...wake, toWall: 30 }))).toBe(false);
    } finally {
      await close();
    }
  });
});
