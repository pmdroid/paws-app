import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  accrueAwake,
  applyWorkItemEvent,
  configureWorkItem,
  failWorkItem,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  type Db,
} from "../src/db";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0)) await close();
});

async function errorBodies(db: Db): Promise<string[]> {
  return (await listOutbox(db))
    .map((row) => row.payload as { kind?: string; body?: string })
    .filter((payload) => payload.kind === "error")
    .map((payload) => payload.body!);
}

test("a retried task that fails again with the same reason posts a second error", async () => {
  const { db, close } = await tempStore();
  closes.push(close);
  const { id } = await insertQueuedItem(db, { sessionKey: "session" });
  await applyWorkItemEvent(db, id, "dispatched");
  await failWorkItem(db, (await getWorkItem(db, id))!, "run_error", "first failure", 1);
  await applyWorkItemEvent(db, id, "restart");
  await applyWorkItemEvent(db, id, "dispatched");
  await failWorkItem(db, (await getWorkItem(db, id))!, "run_error", "second failure", 2);
  expect(await errorBodies(db)).toEqual(["first failure", "second failure"]);
});

test("a retried task that hits the same cap again posts a second error", async () => {
  const { db, close } = await tempStore();
  closes.push(close);
  const { id } = await insertQueuedItem(db, { maxAwakeMs: 10 });
  await seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ sessionKey: null }).where(eq(q.t.workItem.id, id)),
  );
  await applyWorkItemEvent(db, id, "dispatched");
  await accrueAwake(db, id, 0, 1, undefined, true);
  expect((await accrueAwake(db, id, 10, 2, undefined, true)).capped).toBe(true);
  await applyWorkItemEvent(db, id, "restart");
  await configureWorkItem(db, id, { maxAwakeMs: 20 });
  await applyWorkItemEvent(db, id, "dispatched");
  await accrueAwake(db, id, 100, 3, undefined, true);
  expect((await accrueAwake(db, id, 110, 4, undefined, true)).capped).toBe(true);
  expect(await errorBodies(db)).toHaveLength(2);
});
