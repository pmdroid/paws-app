import { afterEach, expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import {
  OutboxDispatcher,
  claimOutboxHeads,
  completeOutbox,
  enqueueOutbox,
  openPostgres,
  postgresDb,
  type Db,
} from "../src/db";
import { serverPostgres, tempStore } from "./pglite";
import { waitFor } from "./wait-for";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});

async function store(): Promise<Db> {
  const { db, close } = await tempStore();
  closes.push(close);
  return db;
}

const enqueue = (db: Db, orderingKey: string, idempotencyKey: string) =>
  enqueueOutbox(db, {
    target: "github",
    op: "comment",
    orderingKey,
    idempotencyKey,
    payload: { text: idempotencyKey },
    now: 0,
  });

const base = process.env.PAWS_TEST_DATABASE_URL;

test.skipIf(!base)("two connections racing for one head: exactly one receives it", async () => {
  const server = await serverPostgres(base!);
  closes.push(server.close);
  const pools = [openPostgres(server.url), openPostgres(server.url)];
  for (const pool of pools) closes.push(() => pool.$client.close());
  const [first, second] = pools.map((pool) => postgresDb(pool)) as [Db, Db];
  for (let trial = 0; trial < 50; trial += 1) {
    const id = await enqueue(first, `key-${trial}`, `race-${trial}`);
    const now = 1_000 + trial;
    const claims = await Promise.all([
      claimOutboxHeads(first, { now, workerId: "a" }),
      claimOutboxHeads(second, { now, workerId: "b" }),
    ]);
    expect(claims.flat().filter((row) => row.id === id)).toHaveLength(1);
  }
});

test("two messages with the same ordering key reach the provider in order", async () => {
  const db = await store();
  const clock = new FakeClock(5_000);
  const seen: string[] = [];
  const workers = ["a", "b"].map(
    (workerId) => new OutboxDispatcher(db, clock, { workerId, backoffBaseMs: 1_000 }),
  );
  for (const worker of workers)
    worker.setHandler((message) => {
      seen.push((message.payload as { text: string }).text);
    });
  await enqueue(db, "ses", "first");
  await enqueue(db, "ses", "second");
  await waitFor(async () => {
    await Promise.all(workers.map((worker) => worker.tick()));
    await Promise.all(workers.map((worker) => worker.idle()));
    return seen.length === 2;
  });
  expect(seen).toEqual(["first", "second"]);
});

test("different ordering keys are delivered in parallel", async () => {
  const db = await store();
  const dispatcher = new OutboxDispatcher(db, new FakeClock(5_000));
  const started: string[] = [];
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  dispatcher.setHandler(async (message) => {
    started.push(message.orderingKey!);
    await held;
  });
  await enqueue(db, "one", "one");
  await enqueue(db, "two", "two");
  expect((await dispatcher.tick()).map((row) => row.orderingKey).sort()).toEqual(["one", "two"]);
  await waitFor(() => started.length === 2);
  release();
  await dispatcher.idle();
  expect(started.sort()).toEqual(["one", "two"]);
});

test("an expired lease goes to a replacement, and the stale owner's completion is refused", async () => {
  const db = await store();
  await enqueue(db, "ses", "only");
  const [stale] = await claimOutboxHeads(db, { now: 1_000, leaseMs: 100, workerId: "a" });
  expect(await claimOutboxHeads(db, { now: 1_050, workerId: "b" })).toEqual([]);
  const [replacement] = await claimOutboxHeads(db, { now: 1_100, workerId: "b" });
  expect(replacement?.id).toBe(stale!.id);
  expect(await completeOutbox(db, stale!, 1_200)).toBe(false);
  expect(await completeOutbox(db, replacement!, 1_200)).toBe(true);
});
