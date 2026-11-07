import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import type { GitCommitPolicy } from "../src/core";
import {
  claimRunSteps,
  getItemRunCommitPolicySteps,
  getRunSteps,
  insertRunSteps,
  listRunsSteps,
  listWaitingProfileRunsSteps,
  markRunSteps,
  pinRunCheckoutSteps,
  recordReviewRoundsSteps,
  releaseRunCapacitySteps,
  runOwnerSteps,
  saveRunCommitPolicySteps,
  saveRunResultSteps,
  type Q,
} from "../src/db";
import { forEachDialect, insertWorkItem, withoutForeignKeys } from "./dialects";

const POLICY = { bot: { login: "paws[bot]" }, credit: null } as unknown as GitCommitPolicy;

forEachDialect((open) => {
  test("a run stores its checkpoint and owner, and lists oldest first", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      const later = await db.run((q) =>
        insertRunSteps(q, {
          itemId: "item",
          now: 20,
          checkpoint: { phase: "running", turn: 2 },
          freshSession: true,
          ownerInstance: "a",
        }),
      );
      const earlier = await db.run((q) => insertRunSteps(q, { itemId: "item", now: 10 }));
      expect(later).toMatchObject({
        itemId: "item",
        kind: "implement",
        agent: "cursor",
        status: "active",
        checkpoint: { phase: "running", turn: 2 },
        freshSession: true,
        createdAt: 20,
        updatedAt: 20,
      });
      expect(await db.run((q) => getRunSteps(q, earlier.id))).toEqual(earlier);
      expect(earlier.checkpoint).toBeNull();
      expect(await db.run((q) => getRunSteps(q, "missing"))).toBeNull();
      expect((await db.run((q) => listRunsSteps(q, "item"))).map((run) => run.id)).toEqual([
        earlier.id,
        later.id,
      ]);
      expect(await db.run((q) => listRunsSteps(q, "other"))).toEqual([]);
      expect(await db.run((q) => runOwnerSteps(q, later.id))).toBe("a");
      expect(await db.run((q) => runOwnerSteps(q, earlier.id))).toBeNull();
      await db.run((q) => claimRunSteps(q, later.id, "b"));
      expect(await db.run((q) => runOwnerSteps(q, later.id))).toBe("b");
    } finally {
      await close();
    }
  });

  test("a run records its status, result and review rounds", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      const run = await db.run((q) => insertRunSteps(q, { itemId: "item", now: 1 }));
      await db.run((q) => markRunSteps(q, run.id, "lost", 5));
      await db.run((q) => saveRunResultSteps(q, run.id, "done", 6));
      expect(await db.run((q) => getRunSteps(q, run.id))).toMatchObject({
        status: "lost",
        checkpoint: { phase: "running", resultBody: "done" },
        updatedAt: 6,
      });
      await expect(db.run((q) => saveRunResultSteps(q, "missing", "done", 6))).rejects.toThrow(
        "run missing not found",
      );
      await db.run((q) => recordReviewRoundsSteps(q, run.id, 2));
      await db.run((q) => recordReviewRoundsSteps(q, run.id, 3));
      expect(
        await db.run((q) =>
          q.all(q.orm.select({ rounds: q.t.runReviewRounds.rounds }).from(q.t.runReviewRounds)),
        ),
      ).toEqual([{ rounds: 3 }]);
    } finally {
      await close();
    }
  });

  test("a run pins its commit policy and checkout once", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      const run = await db.run((q) => insertRunSteps(q, { itemId: "item", now: 1 }));
      expect(await db.run((q) => getItemRunCommitPolicySteps(q, "item"))).toBeUndefined();
      await db.run((q) => saveRunCommitPolicySteps(q, run.id, POLICY));
      expect(await db.run((q) => getItemRunCommitPolicySteps(q, "item"))).toEqual(POLICY);
      await expect(
        db.run((q) => saveRunCommitPolicySteps(q, run.id, { ...POLICY, credit: {} } as never)),
      ).rejects.toThrow("Run attribution snapshot cannot change");

      let resolved = 0;
      const resolve = () => ({ agent: [`a${(resolved += 1)}`], checks: [] });
      const pinned = await db.run((q) => pinRunCheckoutSteps(q, run.id, resolve));
      expect(await db.run((q) => pinRunCheckoutSteps(q, run.id, resolve))).toEqual(pinned);
      expect(pinned).toEqual({ agent: ["a1"], checks: [] });
      expect((await db.run((q) => getRunSteps(q, run.id)))!.checkpoint).toEqual({
        phase: "running",
        commitPolicy: POLICY,
        checkout: pinned,
      });
      expect(await db.run((q) => pinRunCheckoutSteps(q, "missing", resolve))).toEqual({
        agent: ["a2"],
        checks: [],
      });
    } finally {
      await close();
    }
  });

  test("releasing a run's capacity ends it, its runner work and its grants", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      await insertWorkItem(db, "item");
      const run = await db.run((q) => insertRunSteps(q, { itemId: "item", now: 1 }));
      await db.run(function* (q) {
        yield* lease(q, run.id, 100);
        yield* q.exec(
          q.orm
            .insert(q.t.runnerWorkGrant)
            .values({ tokenHash: "token", runId: run.id, generation: 1, expiresAt: 100 }),
        );
      });
      await db.run((q) => releaseRunCapacitySteps(q, run.id, 9));
      const after = await db.run(function* (q) {
        const work = yield* q.one(
          q.orm.select().from(q.t.runnerWork).where(eq(q.t.runnerWork.runId, run.id)),
        );
        const grants = yield* q.all(q.orm.select().from(q.t.runnerWorkGrant));
        return { status: (yield* getRunSteps(q, run.id))!.status, endedAt: work!.endedAt, grants };
      });
      expect(after).toEqual({ status: "ended", endedAt: 9, grants: [] });
    } finally {
      await close();
    }
  });

  test("runs wait for a profile update unless queued, finished, stopping or leased", async () => {
    const { db, close } = await open();
    try {
      await withoutForeignKeys(db);
      const runs = await db.run(function* (q) {
        const ids: Record<string, string> = {};
        for (const [item, state, cancelRequested] of [
          ["queued", "queued", 0],
          ["running", "running", 0],
          ["stopping", "running", 1],
          ["leased", "running", 0],
          ["merged", "merged", 0],
        ] as const) {
          yield* q.exec(
            q.orm.insert(q.t.workItem).values({
              id: item,
              delegationId: item,
              linearIssueId: item,
              linearIdentifier: item,
              title: item,
              state,
              branchName: item,
              position: 0,
              createdAt: 0,
              cancelRequested,
            }),
          );
          ids[item] = (yield* insertRunSteps(q, { itemId: item, now: 1 })).id;
        }
        yield* lease(q, ids.leased!, 100);
        return ids;
      });
      expect(
        (await db.run((q) => listWaitingProfileRunsSteps(q, 50))).map((run) => run.id),
      ).toEqual([runs.running!]);
    } finally {
      await close();
    }
  });
});

function* lease(q: Q, runId: string, leaseUntil: number) {
  yield* q.exec(
    q.orm.insert(q.t.runnerWork).values({
      runId,
      runnerId: "runner",
      workspaceId: "acme",
      generation: 1,
      runnerFence: 0,
      commandId: `command-${runId}`,
      leaseUntil,
    }),
  );
}
