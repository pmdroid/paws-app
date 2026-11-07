import { expect, test } from "bun:test";
import {
  decideSuggestedFindingsSteps,
  getSuggestionTurnSteps,
  recordSuggestedFindingsSteps,
  recordSuggestionTurnSteps,
  suggestedFindingsSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

const handed = (findingId: string) => ({
  findingId,
  reviewId: "review",
  location: "src/a.ts:1",
  severity: "P2",
  explanation: `explain ${findingId}`,
});

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened = await open();
    try {
      await insertWorkItem(opened.db, "A");
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  test("handed findings are decided once and undecided ones replaced", () =>
    withDb(async (db) => {
      await db.run((q) => recordSuggestedFindingsSteps(q, "A", [handed("f2"), handed("f1")], 10));
      const decisions = new Map([["f1", { decision: "fixed" as const, reason: "done" }]]);
      expect(await db.run((q) => decideSuggestedFindingsSteps(q, "A", decisions, "h1", 11))).toBe(
        1,
      );
      expect(await db.run((q) => decideSuggestedFindingsSteps(q, "A", decisions, "h1", 12))).toBe(
        0,
      );
      await db.run((q) => recordSuggestedFindingsSteps(q, "A", [handed("f1"), handed("f3")], 20));
      expect(await db.run((q) => suggestedFindingsSteps(q, "A"))).toEqual([
        {
          ...handed("f1"),
          itemId: "A",
          handedAt: 10,
          decision: "fixed",
          reason: "done",
          head: "h1",
          decidedAt: 11,
        },
        {
          ...handed("f3"),
          itemId: "A",
          handedAt: 20,
          decision: null,
          reason: null,
          head: null,
          decidedAt: null,
        },
      ]);
    }));

  test("an item's suggestion turn is recorded once", () =>
    withDb(async (db) => {
      expect(await db.run((q) => getSuggestionTurnSteps(q, "A"))).toBeNull();
      const turn = {
        itemId: "A",
        outcome: "skipped" as const,
        reason: "none",
        head: "h",
        recordedAt: 1,
      };
      expect(await db.run((q) => recordSuggestionTurnSteps(q, turn))).toBe(true);
      expect(
        await db.run((q) => recordSuggestionTurnSteps(q, { ...turn, outcome: "started" })),
      ).toBe(false);
      expect(await db.run((q) => getSuggestionTurnSteps(q, "A"))).toEqual(turn);
    }));
});
