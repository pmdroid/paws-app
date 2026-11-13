import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  accrueAwake,
  applyWorkItemEvent,
  getWorkItem,
  insertQueuedItem,
  refundLostTurnAsync,
} from "../src/db";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

const MINUTE = 60_000;

test("a turn declared lost gives back its implementation time after the last checkpoint", async () => {
  const { db, close } = await tempStore();
  closes.push(close);
  const { id } = await insertQueuedItem(db, { sessionKey: "session" });
  await applyWorkItemEvent(db, id, "dispatched");
  await accrueAwake(db, id, 0, 1, undefined, true);
  await accrueAwake(db, id, 60 * MINUTE, 2, undefined, true);
  expect((await getWorkItem(db, id))!.implementMs).toBe(60 * MINUTE);

  expect(await refundLostTurnAsync(db, id, 60 * MINUTE, 3, 40 * MINUTE)).toBe(40 * MINUTE);
  const item = (await getWorkItem(db, id))!;
  expect(item.implementMs).toBe(20 * MINUTE);
  expect(item.agentMs).toBe(20 * MINUTE);
  expect(item.awakeMs).toBe(20 * MINUTE);

  expect(await refundLostTurnAsync(db, id, 60 * MINUTE, 4, 90 * MINUTE)).toBe(20 * MINUTE);
  expect((await getWorkItem(db, id))!.implementMs).toBe(0);
});

test("a refund larger than the stored awake time leaves 0, and the next accrual adds to 0", async () => {
  const { db, close } = await tempStore();
  closes.push(close);
  const { id } = await insertQueuedItem(db, { sessionKey: "session" });
  await applyWorkItemEvent(db, id, "dispatched");
  await accrueAwake(db, id, 0, 1, undefined, true);
  await accrueAwake(db, id, 60 * MINUTE, 2, undefined, true);
  await seed(db, (q) =>
    q.orm
      .update(q.t.workItem)
      .set({ awakeMs: 10 * MINUTE })
      .where(eq(q.t.workItem.id, id)),
  );

  expect(await refundLostTurnAsync(db, id, 60 * MINUTE, 3, 40 * MINUTE)).toBe(40 * MINUTE);
  const refunded = (await getWorkItem(db, id))!;
  expect(refunded.awakeMs).toBe(0);
  expect(refunded.agentMs).toBe(20 * MINUTE);
  expect(refunded.implementMs).toBe(20 * MINUTE);

  await accrueAwake(db, id, 65 * MINUTE, 4, undefined, true);
  expect((await getWorkItem(db, id))!.awakeMs).toBe(5 * MINUTE);
});
