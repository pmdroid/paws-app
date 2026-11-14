import { expect, test } from "bun:test";
import { listCiRoundsSteps, recordCiRoundSteps, type CiRound } from "../src/db";
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
  test("a CI round per head replaces on a second read and lists oldest first", async () => {
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
    } finally {
      await close();
    }
  });
});
