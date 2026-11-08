import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  acceptedVisualReviewRowsSteps,
  amendQuestionRowSteps,
  askedQuestionRowSteps,
  cancelQueuedQuestionsSteps,
  dropQuestionElicitationsSteps,
  humanApprovedVisualReviewRowsSteps,
  insertQuestionRowSteps,
  insertVisualReviewRowSteps,
  lastVisualReviewFeedbackRowSteps,
  markQuestionAnsweredSteps,
  nextQueuedQuestionRowSteps,
  openQuestionRowSteps,
  promoteQuestionRowSteps,
  questionEventConsumedSteps,
  questionRowSteps,
  rejectedVisualReviewRowsSteps,
  saveVisualReviewAnswerSteps,
  setQuestionCancelledSteps,
  staleAcceptedVisualReviewSteps,
  visualReviewRoundCountsSteps,
  visualReviewRowSteps,
  waitingItemQuestionsSteps,
  type Db,
  type NewQuestionRow,
  type NewVisualReviewRow,
} from "../src/db";
import { forEachDialect, jsonValue, withoutForeignKeys, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

async function connected(connect: () => Promise<DialectDb>) {
  const handle = await connect();
  open.push(handle);
  await withoutForeignKeys(handle.db);
  return handle.db;
}

function question(db: Db, id: string, input: Partial<NewQuestionRow> = {}) {
  return db.run((q) =>
    insertQuestionRowSteps(q, {
      id,
      itemId: "item",
      runId: "run",
      sessionId: "session",
      kind: "agent",
      reason: "agent",
      body: `body ${id}`,
      context: null,
      options: null,
      status: "open",
      createdAt: 1,
      ...input,
    }),
  );
}

function review(db: Db, questionId: string, input: Partial<NewVisualReviewRow> = {}) {
  return db.run((q) =>
    insertVisualReviewRowSteps(q, {
      questionId,
      itemId: "item",
      checkId: "check",
      evidenceIds: [`${questionId}-file`],
      createdAt: 1,
      headCommit: "head",
      ...input,
    }),
  );
}

function answerReview(db: Db, questionId: string, outcome: string, answeredAt: number) {
  return db.run((q) =>
    saveVisualReviewAnswerSteps(q, questionId, {
      outcome,
      answeredBy: "reviewer",
      answeredAt,
      feedback: `feedback ${questionId}`,
      headCommit: "answered-head",
    }),
  );
}

forEachDialect((connect) => {
  describe("questions", () => {
    test("a question stores no options as NULL and reads its options back as JSON text", async () => {
      const db = await connected(connect);
      await question(db, "plain");
      await question(db, "choice", {
        sessionId: "other",
        options: [{ label: "Yes" }],
        context: "why",
      });

      const plain = await db.run((q) => questionRowSteps(q, "plain"));
      expect(plain).toMatchObject({
        id: "plain",
        itemId: "item",
        options: null,
        context: null,
        status: "open",
      });
      const choice = await db.run((q) => questionRowSteps(q, "choice"));
      expect(JSON.parse(choice!.options!)).toEqual([{ label: "Yes" }]);
      expect(choice!.context).toBe("why");
      expect(await db.run((q) => questionRowSteps(q, "missing"))).toBeNull();
    });

    test("an amended question has the new context and options", async () => {
      const db = await connected(connect);
      await question(db, "asked");
      await db.run((q) =>
        amendQuestionRowSteps(q, "asked", { context: "more", options: [{ label: "Go" }] }),
      );

      const row = await db.run((q) => questionRowSteps(q, "asked"));
      expect(row!.context).toBe("more");
      expect(JSON.parse(row!.options!)).toEqual([{ label: "Go" }]);
    });

    test("the open question is the newest one that was not cancelled", async () => {
      const db = await connected(connect);
      await question(db, "gone", { createdAt: 3 });
      await db.run((q) => setQuestionCancelledSteps(q, "gone", 4));
      await question(db, "older", { status: "open", createdAt: 1 });
      await question(db, "queued", { status: "queued", createdAt: 2 });

      expect((await db.run((q) => openQuestionRowSteps(q, "session")))?.id).toBe("older");
      expect(await db.run((q) => openQuestionRowSteps(q, "nobody"))).toBeNull();
    });

    test("the asked question matches its run and kind, open or queued", async () => {
      const db = await connected(connect);
      await question(db, "first", { kind: "ci-help", status: "queued", createdAt: 1 });
      await question(db, "second", { kind: "ci-help", status: "queued", createdAt: 2 });
      await question(db, "other-kind", { kind: "agent", status: "queued", createdAt: 3 });

      expect((await db.run((q) => askedQuestionRowSteps(q, "run", "ci-help")))?.id).toBe("second");
      expect(await db.run((q) => askedQuestionRowSteps(q, "run", "time-limit"))).toBeNull();
    });

    test("the next queued question is the oldest one", async () => {
      const db = await connected(connect);
      await question(db, "later", { status: "queued", createdAt: 5 });
      await question(db, "sooner", { status: "queued", createdAt: 2 });
      await question(db, "cancelled", { status: "queued", createdAt: 1 });
      await db.run((q) => setQuestionCancelledSteps(q, "cancelled", 9));

      expect((await db.run((q) => nextQueuedQuestionRowSteps(q, "session")))?.id).toBe("sooner");
    });

    test("answering writes the answer once and marks the delivery consumed", async () => {
      const db = await connected(connect);
      await question(db, "asked");
      const answer = {
        answer: "yes",
        answeredBy: "ann",
        answeredAt: 7,
        answerEventKey: "delivery",
      };

      expect(await db.run((q) => markQuestionAnsweredSteps(q, "asked", answer))).toBe(true);
      expect(await db.run((q) => markQuestionAnsweredSteps(q, "asked", answer))).toBe(false);
      expect(await db.run((q) => questionRowSteps(q, "asked"))).toMatchObject({
        status: "answered",
        answer: "yes",
        answeredBy: "ann",
        answeredAt: 7,
      });
      expect(await db.run((q) => questionEventConsumedSteps(q, "session", "delivery"))).toBe(true);
      expect(await db.run((q) => questionEventConsumedSteps(q, "session", "other"))).toBe(false);
    });

    test("a cancelled question cannot be answered", async () => {
      const db = await connected(connect);
      await question(db, "asked");
      await db.run((q) => setQuestionCancelledSteps(q, "asked", 2));

      expect(
        await db.run((q) =>
          markQuestionAnsweredSteps(q, "asked", {
            answer: "yes",
            answeredBy: "ann",
            answeredAt: 7,
            answerEventKey: null,
          }),
        ),
      ).toBe(false);
    });

    test("cancelling queued questions covers one kind on one item or session", async () => {
      const db = await connected(connect);
      await question(db, "item-kind", {
        kind: "ci-help",
        status: "queued",
        itemId: "a",
        sessionId: "s1",
      });
      await question(db, "other-kind", {
        kind: "agent",
        status: "queued",
        itemId: "a",
        sessionId: "s1",
      });
      await question(db, "session-kind", {
        kind: "runner-wait",
        status: "queued",
        itemId: "b",
        sessionId: "s2",
      });
      await question(db, "open-kind", {
        kind: "ci-help",
        status: "open",
        itemId: "a",
        sessionId: "s3",
      });

      await db.run((q) => cancelQueuedQuestionsSteps(q, { itemId: "a" }, "ci-help", 9));
      await db.run((q) => cancelQueuedQuestionsSteps(q, { sessionId: "s2" }, "runner-wait", 10));

      const cancelledAt = async (id: string) =>
        (await db.run((q) => questionRowSteps(q, id)))!.cancelledAt;
      expect(await cancelledAt("item-kind")).toBe(9);
      expect(await cancelledAt("session-kind")).toBe(10);
      expect(await cancelledAt("other-kind")).toBeNull();
      expect(await cancelledAt("open-kind")).toBeNull();
    });

    test("promoting a queued question opens it at the new time", async () => {
      const db = await connected(connect);
      await question(db, "queued", { status: "queued", createdAt: 1 });
      await db.run((q) => promoteQuestionRowSteps(q, "queued", 8));

      expect(await db.run((q) => questionRowSteps(q, "queued"))).toMatchObject({
        status: "open",
        createdAt: 8,
      });
    });

    test("an item waits on its open and queued questions only", async () => {
      const db = await connected(connect);
      await question(db, "open", { sessionId: "s1" });
      await question(db, "queued", { status: "queued", kind: "link", sessionId: "s2" });
      await question(db, "cancelled", { sessionId: "s3" });
      await db.run((q) => setQuestionCancelledSteps(q, "cancelled", 2));
      await question(db, "elsewhere", { itemId: "other", sessionId: "s4" });

      const waiting = await db.run((q) => waitingItemQuestionsSteps(q, "item"));
      expect(waiting.toSorted((a, b) => a.id.localeCompare(b.id))).toEqual([
        { id: "open", kind: "agent", sessionId: "s1" },
        { id: "queued", kind: "link", sessionId: "s2" },
      ]);
    });

    test("closing a question drops its undelivered elicitations", async () => {
      const db = await connected(connect);
      const elicitation = (id: string, status: string, questionId: string, op = "elicitation") =>
        db.run((q) =>
          q.exec(
            q.orm.insert(q.t.outbox).values({
              target: "linear",
              op,
              orderingKey: "session",
              idempotencyKey: id,
              payload: jsonValue(q, { questionId }),
              status,
              createdAt: 0,
            }),
          ),
        );
      await elicitation("pending", "pending", "asked");
      await elicitation("dead", "dead", "asked");
      await elicitation("sent", "sent", "asked");
      await elicitation("other", "pending", "another");
      await elicitation("note", "pending", "asked", "comment");

      await db.run((q) => dropQuestionElicitationsSteps(q, "asked", "Question cancelled."));

      const rows = await db.run((q) =>
        q.all(
          q.orm
            .select({
              key: q.t.outbox.idempotencyKey,
              status: q.t.outbox.status,
              error: q.t.outbox.error,
            })
            .from(q.t.outbox)
            .orderBy(q.t.outbox.idempotencyKey),
        ),
      );
      expect(rows).toEqual([
        { key: "dead", status: "dropped", error: "Question cancelled." },
        { key: "note", status: "pending", error: null },
        { key: "other", status: "pending", error: null },
        { key: "pending", status: "dropped", error: "Question cancelled." },
        { key: "sent", status: "sent", error: null },
      ]);
    });
  });

  describe("visual reviews", () => {
    test("a review reads back its files and carried approvals as JSON text", async () => {
      const db = await connected(connect);
      const carried = [{ evidenceId: "a", approvedBy: "ann" }];
      await review(db, "with-carried", { evidenceIds: ["a", "b"], carried });
      await review(db, "empty-carried", { carried: [] });

      const row = await db.run((q) => visualReviewRowSteps(q, "with-carried"));
      expect(row).toMatchObject({ kind: "review", outcome: null, headCommit: "head" });
      expect(JSON.parse(row!.evidenceIds)).toEqual(["a", "b"]);
      expect(JSON.parse(row!.carried!)).toEqual(carried);
      expect((await db.run((q) => visualReviewRowSteps(q, "empty-carried")))!.carried).toBeNull();
      expect(await db.run((q) => visualReviewRowSteps(q, "missing"))).toBeNull();
    });

    test("a continue row and a carried acceptance store their own fields", async () => {
      const db = await connected(connect);
      await review(db, "continue", { evidenceIds: [], kind: "continue", headCommit: undefined });
      await review(db, "carried", {
        carried: [{ evidenceId: "a" }],
        outcome: "accepted",
        answeredBy: "ann",
        answeredAt: 5,
      });

      const stored = await db.run((q) => visualReviewRowSteps(q, "continue"));
      expect(stored).toMatchObject({ kind: "continue", headCommit: null, outcome: null });
      expect(JSON.parse(stored!.evidenceIds)).toEqual([]);
      expect(await db.run((q) => visualReviewRowSteps(q, "carried"))).toMatchObject({
        outcome: "accepted",
        answeredBy: "ann",
        answeredAt: 5,
      });
    });

    test("saving an answer overwrites an earlier feedback and head with NULL", async () => {
      const db = await connected(connect);
      await review(db, "reviewed");
      await answerReview(db, "reviewed", "changes_requested", 3);
      await db.run((q) =>
        saveVisualReviewAnswerSteps(q, "reviewed", {
          outcome: "accepted",
          answeredBy: "ann",
          answeredAt: 4,
          feedback: null,
          headCommit: null,
        }),
      );

      expect(await db.run((q) => visualReviewRowSteps(q, "reviewed"))).toMatchObject({
        outcome: "accepted",
        answeredBy: "ann",
        answeredAt: 4,
        feedback: null,
        headCommit: null,
      });
    });

    test("only an accepted review goes stale", async () => {
      const db = await connected(connect);
      await review(db, "accepted");
      await answerReview(db, "accepted", "accepted", 3);
      await review(db, "rejected");
      await answerReview(db, "rejected", "changes_requested", 4);

      await db.run((q) => staleAcceptedVisualReviewSteps(q, "accepted"));
      await db.run((q) => staleAcceptedVisualReviewSteps(q, "rejected"));

      expect((await db.run((q) => visualReviewRowSteps(q, "accepted")))!.outcome).toBe("stale");
      expect((await db.run((q) => visualReviewRowSteps(q, "rejected")))!.outcome).toBe(
        "changes_requested",
      );
    });

    test("approved and accepted reviews list unanswered rows first, then oldest answer", async () => {
      const db = await connected(connect);
      await review(db, "late");
      await answerReview(db, "late", "accepted", 9);
      await review(db, "stale");
      await answerReview(db, "stale", "accepted", 5);
      await db.run((q) => staleAcceptedVisualReviewSteps(q, "stale"));
      await review(db, "no-time", {
        outcome: "accepted",
        answeredBy: "ann",
      });
      await review(db, "early");
      await answerReview(db, "early", "accepted", 2);
      await review(db, "continued", { kind: "continue" });
      await answerReview(db, "continued", "accepted", 1);
      await review(db, "other-check", { checkId: "else" });
      await answerReview(db, "other-check", "accepted", 1);

      const approved = await db.run((q) => humanApprovedVisualReviewRowsSteps(q, "item", "check"));
      expect(approved.map((row) => row.questionId)).toEqual(["no-time", "early", "stale", "late"]);
      const accepted = await db.run((q) => acceptedVisualReviewRowsSteps(q, "item"));
      expect(accepted.map((row) => row.questionId)).toEqual([
        "no-time",
        "other-check",
        "early",
        "late",
      ]);
    });

    test("an approval needs a person who answered", async () => {
      const db = await connected(connect);
      await review(db, "nobody", { outcome: "accepted" });

      expect(await db.run((q) => humanApprovedVisualReviewRowsSteps(q, "item", "check"))).toEqual(
        [],
      );
    });

    test("rejected reviews are the ones that asked for changes or went stale", async () => {
      const db = await connected(connect);
      await review(db, "changes");
      await answerReview(db, "changes", "changes_requested", 2);
      await review(db, "stale");
      await answerReview(db, "stale", "accepted", 3);
      await db.run((q) => staleAcceptedVisualReviewSteps(q, "stale"));
      await review(db, "accepted");
      await answerReview(db, "accepted", "accepted", 4);

      const rows = await db.run((q) => rejectedVisualReviewRowsSteps(q, "item"));
      expect(rows.map((row) => row.questionId).toSorted()).toEqual(["changes", "stale"]);
    });

    test("round counts split change requests from Keep going", async () => {
      const db = await connected(connect);
      expect(await db.run((q) => visualReviewRoundCountsSteps(q, "item", "check"))).toEqual({
        changes: 0,
        continued: 0,
      });
      await review(db, "one");
      await answerReview(db, "one", "changes_requested", 2);
      await review(db, "two");
      await answerReview(db, "two", "changes_requested", 3);
      await review(db, "keep", { kind: "continue", evidenceIds: [] });
      await answerReview(db, "keep", "continued", 4);
      await review(db, "open");
      await review(db, "elsewhere", { checkId: "else" });
      await answerReview(db, "elsewhere", "changes_requested", 5);

      expect(await db.run((q) => visualReviewRoundCountsSteps(q, "item", "check"))).toEqual({
        changes: 2,
        continued: 1,
      });
    });

    test("the last feedback is the newest change request, ahead of unanswered rows", async () => {
      const db = await connected(connect);
      expect(await db.run((q) => lastVisualReviewFeedbackRowSteps(q, "item", "check"))).toBeNull();
      await review(db, "untimed", { outcome: undefined });
      await db.run((q) =>
        q.exec(
          q.orm
            .update(q.t.visualReview)
            .set({ outcome: "changes_requested", feedback: "untimed" })
            .where(eq(q.t.visualReview.questionId, "untimed")),
        ),
      );
      await review(db, "older");
      await answerReview(db, "older", "changes_requested", 2);
      await review(db, "newer");
      await answerReview(db, "newer", "changes_requested", 3);
      await review(db, "accepted");
      await answerReview(db, "accepted", "accepted", 4);

      expect(await db.run((q) => lastVisualReviewFeedbackRowSteps(q, "item", "check"))).toEqual({
        questionId: "newer",
        feedback: "feedback newer",
      });
    });
  });
});
