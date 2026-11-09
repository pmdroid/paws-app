import { expect, test } from "bun:test";
import {
  acceptLinearStopSteps,
  advanceLinearSessionGenerationSteps,
  announceLinearTurnSteps,
  enqueueIssueStatusSteps,
  gatherLinearCommentsSteps,
  getLinearSessionSteps,
  listOutboxSteps,
  recordLinearTurnSteps,
  requireLinearTaskDelegationSteps,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

forEachDialect((open) => {
  test("generation fencing, turn acknowledgment and Stop receipts compose atomically", async () => {
    const { db, close } = await open();
    try {
      expect(
        await db.transaction((q) => advanceLinearSessionGenerationSteps(q, "s", { now: 1 })),
      ).toBe(1);
      await db.transaction((q) =>
        recordLinearTurnSteps(q, {
          sessionId: "s",
          eventKey: "turn",
          activityId: null,
          actorId: null,
          body: "update",
          payload: "{}",
          createdAtMs: 2,
          now: 2,
        }),
      );
      expect(await db.transaction((q) => announceLinearTurnSteps(q, "s", "turn", 3))).toBe(true);
      expect(await db.transaction((q) => announceLinearTurnSteps(q, "s", "turn", 3))).toBe(false);
      expect(await db.run((q) => listOutboxSteps(q, "s"))).toHaveLength(1);
      expect(await db.transaction((q) => acceptLinearStopSteps(q, "s", "stop", 4))).toBe(3);
      expect(await db.transaction((q) => acceptLinearStopSteps(q, "s", "stop", 5))).toBeNull();
      expect(await db.transaction((q) => acceptLinearStopSteps(q, "s", "stop-again", 5))).toBe(3);
      await expect(
        db.transaction(function* (q) {
          yield* advanceLinearSessionGenerationSteps(q, "s", { now: 6 });
          throw new Error("rollback");
        }),
      ).rejects.toThrow("rollback");
      expect((await db.run((q) => getLinearSessionSteps(q, "s")))?.generation).toBe(3);
      await db.transaction((q) =>
        recordLinearTurnSteps(q, {
          sessionId: "s",
          eventKey: "old",
          activityId: null,
          actorId: null,
          body: "old",
          payload: "{}",
          createdAtMs: 1,
          now: 7,
        }),
      );
      expect(await db.transaction((q) => announceLinearTurnSteps(q, "s", "old", 7))).toBe(false);
    } finally {
      await close();
    }
  });

  test("issue status respects delegation ownership and deduplicates", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      const item = { id: "item", linearIssueId: "issue-item", sessionKey: null, version: 0 };
      await db.transaction((q) =>
        requireLinearTaskDelegationSteps(q, {
          itemId: "item",
          issueId: "issue-item",
          teamId: "team",
          appUserId: "app",
        }),
      );
      await db.transaction((q) => enqueueIssueStatusSteps(q, item, "completed", 1));
      expect(await db.run((q) => listOutboxSteps(q))).toHaveLength(0);
      await db.transaction((q) =>
        requireLinearTaskDelegationSteps(q, {
          itemId: "item",
          issueId: "issue-item",
          teamId: "team",
          appUserId: "app",
          humanActorId: "person",
        }),
      );
      for (let i = 0; i < 2; i++)
        await db.transaction((q) => enqueueIssueStatusSteps(q, item, "completed", 2));
      expect(await db.run((q) => listOutboxSteps(q))).toHaveLength(1);
    } finally {
      await close();
    }
  });

  test("comment gathering extends the quiet window only up to its cap", async () => {
    const { db, close } = await open();
    try {
      const gather = (now: number) =>
        db.transaction((q) =>
          gatherLinearCommentsSteps(q, "item", now, { quietMs: 10, maxMs: 25 }, "gather"),
        );
      expect(await gather(0)).toBe(true);
      expect(await gather(20)).toBe(false);
      const jobs = await db.run(function* (q) {
        return yield* q.all(q.orm.select().from(q.t.job));
      });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.runAt).toBe(25);
    } finally {
      await close();
    }
  });
});
