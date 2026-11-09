import { afterEach, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import {
  enqueueJobSteps,
  getJobSteps,
  getRunSteps,
  getWorkItemSteps,
  haltSteps,
  type Db,
} from "../src/db";
import {
  forEachDialect,
  insertWorkItem,
  seed,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";
import { seedResult, seedRun, seedRunner, seedWork } from "./runner-rows";

const open: DialectDb[] = [];
afterEach(async () => {
  for (const handle of open.splice(0)) await handle.close();
});

const NOW = 1_000_000;

/** An item on run `run`, with an open job, a scheduler admission and a merge queue place. */
async function haltable(db: Db, kept = 0) {
  await insertWorkItem(db, "item");
  await seedRunner(db, "box");
  await seedRun(db, "run", "item");
  await seedWork(db, "run", "box");
  await seed(
    db,
    (q) =>
      q.orm.update(q.t.workItem).set({ currentRunId: "run" }).where(eq(q.t.workItem.id, "item")),
    (q) =>
      q.orm.insert(q.t.runnerWorkGrant).values({
        tokenHash: "token",
        runId: "run",
        generation: 1,
        expiresAt: 100,
      }),
    (q) =>
      q.orm
        .insert(q.t.mergeQueueEntry)
        .values({ itemId: "item", repository: "acme/app", readyAt: 0, lane: "main", kept }),
  );
  const job = await db.run((q) =>
    enqueueJobSteps(q, { queue: "work", payload: { itemId: "item" }, now: 0 }),
  );
  await seed(db, (q) =>
    q.orm.insert(q.t.schedulerAdmission).values({
      itemId: "item",
      jobId: job,
      projectKey: "p",
      repositoryKey: "r",
      paths: (q.dialect === "sqlite" ? "[]" : []) as string[],
      hot: 0,
      createdAt: 0,
    }),
  );
  return { job, item: (await db.run((q) => getWorkItemSteps(q, "item")))! };
}

function observed(db: Db, job: number) {
  return db.run(function* (q) {
    const work = yield* q.one(
      q.orm.select().from(q.t.runnerWork).where(eq(q.t.runnerWork.runId, "run")),
    );
    return {
      version: (yield* getWorkItemSteps(q, "item"))!.version,
      job: (yield* getJobSteps(q, job))!.status,
      run: (yield* getRunSteps(q, "run"))!.status,
      workEndedAt: work!.endedAt,
      grants: (yield* q.all(q.orm.select().from(q.t.runnerWorkGrant))).length,
      admissions: (yield* q.all(q.orm.select().from(q.t.schedulerAdmission))).length,
      places: (yield* q.all(q.orm.select().from(q.t.mergeQueueEntry))).length,
    };
  });
}

forEachDialect((connect) => {
  async function start() {
    const handle = await connect();
    open.push(handle);
    await withoutForeignKeys(handle.db);
    return handle.db;
  }

  test("a halt on settled work fences the item and releases everything it held", async () => {
    const db = await start();
    const { job, item } = await haltable(db);
    await seedResult(db, "run", "command-run", {});

    const halted = await db.transaction((q) => haltSteps(q, item, NOW));

    expect(halted?.version).toBe(item.version + 1);
    expect(await observed(db, job)).toEqual({
      version: item.version + 1,
      job: "cancelled",
      run: "ended",
      workEndedAt: NOW,
      grants: 0,
      admissions: 0,
      places: 0,
    });
  });

  test("a halt keeps an unsettled runner occupied and a kept merge place", async () => {
    const db = await start();
    const { job, item } = await haltable(db, 1);

    await db.transaction((q) => haltSteps(q, item, NOW));

    expect(await observed(db, job)).toEqual({
      version: item.version + 1,
      job: "cancelled",
      run: "ended",
      workEndedAt: null,
      grants: 1,
      admissions: 0,
      places: 1,
    });
  });

  test("a stale item version halts nothing", async () => {
    const db = await start();
    const { job, item } = await haltable(db);
    const before = await observed(db, job);

    expect(
      await db.transaction((q) => haltSteps(q, { ...item, version: item.version + 1 }, NOW)),
    ).toBeNull();

    expect(await observed(db, job)).toEqual(before);
  });

  test("a caller's failure after the halt rolls the halt back", async () => {
    const db = await start();
    const { job, item } = await haltable(db);
    const before = await observed(db, job);

    await expect(
      db.transaction(function* (q) {
        yield* haltSteps(q, item, NOW);
        throw new Error("edge refused");
      }),
    ).rejects.toThrow("edge refused");

    expect(await observed(db, job)).toEqual(before);
  });
});
