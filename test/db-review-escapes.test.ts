import { expect, test } from "bun:test";
import {
  listReviewEscapesSteps,
  openReviewEscapesSteps,
  recordReviewEscapeSteps,
  settleReviewEscapeSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

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

  const candidate = (triggerKey: string, recordedAt: number) => ({
    triggerKey,
    itemId: "A",
    trigger: "comment" as const,
    acceptedHead: "h1",
    pullNumber: 7,
    detail: { comments: [{ id: 1, author: null, body: "x".repeat(600) }] },
    recordedAt,
  });

  test("a candidate is recorded once, listed while open and settled once", () =>
    withDb(async (db) => {
      expect(await db.run((q) => recordReviewEscapeSteps(q, candidate("k1", 10)))).toBe(true);
      expect(await db.run((q) => recordReviewEscapeSteps(q, candidate("k1", 11)))).toBe(false);
      expect(
        await db.run((q) =>
          recordReviewEscapeSteps(q, { ...candidate("k2", 20), pullNumber: null }),
        ),
      ).toBe(true);
      const [first, second] = await db.run((q) => openReviewEscapesSteps(q, "A"));
      expect(first).toMatchObject({
        triggerKey: "k1",
        trigger: "comment",
        pullNumber: 7,
        recordedAt: 10,
        fixHead: null,
        files: null,
        escape: null,
        notEscapeReason: null,
        settledAt: null,
      });
      expect(first!.detail.comments![0]!.body).toHaveLength(500);
      expect(second!.pullNumber).toBeNull();

      const settlement = {
        fixHead: "h2",
        files: ["src/a.ts"],
        escape: false,
        notEscapeReason: "no_change" as const,
        now: 30,
      };
      expect(await db.run((q) => settleReviewEscapeSteps(q, first!.id, settlement))).toBe(true);
      expect(await db.run((q) => settleReviewEscapeSteps(q, first!.id, settlement))).toBe(false);
      expect(
        await db.run((q) =>
          settleReviewEscapeSteps(q, second!.id, { ...settlement, escape: true, files: [] }),
        ),
      ).toBe(true);
      expect(await db.run((q) => openReviewEscapesSteps(q, "A"))).toEqual([]);
      expect(await db.run((q) => listReviewEscapesSteps(q))).toMatchObject([
        { triggerKey: "k1", files: ["src/a.ts"], escape: false, notEscapeReason: "no_change" },
        { triggerKey: "k2", files: [], escape: true, notEscapeReason: null, settledAt: 30 },
      ]);
      expect((await db.run((q) => listReviewEscapesSteps(q, 15))).map((e) => e.triggerKey)).toEqual(
        ["k2"],
      );
    }));
});
