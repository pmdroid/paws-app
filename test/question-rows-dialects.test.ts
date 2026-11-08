import { afterEach, describe, expect, test } from "bun:test";
import {
  amendQuestionRowSteps,
  askedQuestionRowSteps,
  cancelQueuedQuestionsSteps,
  dropQuestionElicitationsSteps,
  insertQuestionRowSteps,
  markQuestionAnsweredSteps,
  nextQueuedQuestionRowSteps,
  openQuestionRowSteps,
  promoteQuestionRowSteps,
  questionEventConsumedSteps,
  questionRowSteps,
  setQuestionCancelledSteps,
  waitingItemQuestionsSteps,
  type Db,
  type NewQuestionRow,
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
});
