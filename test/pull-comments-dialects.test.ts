import { expect, test } from "bun:test";
import { asc } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import {
  commentingAppsSteps,
  deferPullFeedbackSteps,
  enqueueJobSteps,
  gatherPullFeedbackSteps,
  getPullCommentSteps,
  pendingPullCommentsSteps,
  pullReviewCheckWaitSteps,
  recordPullCommentSteps,
  settlePullCommentsSteps,
  type Db,
  type PullCommentRecord,
} from "../src/db";
import { forEachDialect, insertWorkItem, seed } from "./dialects";

const wait = { quietMs: 60, maxMs: 300 };

const comment = (
  commentId: number,
  receivedAt: number,
  author: string | null = "alice",
): Omit<PullCommentRecord, "handledAt" | "outcome"> => ({
  source: "inline",
  commentId,
  itemId: "a",
  pullNumber: 7,
  reviewId: null,
  author,
  body: `comment ${commentId}`,
  path: "src/a.ts",
  line: 3,
  receivedAt,
});

const jobs = (db: Db) =>
  db.run((q) =>
    q.all(
      q.orm
        .select({ queue: q.t.job.queue, jobKey: q.t.job.jobKey, runAt: q.t.job.runAt })
        .from(q.t.job)
        .orderBy(asc(q.t.job.id)),
    ),
  );

forEachDialect((open) => {
  test("a comment is recorded once, gathers one job and defers it a quiet time after the latest", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      expect(await db.run((q) => recordPullCommentSteps(q, comment(1, 100), wait))).toEqual({
        recorded: true,
        enqueued: true,
      });
      expect(await db.run((q) => recordPullCommentSteps(q, comment(1, 100), wait))).toEqual({
        recorded: false,
        enqueued: false,
      });
      expect(await db.run((q) => recordPullCommentSteps(q, comment(2, 150), wait))).toEqual({
        recorded: true,
        enqueued: false,
      });
      expect(await jobs(db)).toEqual([
        { queue: JOB_KIND.pullComments, jobKey: "pull-comments:a:inline:1", runAt: 210 },
      ]);
      // Never past `maxMs` after the job was created.
      expect(await db.run((q) => deferPullFeedbackSteps(q, "a", 1000, wait))).toBe(1);
      expect((await jobs(db))[0]?.runAt).toBe(400);
      expect(await db.run((q) => deferPullFeedbackSteps(q, "b", 1000, wait))).toBe(0);
      expect(
        await db.run((q) => gatherPullFeedbackSteps(q, "a", 1000, wait, "pull-comments:a:x")),
      ).toBe(false);

      expect(await db.run((q) => getPullCommentSteps(q, "inline", 2))).toEqual({
        ...comment(2, 150),
        handledAt: null,
        outcome: null,
      });
      expect(await db.run((q) => getPullCommentSteps(q, "review", 2))).toBeNull();
      expect(
        (await db.run((q) => pendingPullCommentsSteps(q, "a"))).map((c) => c.commentId),
      ).toEqual([1, 2]);
      expect(
        await db.run((q) =>
          settlePullCommentsSteps(
            q,
            [
              { source: "inline", commentId: 1 },
              { source: "review", commentId: 9 },
            ],
            "restarted",
            500,
          ),
        ),
      ).toBe(1);
      expect(
        (await db.run((q) => pendingPullCommentsSteps(q, "a"))).map((c) => c.commentId),
      ).toEqual([2]);
      expect(await db.run((q) => getPullCommentSteps(q, "inline", 1))).toMatchObject({
        handledAt: 500,
        outcome: "restarted",
      });
    } finally {
      await close();
    }
  });

  test("commenting apps are the bot authors on the repository's pull requests", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      await seed(db, (q) =>
        q.orm.insert(q.t.workItemRepository).values({
          itemId: "a",
          owner: "Acme",
          repo: "App",
          remoteUrl: "https://github.com/acme/app",
        }),
      );
      for (const [id, author] of [
        [1, "Reviewer[bot]"],
        [2, "reviewer[bot]"],
        [3, "alice"],
        [4, "linter[bot]"],
      ] as const)
        await db.run((q) => recordPullCommentSteps(q, comment(id, 100, author), wait));
      expect((await db.run((q) => commentingAppsSteps(q, "acme", "app"))).sort()).toEqual([
        "linter",
        "reviewer",
      ]);
      expect(await db.run((q) => commentingAppsSteps(q, "acme", "other"))).toEqual([]);
    } finally {
      await close();
    }
  });

  test("the review check wait is read from the item's latest feedback job", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      expect(await db.run((q) => pullReviewCheckWaitSteps(q, "a"))).toBeNull();
      await db.run((q) =>
        enqueueJobSteps(q, {
          queue: JOB_KIND.pullComments,
          payload: { pullCommentsFor: "a", reviewChecks: { head: "h1", names: ["lint"] } },
          now: 1,
        }),
      );
      await db.run((q) =>
        enqueueJobSteps(q, {
          queue: JOB_KIND.pullComments,
          payload: { pullCommentsFor: "a", reviewChecks: { head: "h2", names: ["test", 3] } },
          now: 2,
        }),
      );
      await db.run((q) =>
        enqueueJobSteps(q, {
          queue: JOB_KIND.pullComments,
          payload: { pullCommentsFor: "b", reviewChecks: { head: "h3", names: [] } },
          now: 3,
        }),
      );
      expect(await db.run((q) => pullReviewCheckWaitSteps(q, "a"))).toEqual({
        head: "h2",
        names: ["test"],
      });
    } finally {
      await close();
    }
  });
});
