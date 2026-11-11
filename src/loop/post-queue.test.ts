import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../core";
import {
  JobLoop,
  OutboxDispatcher,
  beginImplementRun,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  migrate,
  openDatabase,
  sqliteDb,
  type Db,
} from "../db";
import { Orchestrator } from "./orchestrator";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paws-post-queue-"));
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  const sqlite = sqliteDb(db);
  const gate: { held: Promise<void> | null } = { held: null };
  const store = {
    ...sqlite,
    transaction: async (body) => {
      if (gate.held) await gate.held;
      return await sqlite.transaction(body);
    },
  } as Db;
  const journal: string[] = [];
  const orchestrator = new Orchestrator({
    store,
    clock,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
    journal: (line) => journal.push(line),
  });
  await insertQueuedItem(db, { id: "ENG-7", sessionKey: "ses_1", now: clock.now() });
  await beginImplementRun(sqliteDb(db), "ENG-7", clock.now());
  const item = (await getWorkItem(sqliteDb(db), "ENG-7"))!;
  const post = (key: string) => orchestrator["post"](item, "response", `Body ${key}.`, key);
  const keys = async () =>
    (await listOutbox(sqliteDb(db), "ses_1")).map((row) => row.idempotencyKey);
  return {
    orchestrator,
    gate,
    journal,
    post,
    keys,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

test("posts issued back to back land in call order", async () => {
  const f = await fixture();
  try {
    let release = () => {};
    f.gate.held = new Promise<void>((resolve) => (release = resolve));
    void f.post("first");
    void f.post("second");
    void f.post("third");
    expect(await f.keys()).toEqual([]);
    release();
    await f.orchestrator.flushPosts();
    expect(await f.keys()).toEqual(["first", "second", "third"]);
  } finally {
    await f.cleanup();
  }
});

test("a failing post is journalled and the next post still lands", async () => {
  const f = await fixture();
  try {
    const failed = f.orchestrator["queuePost"]("ENG-7", function* () {
      yield* [];
      throw new Error("post broke");
    });
    void f.post("after");
    await f.orchestrator.flushPosts();
    expect(await failed).toBeUndefined();
    expect(await f.keys()).toEqual(["after"]);
    expect(f.journal.some((line) => line.includes("post broke"))).toBe(true);
  } finally {
    await f.cleanup();
  }
});

test("shutdown waits for queued posts", async () => {
  const f = await fixture();
  try {
    f.gate.held = new Promise<void>((resolve) => setTimeout(resolve, 20));
    void f.post("queued");
    await f.orchestrator.shutdown();
    expect(await f.keys()).toEqual(["queued"]);
  } finally {
    await f.cleanup();
  }
});
