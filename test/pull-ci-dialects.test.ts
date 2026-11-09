import { expect, test } from "bun:test";
import {
  clearPullCiFailuresSteps,
  getPullCiFailureSteps,
  pendingPullCiFailuresSteps,
  recordPullCiFailureSteps,
  settlePullCiFailuresSteps,
  type PullCiFailureRecord,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

const wait = { quietMs: 60, maxMs: 300 };

const failure = (
  head: string,
  observedAt: number,
  name = "test",
): Omit<PullCiFailureRecord, "handledAt" | "outcome"> => ({
  itemId: "a",
  head,
  pullNumber: 7,
  itemVersion: 2,
  failedChecks: [{ name, url: null, logTail: "boom", failsOnBase: false }],
  checks: [
    {
      name,
      state: "failed",
      url: null,
      startedAt: null,
      completedAt: null,
      logTail: "boom",
      logSource: "actions",
    },
  ],
  observedAt,
});

forEachDialect((open) => {
  test("a CI failure per head is recorded, refreshed while open, and dropped by a newer head", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      expect(await db.run((q) => recordPullCiFailureSteps(q, failure("h1", 100), wait))).toEqual({
        observation: "recorded",
        enqueued: true,
      });
      expect(
        await db.run((q) => recordPullCiFailureSteps(q, failure("h1", 110, "lint"), wait)),
      ).toEqual({ observation: "known", enqueued: false });
      expect(await db.run((q) => getPullCiFailureSteps(q, "a", "h1"))).toEqual({
        ...failure("h1", 100, "lint"),
        handledAt: null,
        outcome: null,
      });

      expect(await db.run((q) => recordPullCiFailureSteps(q, failure("h2", 120), wait))).toEqual({
        observation: "recorded",
        enqueued: false,
      });
      expect(await db.run((q) => getPullCiFailureSteps(q, "a", "h1"))).toMatchObject({
        handledAt: 120,
        outcome: "dropped",
      });
      expect((await db.run((q) => pendingPullCiFailuresSteps(q, "a"))).map((f) => f.head)).toEqual([
        "h2",
      ]);
      expect(await db.run((q) => getPullCiFailureSteps(q, "a", "h9"))).toBeNull();

      // A dropped head seen again opens a fresh failure.
      expect(
        (await db.run((q) => recordPullCiFailureSteps(q, failure("h1", 130), wait))).observation,
      ).toBe("recorded");
      expect(await db.run((q) => getPullCiFailureSteps(q, "a", "h1"))).toEqual({
        ...failure("h1", 130),
        handledAt: null,
        outcome: null,
      });
    } finally {
      await close();
    }
  });

  test("settled CI failures stay settled, and clearing a head drops the others", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      await db.run((q) => recordPullCiFailureSteps(q, failure("h1", 100), wait));
      expect(
        await db.run((q) =>
          settlePullCiFailuresSteps(
            q,
            [
              { itemId: "a", head: "h1" },
              { itemId: "a", head: "h9" },
            ],
            "restarted",
            150,
          ),
        ),
      ).toBe(1);
      expect(
        (await db.run((q) => recordPullCiFailureSteps(q, failure("h1", 160), wait))).observation,
      ).toBe("known");
      expect(await db.run((q) => getPullCiFailureSteps(q, "a", "h1"))).toMatchObject({
        observedAt: 100,
        handledAt: 150,
        outcome: "restarted",
      });

      await db.run((q) => recordPullCiFailureSteps(q, failure("h2", 200), wait));
      await db.run((q) => clearPullCiFailuresSteps(q, "a", "h3", 210));
      expect(await db.run((q) => getPullCiFailureSteps(q, "a", "h2"))).toMatchObject({
        handledAt: 210,
        outcome: "dropped",
      });
      await db.run((q) => recordPullCiFailureSteps(q, failure("h3", 220), wait));
      await db.run((q) => clearPullCiFailuresSteps(q, "a", "h3", 230));
      expect(await db.run((q) => getPullCiFailureSteps(q, "a", "h3"))).toMatchObject({
        handledAt: 230,
        outcome: "cleared",
      });
      expect(await db.run((q) => pendingPullCiFailuresSteps(q, "a"))).toEqual([]);
    } finally {
      await close();
    }
  });
});
