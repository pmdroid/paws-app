import { afterEach, expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import { itemActivityFactsSteps, usagePauseSteps, type Db, type Q } from "../src/db";
import {
  forEachDialect,
  insertWorkItem,
  json,
  seed,
  withoutForeignKeys,
  type DialectDb,
} from "./dialects";

const opened: DialectDb[] = [];
afterEach(async () => {
  for (const handle of opened.splice(0)) await handle.close();
});

async function connect(open: () => Promise<DialectDb>): Promise<Db> {
  const handle = await open();
  opened.push(handle);
  await insertWorkItem(handle.db, "a");
  await withoutForeignKeys(handle.db);
  return handle.db;
}

const runner = (id: string, name: string) => (q: Q) =>
  q.orm.insert(q.t.runner).values({
    id,
    workspaceId: "acme",
    ownerUserId: "owner",
    name,
    status: "active",
    createdAt: 0,
  });

const job =
  (db: Db, queue: string, payload: unknown, fields: Record<string, unknown> = {}) =>
  (q: Q) =>
    q.orm
      .insert(q.t.job)
      .values({ queue, payload: json(db, payload), runAt: 0, createdAt: 0, ...fields });

const pause = {
  runId: "r",
  itemId: "a",
  agent: "codex",
  runnerId: "box",
  resetsAt: null,
  resumeAt: 50,
  pausedAt: 10,
};

forEachDialect((open) => {
  test("an idle item has no activity", async () => {
    const db = await connect(open);
    expect(
      await db.run((q) => itemActivityFactsSteps(q, { id: "a", currentRunId: null }, 100)),
    ).toEqual({
      liveRunner: null,
      pinnedRunner: null,
      liveJob: false,
      slotWait: null,
      usagePause: null,
      heldSince: null,
    });
  });

  test("a run's runner, usage pause, hold and claimed job are reported", async () => {
    const db = await connect(open);
    await seed(
      db,
      runner("box", "Box"),
      (q) =>
        q.orm.insert(q.t.runnerWork).values({
          runId: "r",
          runnerId: "box",
          workspaceId: "acme",
          generation: 1,
          runnerFence: 1,
          commandId: "c",
          leaseUntil: 1_000_000,
        }),
      (q) => q.orm.insert(q.t.usagePause).values(pause),
      (q) => q.orm.insert(q.t.itemWait).values({ itemId: "a", version: 1, since: 7 }),
      job(db, JOB_KIND.resume, { itemId: "a" }, { status: "running", lockedUntil: 200 }),
      job(db, JOB_KIND.start, { itemId: "other" }, { status: "running", lockedUntil: 200 }),
    );
    expect(await db.run((q) => usagePauseSteps(q, "r"))).toEqual(pause);
    expect(await db.run((q) => usagePauseSteps(q, "none"))).toBeNull();
    expect(
      await db.run((q) => itemActivityFactsSteps(q, { id: "a", currentRunId: "r" }, 100)),
    ).toEqual({
      liveRunner: "Box",
      pinnedRunner: "Box",
      liveJob: true,
      slotWait: null,
      usagePause: pause,
      heldSince: 7,
    });
  });

  test("an ended run pins its runner without being live", async () => {
    const db = await connect(open);
    await seed(db, runner("box", "Box"), (q) =>
      q.orm.insert(q.t.runnerWork).values({
        runId: "r",
        runnerId: "box",
        workspaceId: "acme",
        generation: 1,
        runnerFence: 1,
        commandId: "c",
        leaseUntil: 1_000_000,
        endedAt: 5,
      }),
    );
    const facts = await db.run((q) =>
      itemActivityFactsSteps(q, { id: "a", currentRunId: "r" }, 100),
    );
    expect(facts).toMatchObject({ liveRunner: null, pinnedRunner: "Box" });
  });

  test("an unclaimed job waiting for runner capacity names the runners", async () => {
    const db = await connect(open);
    await seed(
      db,
      runner("box", "Box"),
      job(db, `${JOB_KIND.reverify}.closeout`, {
        itemId: "a",
        capacityWait: { since: 3, attempt: 1, runnerIds: ["box", "gone"] },
      }),
    );
    const facts = await db.run((q) =>
      itemActivityFactsSteps(q, { id: "a", currentRunId: null }, 100),
    );
    expect(facts.slotWait).toEqual({ since: 3, runners: ["Box", "gone"] });
    expect(facts.liveJob).toBe(false);
  });

  test("a claimed job waiting for a runner reports a slot wait without a start", async () => {
    const db = await connect(open);
    await seed(
      db,
      job(
        db,
        JOB_KIND.start,
        { itemId: "a", awakeWait: { kind: "runner", worker: "w", attempt: 2 } },
        { status: "running", lockedUntil: 200, lockedBy: "w", attempts: 2 },
      ),
    );
    const facts = await db.run((q) =>
      itemActivityFactsSteps(q, { id: "a", currentRunId: null }, 100),
    );
    expect(facts).toMatchObject({ liveJob: false, slotWait: { since: null, runners: [] } });
  });
});
