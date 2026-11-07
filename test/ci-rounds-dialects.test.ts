import { expect, test } from "bun:test";
import {
  countCiFixesSteps,
  enqueueJobSteps,
  listCiRoundsSteps,
  recordCiRoundSteps,
  type CiRound,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

const round = (itemId: string, head: string, recordedAt: number, fix: number | null): CiRound => ({
  itemId,
  head,
  runId: null,
  next: fix === null ? "failed" : "agent",
  fix,
  fixLimit: 3,
  checks: [
    {
      name: "test",
      state: "failed",
      url: null,
      startedAt: null,
      completedAt: null,
      logTail: "boom",
      logSource: "actions",
    },
  ],
  recordedAt,
});

forEachDialect((open) => {
  test("a CI round per head replaces on a second read, lists oldest first and counts fixes", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      await insertWorkItem(db, "b");
      await db.run((q) => recordCiRoundSteps(q, round("a", "h1", 10, 1)));
      await db.run((q) => recordCiRoundSteps(q, round("b", "h1", 5, null)));
      await db.run((q) => recordCiRoundSteps(q, round("a", "h2", 20, 1)));
      await db.run((q) => recordCiRoundSteps(q, round("a", "h2", 30, 2)));

      expect(await db.run((q) => listCiRoundsSteps(q, "a"))).toEqual([
        round("a", "h1", 10, 1),
        round("a", "h2", 30, 2),
      ]);
      expect((await db.run((q) => listCiRoundsSteps(q))).map((r) => [r.itemId, r.head])).toEqual([
        ["b", "h1"],
        ["a", "h1"],
        ["a", "h2"],
      ]);

      expect(await db.run((q) => countCiFixesSteps(q, "a", 999))).toBe(2);
      const job = await db.run((q) => enqueueJobSteps(q, { queue: "start", now: 25 }));
      expect(await db.run((q) => countCiFixesSteps(q, "a", job))).toBe(2);
      const later = await db.run((q) => enqueueJobSteps(q, { queue: "start", now: 40 }));
      expect(await db.run((q) => countCiFixesSteps(q, "a", later))).toBe(0);
      expect(await db.run((q) => countCiFixesSteps(q, "b", job))).toBe(0);
    } finally {
      await close();
    }
  });
});
