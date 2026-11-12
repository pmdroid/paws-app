import { afterEach, expect, test } from "bun:test";
import {
  accrueAwake,
  applyWorkItemEvent,
  getWorkItem,
  insertQueuedItem,
  refundLostTurnAsync,
} from "../src/db";
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
