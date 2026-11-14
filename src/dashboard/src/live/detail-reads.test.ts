import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  applyWorkItemEvent,
  beginImplementRun,
  enterMergeQueue,
  insertQueuedItem,
  type Db,
} from "../../../db";
import { createLiveStatusProvider } from "./provider";
import { seed } from "../../../../test/dialects";
import { tempStore } from "../../../../test/pglite";

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const ITEMS = ["PAS-1", "PAS-2", "PAS-3"];

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
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

async function item(db: Db, id: string, issue: string, at: number, identifier = id) {
  await insertQueuedItem(db, { id, title: `Task ${id}`, sessionKey: `session-${id}`, now: at });
  await seed(db, (q) =>
    q.orm
      .update(q.t.workItem)
      .set({ linearIdentifier: identifier, linearIssueId: issue })
      .where(eq(q.t.workItem.id, id)),
  );
}

async function world(extra: number): Promise<Db> {
  const { db, close } = await tempStore();
  open.push(close);
  await item(db, "PAS-1", "lin-1", T0);
  await beginImplementRun(db, "PAS-1", T0 + 1_000);
  await enterMergeQueue(db, "PAS-1", {
    phase: "merge_queue",
    baseSha: "d".repeat(40),
    wipCommit: "c".repeat(40),
  });
  await item(db, "PAS-2", "lin-2", T0 + 2_000);
  await item(db, "PAS-3", "lin-3", T0 + 3_000);
  await beginImplementRun(db, "PAS-3", T0 + 4_000);
  await applyWorkItemEvent(db, "PAS-3", "cancel", { now: T0 + 4_500 });
  await item(db, "PAS-3b", "lin-3", T0 + 5_000, "PAS-3");
  await seed(db, (q) =>
    q.orm.insert(q.t.taskBlock).values([
      { blockerLinearIssueId: "lin-1", blockedLinearIssueId: "lin-2" },
      { blockerLinearIssueId: "lin-3", blockedLinearIssueId: "lin-2" },
    ]),
  );
  for (let index = 0; index < extra; index += 1) {
    const id = `PAS-${100 + index}`;
    const at = T0 - 10_000 - index * 1_000;
    await item(db, id, `lin-${100 + index}`, at);
    await beginImplementRun(db, id, at + 1);
    if (index % 3 === 0)
      await enterMergeQueue(db, id, {
        phase: "merge_queue",
        baseSha: "d".repeat(40),
        wipCommit: "e".repeat(40),
      });
    if (index % 3 === 1) await applyWorkItemEvent(db, id, "cancel", { now: at + 2 });
    if (index % 4 === 0)
      await seed(db, (q) =>
        q.orm
          .insert(q.t.taskBlock)
          .values({ blockerLinearIssueId: "lin-1", blockedLinearIssueId: `lin-${100 + index}` }),
      );
  }
  return db;
}

function stable(json: string): string {
  return json
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "<uuid>")
    .replace(/"20\d\d-[0-9T:.-]+Z"/g, (at) => (at.startsWith('"2026-11-01') ? at : '"<now>"'))
    .replace(/"ms":\d+/g, '"ms":"<ms>"');
}

async function details(db: Db): Promise<{ json: Map<string, string>; calls: number[] }> {
  const store = counted(db);
  const provider = createLiveStatusProvider(store.db, {
    now: () => new Date(T0 + 60_000),
    env: {},
  });
  const json = new Map<string, string>();
  const calls: number[] = [];
  for (const id of ITEMS) {
    const before = store.calls();
    json.set(id, stable(JSON.stringify(await provider.issue(id))));
    calls.push(store.calls() - before);
  }
  return { json, calls };
}

describe("one issue's detail", () => {
  test("reads the same store calls with 2 or 20 other items, at most 60", async () => {
    const small = await details(await world(2));
    const large = await details(await world(20));
    expect(large.calls).toEqual(small.calls);
    expect(Math.max(...large.calls)).toBeLessThanOrEqual(60);
  });

  test("the other items leave the detail unchanged except for whom PAS-1 blocks", async () => {
    const small = await details(await world(2));
    const large = await details(await world(20));
    for (const id of ["PAS-2", "PAS-3"]) expect(large.json.get(id)).toBe(small.json.get(id)!);
    const blocks = (json: string) => (JSON.parse(json) as { blocks: string[] }).blocks;
    expect(blocks(large.json.get("PAS-1")!)).toEqual([
      "PAS-2",
      "PAS-100",
      "PAS-104",
      "PAS-108",
      "PAS-112",
      "PAS-116",
    ]);
    expect(blocks(small.json.get("PAS-1")!)).toEqual(["PAS-2", "PAS-100"]);
  });
});
