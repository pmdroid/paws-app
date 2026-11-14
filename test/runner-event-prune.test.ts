import { expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import type { Q } from "../src/db";
import { pruneRunnerEvents } from "../src/runner-work";
import { seed, withoutForeignKeys } from "./dialects";
import { tempStore } from "./pglite";

const DAY = 86_400_000;
const NOW = 100 * DAY;

async function setup() {
  const { db, close } = await tempStore();
  await withoutForeignKeys(db);
  const run = (
    id: string,
    endedDaysAgo: number,
    events: number,
    options: { status?: string; workEnded?: boolean; types?: string[] } = {},
  ) =>
    seed(
      db,
      (q) =>
        q.orm.insert(q.t.run).values({
          id,
          itemId: "item",
          kind: "agent",
          agent: "codex",
          status: options.status ?? "ended",
          createdAt: 0,
          updatedAt: NOW - endedDaysAgo * DAY,
        }),
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: id,
          runnerId: "runner",
          workspaceId: "workspace",
          generation: 1,
          runnerFence: 0,
          commandId: `command-${id}`,
          leaseUntil: 0,
          endedAt: options.workEnded === false ? null : 0,
        }),
      ...Array.from(
        { length: Math.ceil(events / 1000) },
        (_, chunk) => (q: Q) =>
          q.orm.insert(q.t.runnerEvent).values(
            Array.from({ length: Math.min(1000, events - chunk * 1000) }, (_row, index) => ({
              runId: id,
              generation: 1,
              sequence: chunk * 1000 + index + 1,
              payload: "sealed",
              receivedAt: 0,
              keyId: "key",
              type: options.types?.[chunk * 1000 + index] ?? "progress",
            })),
          ),
      ),
    );
  const item = (id: string, state: string, runId: string) =>
    seed(db, (q) =>
      q.orm.insert(q.t.workItem).values({
        id,
        delegationId: "d",
        linearIssueId: id,
        linearIdentifier: id,
        title: "t",
        state,
        branchName: `paws/${id}`,
        position: 0,
        createdAt: 0,
        currentRunId: runId,
      }),
    );
  const ask = (runId: string) =>
    seed(db, (q) =>
      q.orm
        .update(q.t.runnerEvent)
        .set({ type: "question" })
        .where(and(eq(q.t.runnerEvent.runId, runId), eq(q.t.runnerEvent.sequence, 2))),
    );
  const types = async (runId: string) =>
    (
      await db.run((q) =>
        q.all(
          q.orm
            .select({ type: q.t.runnerEvent.type })
            .from(q.t.runnerEvent)
            .where(eq(q.t.runnerEvent.runId, runId))
            .orderBy(q.t.runnerEvent.sequence),
        ),
      )
    ).map((row) => row.type);
  const count = async (runId: string) => (await types(runId)).length;
  const runs = async () => (await db.run((q) => q.all(q.orm.select().from(q.t.run)))).length;
  return {
    db,
    close,
    run,
    item,
    ask,
    count,
    types,
    runs,
  };
}

test("the prune deletes events of runs that ended over a week ago and keeps the rest", async () => {
  const { db, close, run, item, ask, count, runs } = await setup();
  await run("old", 8, 3);
  await run("lost", 30, 2, { status: "lost" });
  await run("recent", 6, 3);
  await run("active", 30, 2, { status: "active" });
  await run("current", 30, 2);
  await item("open", "awaiting_input", "current");
  await run("finished", 30, 2);
  await item("done", "merged", "finished");
  await run("open-work", 30, 2, { workEnded: false });
  await run("asked", 30, 3);
  await ask("asked");
  await run("answered", 30, 3);
  await ask("answered");
  await seed(db, (q) =>
    q.orm
      .insert(q.t.runnerQuestionAnswer)
      .values({ runId: "answered", generation: 1, sequence: 2, answer: "yes", createdAt: 0 }),
  );

  expect(await pruneRunnerEvents({ store: db, now: NOW })).toEqual({ deleted: 9 });
  expect(await count("old")).toBe(0);
  expect(await count("lost")).toBe(0);
  expect(await count("finished")).toBe(0);
  expect(await count("recent")).toBe(3);
  expect(await count("active")).toBe(2);
  expect(await count("current")).toBe(2);
  expect(await count("open-work")).toBe(2);
  expect(await count("asked")).toBe(3);
  expect(await count("answered")).toBe(1);
  expect(await runs()).toBe(9);

  expect(await pruneRunnerEvents({ store: db, now: NOW })).toEqual({ deleted: 0 });
  await close();
});

test("the prune deletes at most 5,000 events per transaction", async () => {
  const { db, close, run, count } = await setup();
  await run("big", 8, 12_001);
  const batches: number[] = [];
  expect(
    await pruneRunnerEvents({
      store: db,
      now: NOW,
      onBatch: (deleted) => batches.push(deleted),
    }),
  ).toEqual({ deleted: 12_001 });
  expect(batches).toEqual([5_000, 5_000, 2_001]);
  expect(await count("big")).toBe(0);
  await close();
});

test("the prune deletes activity events of runs that ended over a day ago and keeps the rest", async () => {
  const { db, close, run, item, ask, types } = await setup();
  const HOUR = DAY / 24;
  const mixed = ["activity", "closeout", "activity", "progress", "activity"];
  await run("day-old", 25 / 24, 5, { types: mixed });
  await run("fresh", 23 / 24, 5, { types: mixed });
  await run("asked", 2, 5, { types: mixed });
  await ask("asked");
  await run("current", 2, 5, { types: mixed });
  await item("open", "running", "current");
  await run("open-work", 2, 5, { types: mixed, workEnded: false });

  expect(await pruneRunnerEvents({ store: db, now: NOW })).toEqual({ deleted: 3 });
  expect(await types("day-old")).toEqual(["closeout", "progress"]);
  expect(await types("fresh")).toEqual(mixed);
  expect(await types("asked")).toEqual([
    "activity",
    "question",
    "activity",
    "progress",
    "activity",
  ]);
  expect(await types("current")).toEqual(mixed);
  expect(await types("open-work")).toEqual(mixed);

  expect(await pruneRunnerEvents({ store: db, now: NOW + 2 * HOUR })).toEqual({ deleted: 3 });
  expect(await types("fresh")).toEqual(["closeout", "progress"]);
  await close();
});
