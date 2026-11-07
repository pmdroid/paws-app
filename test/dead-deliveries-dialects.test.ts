import { afterEach, beforeEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  deadDeliveryIsFinalStopSteps,
  deadDeliveryItemIdSteps,
  dropDeadElicitationsSteps,
  ELICITATION_REASK_SUFFIX,
  listDeadDeliveriesSteps,
  questionHasLinkedRecordsSteps,
  recordQuestionReaskSteps,
  redeliverQuestionSteps,
  retryDeadDeliverySteps,
  setJournalSink,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, insertWorkItem, json, seed, type DialectDb } from "./dialects";

const open: DialectDb[] = [];
let restore: () => void = () => {};
beforeEach(() => {
  restore = setJournalSink(() => {});
});
afterEach(async () => {
  restore();
  for (const handle of open.splice(0)) await handle.close();
});

async function deadItem(db: Db) {
  await insertWorkItem(db, "item-1");
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.question).values({
        id: "q-1",
        itemId: "item-1",
        sessionId: "session-1",
        body: "Which repository?",
        status: "open",
        createdAt: 0,
      }),
    (q) =>
      q.orm.insert(q.t.outbox).values([
        {
          target: "linear",
          op: "elicitation",
          orderingKey: "session-1",
          idempotencyKey: "question:q-1",
          payload: json(db, { questionId: "q-1", body: "Which repository?" }),
          status: "dead",
          attempts: 5,
          error: "boom",
          deliveryKind: "critical",
          deliveryGeneration: 0,
          createdAt: 300,
        },
        {
          target: "linear",
          op: "activity",
          idempotencyKey: "stop:item-1",
          payload: json(db, { itemId: "item-1" }),
          status: "dead",
          attempts: 5,
          deliveryKind: "stop",
          createdAt: 100,
        },
      ]),
    (q) =>
      q.orm.insert(q.t.job).values([
        {
          queue: "start",
          payload: json(db, { itemId: "item-1" }),
          status: "dead",
          attempts: 10,
          runAt: 0,
          lastError: "failed",
          itemVersion: 0,
          createdAt: 50,
          finishedAt: 200,
        },
        {
          queue: "resume",
          payload: json(db, { itemId: "item-1" }),
          status: "dead",
          attempts: 10,
          runAt: 0,
          itemVersion: 7,
          createdAt: 400,
        },
      ]),
  );
}

const jobRow = (q: Q, id: number) =>
  q.one(
    q.orm
      .select({ status: q.t.job.status, attempts: q.t.job.attempts, payload: q.t.job.payload })
      .from(q.t.job)
      .where(eq(q.t.job.id, id)),
  );

