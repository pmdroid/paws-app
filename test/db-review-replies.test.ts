import { expect, test } from "bun:test";
import {
  markReviewReplyPostedSteps,
  recordReviewRepliesSteps,
  reportReviewRepliesSteps,
  unpostedReviewRepliesSteps,
  unreportedReviewRepliesSteps,
  type Db,
  type NewReviewReply,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

const reply = (number: number): NewReviewReply => ({
  number,
  pullNumber: 7,
  target: "thread",
  commentId: 100 + number,
  threadId: `t${number}`,
  author: "octo",
  excerpt: `comment ${number}`,
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

  test("handed-off comments are superseded while unreported, reported and posted", () =>
    withDb(async (db) => {
      const handoff = (restartKey: string, numbers: number[], now: number) =>
        db.run((q) =>
          recordReviewRepliesSteps(q, {
            itemId: "A",
            restartKey,
            replies: numbers.map(reply),
            now,
          }),
        );
      await handoff("r1", [1], 10);
      await handoff("r2", [2, 1], 20);
      const unreported = await db.run((q) => unreportedReviewRepliesSteps(q, "A"));
      expect(unreported.map((r) => [r.restartKey, r.number])).toEqual([
        ["r2", 1],
        ["r2", 2],
      ]);
      expect(unreported[0]).toMatchObject({ commentId: 101, outcome: null, recordedAt: 20 });

      const reports = new Map([[2, { outcome: "fixed" as const, reply: "Fixed." }]]);
      expect(await db.run((q) => reportReviewRepliesSteps(q, "A", reports, 30))).toBe(2);
      expect(await db.run((q) => reportReviewRepliesSteps(q, "A", reports, 31))).toBe(0);
      const unposted = await db.run((q) => unpostedReviewRepliesSteps(q, "A", 7));
      expect(unposted.map((r) => [r.number, r.outcome, r.reply])).toEqual([
        [1, "unreported", null],
        [2, "fixed", "Fixed."],
      ]);
      await db.run((q) => markReviewReplyPostedSteps(q, unposted[1]!.id, 40, true));
      await db.run((q) => markReviewReplyPostedSteps(q, unposted[1]!.id, 50, false));
      expect(await db.run((q) => unpostedReviewRepliesSteps(q, "A", 7))).toMatchObject([
        { number: 1 },
      ]);
      expect(await db.run((q) => unpostedReviewRepliesSteps(q, "A", 8))).toEqual([]);
    }));
});
