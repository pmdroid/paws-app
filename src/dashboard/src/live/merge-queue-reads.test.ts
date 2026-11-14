import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  enqueueJob,
  enterMergeQueue,
  insertQueuedItem,
  joinMergeQueue,
  keepTaskMergeSettings,
  recordConfirmedRemoteMerge,
  type Db,
} from "../../../db";
import { createLiveStatusProvider } from "./provider";
import { tempStore } from "../../../../test/pglite";

const T0 = Date.parse("2026-11-01T10:00:00.000Z");

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  setSystemTime();
  for (const close of open.splice(0)) await close();
});

function counted(db: Db): { db: Db; calls: () => number } {
  let calls = 0;
  const proxy = new Proxy(db, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target);
      if (typeof value !== "function") return value;
      if (key !== "run" && key !== "transaction") return value.bind(target);
      return (...args: unknown[]) => {
        calls += 1;
        return value.apply(target, args);
      };
    },
  });
  return { db: proxy, calls: () => calls };
}

async function waiting(db: Db, id: string, at: number) {
  await insertQueuedItem(db, { id, title: `Task ${id}`, sessionKey: `session-${id}`, now: at });
  await beginImplementRun(db, id, at + 1);
  await enterMergeQueue(db, id, { phase: "merge_queue", baseSha: "d".repeat(40) });
  await bindWorkItemRepository(db, id, {
    owner: "acme",
    repo: "app",
    remoteUrl: "https://github.com/acme/app.git",
  });
  await joinMergeQueue(db, { itemId: id, repository: "acme/app", now: at + 2 });
  await keepTaskMergeSettings(
    db,
    id,
    {
      order: "queue",
      mainMoved: "overlap",
      resolved: { sources: { order: "rule" }, rule: { label: "hotfix" } },
    },
    at + 3,
  );
  await enqueueJob(db, {
    queue: "github.merge",
    payload: { itemId: id, mergeWait: { reason: "ci", message: "CI is running" } },
    now: at + 4,
  });
}

async function merged(db: Db, id: string, at: number) {
  await insertQueuedItem(db, { id, title: `Task ${id}`, sessionKey: `session-${id}`, now: at });
  await beginImplementRun(db, id, at + 1);
  await enterMergeQueue(db, id, { phase: "merge_queue", baseSha: "d".repeat(40) });
  await applyWorkItemEvent(db, id, "merge_accepted", { now: at + 2 });
  await recordConfirmedRemoteMerge(db, {
    itemId: id,
    repositoryOwner: "acme",
    repositoryName: "app",
    pullNumber: 1,
    pullUrl: null,
    mergeSha: "f".repeat(40),
    confirmedAt: at + 3,
  });
}

async function backWithAgent(db: Db, id: string, at: number) {
  await insertQueuedItem(db, { id, title: `Task ${id}`, sessionKey: `session-${id}`, now: at });
  await bindWorkItemRepository(db, id, {
    owner: "acme",
    repo: "app",
    remoteUrl: "https://github.com/acme/app.git",
  });
  await enqueueJob(db, { queue: "github.merge", payload: { itemId: id }, now: at + 1 });
  await enqueueJob(db, {
    queue: "run.resume",
    payload: { itemId: id, reason: "ci-failed" },
    now: at + 2,
  });
}

async function world(count: number): Promise<Db> {
  setSystemTime(new Date(T0));
  const { db, close } = await tempStore();
  open.push(close);
  for (let index = 0; index < count; index += 1) {
    const at = T0 + index * 1_000;
    const kind = [waiting, merged, backWithAgent][index % 3]!;
    await kind(db, `PAS-${100 + index}`, at);
  }
  return db;
}

function stable(value: unknown): string {
  return JSON.stringify(value)
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/[0-9A-HJKMNP-TV-Z]{26}/g, "<ulid>");
}

async function reads(count: number) {
  const store = counted(await world(count));
  const provider = createLiveStatusProvider(store.db, {
    now: () => new Date(T0 + 60_000),
    env: {},
  });
  const json = stable(await provider.mergeQueue());
  return { calls: store.calls(), json: createHash("sha256").update(json).digest("hex") };
}

const BEFORE_BATCHING = [
  "bccf725dd7f2645d42e76c77bffe99f8a5cb451cbd9be4506f8553985eabf177",
  "3c94ce1afd42b3094971f2c020415704bcc91c2b9a694902457caca53cbf0f2f",
];

describe("the merge queue", () => {
  test("reads the same store calls with 2 or 20 queued items and returns its JSON from before batching", async () => {
    const small = await reads(2);
    const large = await reads(20);
    expect([small.json, large.json]).toEqual(BEFORE_BATCHING);
    expect(large.calls).toBe(small.calls);
    expect(large.calls).toBeLessThanOrEqual(25);
  });
});