forEachDialect((connect) => {
  test("dead rows and jobs of an item list oldest first, with their item and Stop kind", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await deadItem(db);

    expect(await db.run((q) => listDeadDeliveriesSteps(q, "item-1"))).toEqual([
      {
        kind: "outbox",
        id: 2,
        name: "linear.activity",
        error: null,
        attempts: 5,
        createdAt: 100,
        at: 100,
        retryable: true,
      },
      {
        kind: "job",
        id: 1,
        name: "start",
        error: "failed",
        attempts: 10,
        createdAt: 50,
        at: 200,
        retryable: true,
      },
      {
        kind: "outbox",
        id: 1,
        name: "linear.elicitation",
        error: "boom",
        attempts: 5,
        createdAt: 300,
        at: 300,
        retryable: true,
      },
      {
        kind: "job",
        id: 2,
        name: "resume",
        error: null,
        attempts: 10,
        createdAt: 400,
        at: 400,
        retryable: false,
      },
    ]);
    expect(await db.run((q) => listDeadDeliveriesSteps(q, "item-2"))).toEqual([]);

    expect(await db.run((q) => deadDeliveryItemIdSteps(q, { kind: "outbox", id: 1 }))).toBe(
      "item-1",
    );
    expect(await db.run((q) => deadDeliveryItemIdSteps(q, { kind: "job", id: 1 }))).toBe("item-1");
    expect(await db.run((q) => deadDeliveryItemIdSteps(q, { kind: "job", id: 99 }))).toBeNull();

    expect(await db.run((q) => deadDeliveryIsFinalStopSteps(q, { kind: "outbox", id: 2 }))).toBe(
      true,
    );
    expect(await db.run((q) => deadDeliveryIsFinalStopSteps(q, { kind: "outbox", id: 1 }))).toBe(
      false,
    );
    expect(await db.run((q) => deadDeliveryIsFinalStopSteps(q, { kind: "job", id: 1 }))).toBe(
      false,
    );
  });

  test("a retry revives a current dead row or job once and refuses an obsolete job", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await deadItem(db);

    const retry = (ref: { kind: "outbox" | "job"; id: number }, itemId = "item-1") =>
      db.transaction((q) => retryDeadDeliverySteps(q, itemId, ref, 9_000));
    expect(await retry({ kind: "outbox", id: 1 }, "item-2")).toBe(false);
    expect(await retry({ kind: "outbox", id: 1 })).toBe(true);
    expect(await retry({ kind: "outbox", id: 1 })).toBe(false);
    const row = await db.run((q) =>
      q.one(q.orm.select().from(q.t.outbox).where(eq(q.t.outbox.id, 1))),
    );
    expect(row).toMatchObject({ status: "pending", maxAttempts: 10, notBefore: 9_000 });

    expect(await retry({ kind: "job", id: 2 })).toBe(false);
    expect(await retry({ kind: "job", id: 1 })).toBe(true);
    expect(await db.run((q) => jobRow(q, 1))).toMatchObject({ status: "pending", attempts: 0 });
  });

  test("dead elicitations of a question drop with a note, and a re-ask is recorded on its job", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await deadItem(db);

    expect(await db.run((q) => dropDeadElicitationsSteps(q, "q-1", "Asked again."))).toBe(1);
    expect(await db.run((q) => dropDeadElicitationsSteps(q, "q-1", "Asked again."))).toBe(0);
    const row = await db.run((q) =>
      q.one(
        q.orm
          .select({ status: q.t.outbox.status, error: q.t.outbox.error })
          .from(q.t.outbox)
          .where(eq(q.t.outbox.id, 1)),
      ),
    );
    expect(row).toEqual({ status: "dropped", error: "boom Asked again." });

    await db.run((q) => recordQuestionReaskSteps(q, 1, "q-2"));
    const payload = (await db.run((q) => jobRow(q, 1)))?.payload;
    expect(db.dialect === "sqlite" ? JSON.parse(payload as string) : payload).toEqual({
      itemId: "item-1",
      reaskedAs: "q-2",
    });
  });

  test("a question with a linked record is delivered again under a fresh key", async () => {
    const handle = await connect();
    open.push(handle);
    const { db } = handle;
    await deadItem(db);

    expect(await db.run((q) => questionHasLinkedRecordsSteps(q, "q-1"))).toBe(false);
    await seed(db, (q) =>
      q.orm.insert(q.t.pushOutage).values({
        repository: "acme/paws",
        startedAt: 0,
        lastError: "refused",
        lastFailedAt: 0,
        nextProbeAt: 0,
        questionId: "q-1",
      }),
    );
    expect(await db.run((q) => questionHasLinkedRecordsSteps(q, "q-1"))).toBe(true);

    expect(await db.transaction((q) => redeliverQuestionSteps(q, "q-2", 1_000))).toBeNull();
    const id = await db.transaction((q) => redeliverQuestionSteps(q, "q-1", 1_000));
    expect(id).not.toBeNull();
    const rows = await db.run((q) =>
      q.all(
        q.orm
          .select({
            id: q.t.outbox.id,
            status: q.t.outbox.status,
            key: q.t.outbox.idempotencyKey,
            payload: q.t.outbox.payload,
            kind: q.t.outbox.deliveryKind,
            generation: q.t.outbox.deliveryGeneration,
          })
          .from(q.t.outbox)
          .where(eq(q.t.outbox.op, "elicitation"))
          .orderBy(q.t.outbox.id),
      ),
    );
    const elicitation = json(db, { questionId: "q-1", body: "Which repository?" });
    expect(rows).toEqual([
      {
        id: 1,
        status: "dropped",
        key: "question:q-1",
        payload: elicitation,
        kind: "critical",
        generation: 0,
      },
      {
        id: id!,
        status: "pending",
        key: `question:q-1${ELICITATION_REASK_SUFFIX}`,
        payload: elicitation,
        kind: "critical",
        generation: 0,
      },
    ]);
  });
});
