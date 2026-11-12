import { afterEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  claimNextJob,
  dispatchOutbox,
  enqueueJob,
  enqueueOutbox,
  getJob,
  getOutboxSteps,
  type PgDb,
} from "../src/db";
import { tempStore } from "./pglite";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function openTemp() {
  const { db, close } = await tempStore();
  open.push(close);
  return db;
}

describe("job and outbox", () => {
  test("enqueueJob round-trips and claim takes the due row", async () => {
    const db = await openTemp();
    const id = await enqueueJob(db, {
      queue: "run",
      jobKey: "item-1",
      payload: { itemId: "i1" },
      priority: 1,
    });
    expect(await getJob(db, id)).toMatchObject({
      id,
      queue: "run",
      jobKey: "item-1",
      payload: { itemId: "i1" },
      status: "pending",
      priority: 1,
    });
    expect((await claimNextJob(db, { workerId: "test" }))?.id).toBe(id);
    const invalid = sql`INSERT INTO job (queue, payload, run_at, created_at) VALUES ('q', '{', 0, 0)`;
    await expect(Promise.resolve((db as PgDb).orm.execute(invalid))).rejects.toThrow();
  });

  test("enqueueOutbox round-trips, rejects a duplicate key, and dispatch marks it sent", async () => {
    const db = await openTemp();
    const id = await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      idempotencyKey: "act-1",
      orderingKey: "session-1",
      payload: { body: "Starting" },
    });
    expect(await db.run((q) => getOutboxSteps(q, id))).toMatchObject({
      id,
      target: "linear",
      op: "activity",
      idempotencyKey: "act-1",
      orderingKey: "session-1",
      payload: { body: "Starting" },
      status: "pending",
    });
    await expect(
      enqueueOutbox(db, { target: "linear", op: "activity", idempotencyKey: "act-1" }),
    ).rejects.toThrow();
    const delivered: number[] = [];
    await dispatchOutbox(db, {
      deliver: (row) => {
        delivered.push(row.id);
      },
    });
    expect(delivered).toEqual([id]);
    expect((await db.run((q) => getOutboxSteps(q, id)))?.status).toBe("sent");
  });
});
