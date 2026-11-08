import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  activeItemQuestionsSteps,
  amendQuestionRowSteps,
  askedQuestionRowSteps,
  cancelQueuedQuestionsSteps,
  dropQuestionElicitationsSteps,
  enqueueOutboxSteps,
  insertQuestionRowSteps,
  markQuestionAnsweredSteps,
  nextQueuedQuestionRowSteps,
  openQuestionRowSteps,
  promoteQuestionRowSteps,
  questionEventConsumedSteps,
  questionRowByIdSteps,
  setQuestionCancelledSteps,
  type Db,
  type NewQuestionRow,
} from "../src/db";
import { forEachDialect, insertWorkItem } from "./dialects";

const question = (id: string, overrides: Partial<NewQuestionRow> = {}): NewQuestionRow => ({
  id,
  itemId: "item",
  runId: "run",
  sessionId: `session-${id}`,
  kind: "agent",
  reason: "agent",
  body: "Which one?",
  context: null,
  options: null,
  status: "open",
  createdAt: 10,
  ...overrides,
});

const insert = (db: Db, row: NewQuestionRow) => db.run((q) => insertQuestionRowSteps(q, row));

forEachDialect((open) => {
  test("a question reads back with its options as JSON text", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await insert(db, question("q1", { options: [{ label: "Yes" }], context: "why" }));
      await insert(db, question("q2"));
      const row = await db.run((q) => questionRowByIdSteps(q, "q1"));
      expect(JSON.parse(row!.options!)).toEqual([{ label: "Yes" }]);
      expect(row).toMatchObject({ itemId: "item", context: "why", status: "open", createdAt: 10 });
      expect((await db.run((q) => questionRowByIdSteps(q, "q2")))!.options).toBeNull();
      expect(await db.run((q) => questionRowByIdSteps(q, "absent"))).toBeNull();
    } finally {
      await close();
    }
  });

  test("the open question of a session skips cancelled ones", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await insert(db, question("old", { sessionId: "ses" }));
      await db.run((q) => setQuestionCancelledSteps(q, "old", 11));
      expect(await db.run((q) => openQuestionRowSteps(q, "ses"))).toBeNull();
      await insert(db, question("new", { sessionId: "ses", createdAt: 5 }));
      expect((await db.run((q) => openQuestionRowSteps(q, "ses")))!.id).toBe("new");
    } finally {
      await close();
    }
  });

  test("a run's asked question is its latest open or queued one of that kind", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await insert(db, question("first", { status: "queued", kind: "ci-help" }));
      await insert(db, question("later", { status: "queued", kind: "ci-help", createdAt: 20 }));
      await insert(db, question("other", { kind: "agent", createdAt: 30 }));
      const asked = await db.run((q) => askedQuestionRowSteps(q, "run", "ci-help"));
      expect(asked!.id).toBe("later");
      expect(await db.run((q) => askedQuestionRowSteps(q, "gone", "ci-help"))).toBeNull();
    } finally {
      await close();
    }
  });

  test("the next queued question is the oldest one that is not cancelled", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      const queued = { sessionId: "ses", status: "queued" as const };
      await insert(db, question("q1", { ...queued, createdAt: 20 }));
      await insert(db, question("q2", { ...queued, createdAt: 10 }));
      expect((await db.run((q) => nextQueuedQuestionRowSteps(q, "ses")))!.id).toBe("q2");
      await db.run((q) => setQuestionCancelledSteps(q, "q2", 30));
      expect((await db.run((q) => nextQueuedQuestionRowSteps(q, "ses")))!.id).toBe("q1");
    } finally {
      await close();
    }
  });

  test("a question is answered once and its event counts as consumed", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await insert(db, question("q1", { sessionId: "ses" }));
      const answer = { answer: "Yes", answeredBy: "ann", answeredAt: 20, answerEventKey: "evt" };
      expect(await db.run((q) => questionEventConsumedSteps(q, "ses", "evt"))).toBe(false);
      expect(await db.run((q) => markQuestionAnsweredSteps(q, "q1", answer))).toBe(true);
      expect(await db.run((q) => markQuestionAnsweredSteps(q, "q1", answer))).toBe(false);
      expect(await db.run((q) => questionEventConsumedSteps(q, "ses", "evt"))).toBe(true);
      expect(await db.run((q) => questionRowByIdSteps(q, "q1"))).toMatchObject({
        status: "answered",
        answer: "Yes",
        answeredBy: "ann",
        answeredAt: 20,
      });
    } finally {
      await close();
    }
  });

  test("cancelling queued questions keeps other kinds and scopes", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      const queued = { status: "queued" as const, kind: "ci-help" };
      await insert(db, question("item-a", { ...queued, sessionId: "a" }));
      await insert(db, question("item-b", { ...queued, sessionId: "b" }));
      await insert(db, question("kind", { status: "queued", kind: "agent", sessionId: "a" }));
      await insert(db, question("open", { kind: "ci-help", sessionId: "c" }));
      await db.run((q) => cancelQueuedQuestionsSteps(q, { sessionId: "a" }, "ci-help", 50));
      const cancelled = async (id: string) =>
        (await db.run((q) => questionRowByIdSteps(q, id)))!.cancelledAt;
      expect(await cancelled("item-a")).toBe(50);
      expect(await cancelled("item-b")).toBeNull();
      await db.run((q) => cancelQueuedQuestionsSteps(q, { itemId: "item" }, "ci-help", 60));
      expect(await cancelled("item-b")).toBe(60);
      expect(await cancelled("item-a")).toBe(50);
      expect(await cancelled("kind")).toBeNull();
      expect(await cancelled("open")).toBeNull();
    } finally {
      await close();
    }
  });

  test("amending, promoting and listing an item's active questions", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "item");
      await insert(db, question("q1", { status: "queued", sessionId: "ses" }));
      await insert(db, question("q2", { sessionId: "other" }));
      await insert(db, question("q3", { sessionId: "third" }));
      await db.run((q) => setQuestionCancelledSteps(q, "q3", 12));
      await db.run((q) => amendQuestionRowSteps(q, "q1", { context: "c", options: ["A"] }));
      await db.run((q) => promoteQuestionRowSteps(q, "q1", 40));
      const row = await db.run((q) => questionRowByIdSteps(q, "q1"));
      expect(row).toMatchObject({ status: "open", createdAt: 40, context: "c" });
      expect(JSON.parse(row!.options!)).toEqual(["A"]);
      const active = await db.run((q) => activeItemQuestionsSteps(q, "item"));
      expect(active.map((entry) => entry.id).sort()).toEqual(["q1", "q2"]);
      expect(active[0]).toEqual({
        id: expect.any(String),
        kind: "agent",
        sessionId: expect.any(String),
      });
    } finally {
      await close();
    }
  });

  test("only a question's unsent elicitations are dropped", async () => {
    const { db, close } = await open();
    try {
      const elicitation = (key: string, questionId: string) => ({
        target: "linear" as const,
        op: "elicitation",
        idempotencyKey: key,
        payload: { questionId },
      });
      const ids = await db.run(function* (q) {
        const pending = yield* enqueueOutboxSteps(q, elicitation("pending", "q1"));
        const dead = yield* enqueueOutboxSteps(q, elicitation("dead", "q1"));
        const sent = yield* enqueueOutboxSteps(q, elicitation("sent", "q1"));
        const other = yield* enqueueOutboxSteps(q, elicitation("other", "q2"));
        yield* q.exec(
          q.orm.update(q.t.outbox).set({ status: "dead" }).where(eq(q.t.outbox.id, dead)),
        );
        yield* q.exec(
          q.orm.update(q.t.outbox).set({ status: "sent" }).where(eq(q.t.outbox.id, sent)),
        );
        return { pending, dead, sent, other };
      });
      await db.run((q) => dropQuestionElicitationsSteps(q, "q1", "Question cancelled."));
      const read = (id: number) =>
        db.run(function* (q) {
          return yield* q.one(
            q.orm
              .select({ status: q.t.outbox.status, error: q.t.outbox.error })
              .from(q.t.outbox)
              .where(eq(q.t.outbox.id, id)),
          );
        });
      expect(await read(ids.pending)).toEqual({ status: "dropped", error: "Question cancelled." });
      expect(await read(ids.dead)).toEqual({ status: "dropped", error: "Question cancelled." });
      expect((await read(ids.sent))!.status).toBe("sent");
      expect((await read(ids.other))!.status).toBe("pending");
    } finally {
      await close();
    }
  });
});
