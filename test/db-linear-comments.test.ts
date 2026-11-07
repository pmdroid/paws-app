import { expect, test } from "bun:test";
import {
  getLinearCommentSteps,
  linearCommentAuthorSteps,
  markLinearCommentsDeliveredSteps,
  pendingLinearCommentsSteps,
  queueLinearCommentSteps,
  receivedLinearCommentsSteps,
  recordLinearCommentSteps,
  settleLinearCommentsSteps,
  type Db,
  type LinearCommentReceipt,
} from "../src/db";
import { forEachDialect } from "./dialects";

function receipt(commentId: string, overrides: Partial<LinearCommentReceipt> = {}) {
  return {
    commentId,
    issueId: "issue",
    organizationId: "org",
    teamId: null,
    authorId: `author-${commentId}`,
    actorId: null,
    actorType: null,
    botActor: null,
    onBehalfOf: null,
    parentId: null,
    body: `body ${commentId}`,
    createdAtMs: 10,
    updatedAtMs: 10,
    removed: false,
    source: "webhook",
    ...overrides,
  } satisfies LinearCommentReceipt;
}

const route = { itemId: "item", sessionId: "session", generation: 2, authority: "person" } as const;

forEachDialect((open) => {
  async function withDb(body: (db: Db) => Promise<void>) {
    const opened = await open();
    try {
      await body(opened.db);
    } finally {
      await opened.close();
    }
  }

  const record = (db: Db, comment: LinearCommentReceipt, now: number) =>
    db.transaction((q) => recordLinearCommentSteps(q, comment, now));

  test("a comment is inserted, edited while open and removed once", () =>
    withDb(async (db) => {
      expect(await db.run((q) => getLinearCommentSteps(q, "a"))).toBeNull();
      const inserted = await record(db, receipt("a"), 100);
      expect(inserted.change).toBe("inserted");
      expect(inserted.record).toMatchObject({
        commentId: "a",
        receivedAt: 100,
        edited: false,
        removedAt: null,
        state: "received",
        reason: null,
        itemId: null,
        generation: null,
      });
      expect((await record(db, receipt("a"), 101)).change).toBe("unchanged");
      const edited = await record(db, receipt("a", { body: "new", updatedAtMs: 20 }), 102);
      expect(edited).toMatchObject({ change: "updated", record: { body: "new", edited: true } });
      const removed = await record(db, receipt("a", { removed: true }), 103);
      expect(removed).toMatchObject({
        change: "removed",
        record: { removedAt: 103, state: "removed", reason: "deleted", settledAt: 103 },
      });
      expect((await record(db, receipt("a", { removed: true }), 104)).change).toBe("unchanged");
      expect(await db.run((q) => linearCommentAuthorSteps(q, "a"))).toBe("author-a");
      expect(await db.run((q) => linearCommentAuthorSteps(q, "missing"))).toBeNull();
    }));

  test("a settled comment keeps its body and state when edited or removed", () =>
    withDb(async (db) => {
      await record(db, receipt("a"), 100);
      await db.transaction((q) =>
        settleLinearCommentsSteps(q, ["a"], { state: "ignored", reason: "bot", now: 110 }),
      );
      const edited = await record(db, receipt("a", { body: "new", updatedAtMs: 20 }), 120);
      expect(edited).toMatchObject({
        change: "unchanged",
        record: { body: "body a", edited: true, updatedAtMs: 20, state: "ignored" },
      });
      const removed = await record(db, receipt("a", { removed: true }), 130);
      expect(removed.record).toMatchObject({ removedAt: 130, state: "ignored", reason: "bot" });
    }));

  test("comments are queued for an item, delivered and settled", () =>
    withDb(async (db) => {
      await record(db, receipt("b", { createdAtMs: 20 }), 100);
      await record(db, receipt("a", { createdAtMs: 20 }), 100);
      await record(db, receipt("c", { createdAtMs: 5 }), 100);
      expect(
        (await db.run(receivedLinearCommentsSteps)).map((comment) => comment.commentId),
      ).toEqual(["c", "a", "b"]);
      expect(await db.run((q) => queueLinearCommentSteps(q, "a", route))).toBe(true);
      expect(await db.run((q) => queueLinearCommentSteps(q, "a", route))).toBe(false);
      expect(await db.run((q) => queueLinearCommentSteps(q, "b", route))).toBe(true);
      expect(await db.run((q) => pendingLinearCommentsSteps(q, "item"))).toMatchObject([
        { commentId: "a", state: "queued", generation: 2, authority: "person", reason: null },
        { commentId: "b", state: "queued" },
      ]);
      await db.transaction((q) =>
        markLinearCommentsDeliveredSteps(q, ["a", "c"], { via: "answer", itemVersion: 3, now: 9 }),
      );
      await db.transaction((q) =>
        settleLinearCommentsSteps(q, ["b"], { state: "rejected", now: 9 }),
      );
      expect(await db.run((q) => getLinearCommentSteps(q, "a"))).toMatchObject({
        state: "answered",
        via: "answer",
        itemVersion: 3,
        settledAt: 9,
      });
      expect(await db.run((q) => getLinearCommentSteps(q, "b"))).toMatchObject({
        state: "rejected",
        reason: null,
      });
      expect((await db.run((q) => getLinearCommentSteps(q, "c")))?.state).toBe("received");
      expect(await db.run((q) => pendingLinearCommentsSteps(q, "item"))).toEqual([]);
    }));
});
