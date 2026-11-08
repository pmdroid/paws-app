import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  getPullReviewSteps,
  pendingChangeRequestsSteps,
  pullReviewJobKey,
  recordPullCommentSteps,
  recordPullReviewSteps,
  settlePullReviewSteps,
  wakePullReviewsSteps,
  type Db,
  type PullReviewRecord,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

const wait = { quietMs: 60, maxMs: 300 };

const review = (
  reviewId: number,
  receivedAt: number,
  state: PullReviewRecord["state"] = "changes_requested",
): Omit<PullReviewRecord, "handledAt" | "outcome"> => ({
  reviewId,
  itemId: "a",
  state,
  pullNumber: 7,
  head: "h1",
  reviewer: "bob",
  body: `review ${reviewId}`,
  receivedAt,
});

const runAt = async (db: Db, reviewId: number) =>
  (
    await db.run((q) =>
      q.one(
        q.orm
          .select({ runAt: q.t.job.runAt })
          .from(q.t.job)
          .where(eq(q.t.job.jobKey, pullReviewJobKey(reviewId))),
      ),
    )
  )?.runAt;

forEachDialect((open) => {
  test("a review is recorded once with its job, listed while open and settled once", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      expect(await db.run((q) => recordPullReviewSteps(q, review(1, 100), wait))).toEqual({
        recorded: true,
        enqueued: true,
      });
      expect(await db.run((q) => recordPullReviewSteps(q, review(1, 100), wait))).toEqual({
        recorded: false,
        enqueued: false,
      });
      await db.run((q) => recordPullReviewSteps(q, review(2, 110, "commented"), wait));
      await db.run((q) => recordPullReviewSteps(q, review(3, 120), wait));
      expect(await runAt(db, 1)).toBe(180);

      expect(await db.run((q) => getPullReviewSteps(q, 1))).toEqual({
        ...review(1, 100),
        handledAt: null,
        outcome: null,
      });
      expect(await db.run((q) => getPullReviewSteps(q, 9))).toBeNull();
      expect(
        (await db.run((q) => pendingChangeRequestsSteps(q, "a"))).map((r) => r.reviewId),
      ).toEqual([1, 3]);
      expect(await db.run((q) => settlePullReviewSteps(q, 3, "restarted", 200))).toBe(true);
      expect(await db.run((q) => settlePullReviewSteps(q, 3, "asked", 300))).toBe(false);
      expect(await db.run((q) => getPullReviewSteps(q, 3))).toMatchObject({
        handledAt: 200,
        outcome: "restarted",
      });
      expect(
        (await db.run((q) => pendingChangeRequestsSteps(q, "a"))).map((r) => r.reviewId),
      ).toEqual([1]);
    } finally {
      await close();
    }
  });

  test("waking reviews runs their jobs a quiet time after the latest open feedback", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      await db.run((q) => recordPullReviewSteps(q, review(1, 100), wait));
      await db.run((q) => recordPullReviewSteps(q, review(2, 100), wait));
      await db.run((q) => settlePullReviewSteps(q, 2, "dropped", 100));
      expect(await runAt(db, 1)).toBe(160);

      const quick = { quietMs: 10, maxMs: 300 };
      await db.run((q) => wakePullReviewsSteps(q, "a", 130, quick));
      expect(await runAt(db, 1)).toBe(130);
      expect(await runAt(db, 2)).toBe(160);

      await db.run((q) =>
        recordPullCommentSteps(
          q,
          {
            source: "conversation",
            commentId: 5,
            itemId: "a",
            pullNumber: 7,
            reviewId: null,
            author: "alice",
            body: "also",
            path: null,
            line: null,
            receivedAt: 200,
          },
          wait,
        ),
      );
      expect(await runAt(db, 1)).toBe(260);
      await db.run((q) => wakePullReviewsSteps(q, "a", 205, quick));
      expect(await runAt(db, 1)).toBe(210);
    } finally {
      await close();
    }
  });
});
