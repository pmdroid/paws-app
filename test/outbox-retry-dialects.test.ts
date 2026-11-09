import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND } from "../src/core";
import {
  claimOutboxHeadsSteps,
  enqueueOutboxSteps,
  getOutboxSteps,
  listJobsSteps,
  listOutboxSteps,
  onJobReady,
  retryOutboxAsync,
  retryOutboxSteps,
  type Db,
  type NewOutbox,
  type OutboxRow,
} from "../src/db";
import { forEachDialect, insertWorkItem, seed, type DialectDb } from "./dialects";

const handles: DialectDb[] = [];
const stops: (() => void)[] = [];
afterEach(async () => {
  for (const stop of stops.splice(0)) stop();
  for (const handle of handles.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  handles.push(handle);
  return handle.db;
}

function enqueue(db: Db, row: Partial<NewOutbox> & { idempotencyKey: string }) {
  return db.transaction((q) =>
    enqueueOutboxSteps(q, { target: "github", op: "comment", now: 0, ...row }),
  );
}

async function claimOne(db: Db, now: number): Promise<OutboxRow> {
  const [row] = await db.run((q) => claimOutboxHeadsSteps(q, { now, workerId: "w" }));
  return row!;
}

function rateLimit(retryAfterMs: number): Error {
  const error = new Error("slow down") as Error & { retryAfterMs: number };
  error.name = "LinearRateLimitError";
  error.retryAfterMs = retryAfterMs;
  return error;
}

async function awaitingQuestion(db: Db, status = "open") {
  await insertWorkItem(db, "item");
  await seed(
    db,
    (q) =>
      q.orm
        .update(q.t.workItem)
        .set({ state: "awaiting_input" })
        .where(eq(q.t.workItem.id, "item")),
    (q) =>
      q.orm.insert(q.t.question).values({
        id: "question",
        itemId: "item",
        sessionId: "ses",
        body: "Which?",
        status,
        createdAt: 0,
      }),
  );
}

function elicitation(idempotencyKey: string, maxAttempts = 1) {
  return {
    target: "linear" as const,
    op: "elicitation",
    orderingKey: "ses",
    idempotencyKey,
    payload: { itemId: "item", questionId: "question", body: "Which?" },
    maxAttempts,
  };
}

forEachDialect((open) => {
  test("a failed delivery backs off, and a spent one goes dead", async () => {
    const db = await connect(open);
    const id = await enqueue(db, { idempotencyKey: "a", maxAttempts: 2 });
    const first = await claimOne(db, 0);
    await db.transaction((q) => retryOutboxSteps(q, first, new Error("boom"), { now: 10 }));
    const pending = (await db.run((q) => getOutboxSteps(q, id)))!;
    expect(pending).toMatchObject({ status: "pending", error: "boom", lockedBy: null });
    expect(pending.notBefore).toBeGreaterThan(10);
    expect(pending.maxAttempts).toBe(2);

    const second = await claimOne(db, pending.notBefore);
    const result = await db.transaction((q) =>
      retryOutboxSteps(q, second, new Error("again"), { now: pending.notBefore }),
    );
    expect(result).toEqual({ reasked: false });
    expect(await db.run((q) => getOutboxSteps(q, id))).toMatchObject({
      status: "dead",
      error: "again",
      notBefore: pending.notBefore,
    });
  });

  test("a rate limit keeps the row pending, adds an attempt and holds every Linear row back", async () => {
    const db = await connect(open);
    const id = await enqueue(db, {
      target: "linear",
      op: "activity",
      idempotencyKey: "a",
      maxAttempts: 1,
      payload: { kind: "response", body: "done" },
    });
    const row = await claimOne(db, 0);
    await db.transaction((q) => retryOutboxSteps(q, row, rateLimit(5_000), { now: 100 }));
    expect(await db.run((q) => getOutboxSteps(q, id))).toMatchObject({
      status: "pending",
      maxAttempts: 2,
      notBefore: 5_100,
      error: "slow down",
    });
    const backoff = await db.run(function* (q) {
      return yield* q.all(q.orm.select().from(q.t.linearOutboxBackoff));
    });
    expect(backoff).toEqual([{ id: 1, notBefore: 5_100 }]);

    const again = await claimOne(db, 5_100);
    await db.transaction((q) => retryOutboxSteps(q, again, rateLimit(10), { now: 5_100 }));
    const kept = await db.run(function* (q) {
      return yield* q.all(q.orm.select().from(q.t.linearOutboxBackoff));
    });
    expect(kept).toEqual([{ id: 1, notBefore: 5_110 }]);
  });

  test("a dead elicitation is delivered once more in place of the dead row", async () => {
    const db = await connect(open);
    await awaitingQuestion(db);
    const id = await enqueue(db, elicitation("ask"));
    const row = await claimOne(db, 0);
    const result = await db.transaction((q) =>
      retryOutboxSteps(q, row, new Error("down"), { now: 10 }),
    );
    expect(result).toEqual({ reasked: false });
    const rows = await db.run((q) => listOutboxSteps(q, "ses"));
    const redelivery = rows.find((entry) => entry.idempotencyKey === "ask:redelivery")!;
    expect(redelivery).toMatchObject({ status: "pending", payload: row.payload });
    expect(await db.run((q) => getOutboxSteps(q, id))).toMatchObject({
      status: "dropped",
      error: `Dead: down Re-enqueued as outbox ${redelivery.id}.`,
    });
  });

  test("a dead redelivery re-asks its question once per lineage and wakes the job loop", async () => {
    const db = await connect(open);
    await awaitingQuestion(db);
    let woken = 0;
    stops.push(
      onJobReady((source) => {
        if (source === db) woken += 1;
      }),
    );
    await enqueue(db, elicitation("ask:redelivery"));
    const row = await claimOne(db, 0);
    await retryOutboxAsync(db, row, new Error("down"), { now: 10 });
    const jobs = await db.run(listJobsSteps);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      queue: JOB_KIND.reaskQuestion,
      jobKey: `${JOB_KIND.reaskQuestion}:question`,
      payload: { itemId: "item", questionId: "question" },
    });
    expect(woken).toBe(1);

    await enqueue(db, { ...elicitation("other:reask"), orderingKey: "ses-2" });
    const again = await claimOne(db, 20);
    const result = await db.transaction((q) =>
      retryOutboxSteps(q, again, new Error("down"), { now: 20 }),
    );
    expect(result).toEqual({ reasked: false });
    expect(await db.run(listJobsSteps)).toHaveLength(1);
    expect(woken).toBe(1);
  });

  test("a dead elicitation of an answered question stays dead", async () => {
    const db = await connect(open);
    await awaitingQuestion(db, "answered");
    const id = await enqueue(db, elicitation("ask"));
    const row = await claimOne(db, 0);
    await db.transaction((q) => retryOutboxSteps(q, row, new Error("down"), { now: 10 }));
    expect(await db.run((q) => getOutboxSteps(q, id))).toMatchObject({ status: "dead" });
    expect(await db.run((q) => listOutboxSteps(q, "ses"))).toHaveLength(1);
  });
});
