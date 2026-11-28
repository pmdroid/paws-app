import { afterEach, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { tempStore } from "../../test/pglite";
import type { Db } from "./db";
import { createRunWaker } from "./notify";

let open: { db: Db; close(): Promise<void> } | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

const notify = (db: Db, runId: string) =>
  db.orm.execute(sql`SELECT pg_notify('paws_runner_run', ${runId})`);

test("a notification sent while the run subscribes still wakes it", async () => {
  open = await tempStore();
  const waker = createRunWaker(open.db, 250);
  expect(waker.backstopMs).toBe(5_000);
  using watch = waker.watch("run-a");
  await notify(open.db, "run-a");
  await watch.wait(60_000, new AbortController().signal);
});

test("a committed notification wakes only its own run", async () => {
  open = await tempStore();
  const waker = createRunWaker(open.db, 250);
  const signal = new AbortController().signal;
  using a = waker.watch("run-a");
  using b = waker.watch("run-b");
  await a.wait(60_000, signal);
  await b.wait(60_000, signal);
  let woke = false;
  const waiting = b.wait(60_000, signal).then(() => (woke = true));
  await notify(open.db, "run-a");
  await a.wait(60_000, signal);
  expect(woke).toBe(false);
  b.wake();
  await waiting;
});

test("a notification that arrives between waits is kept for the next wait", async () => {
  open = await tempStore();
  const waker = createRunWaker(open.db, 250);
  const signal = new AbortController().signal;
  using a = waker.watch("run-a");
  await a.wait(60_000, signal);
  await notify(open.db, "run-a");
  await a.wait(60_000, signal);
});

test("a store without notifications keeps the fallback interval", () => {
  expect(createRunWaker({ orm: {} } as unknown as Db, 250).backstopMs).toBe(250);
});
