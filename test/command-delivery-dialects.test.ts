import { afterEach, expect, test } from "bun:test";
import type { LinearCommand } from "../src/core";
import {
  commandDeliveryQueue,
  drainInstanceCommandsAsync,
  enqueueJobAsync,
  forwardCommandSteps,
  getJobSteps,
  listJobsSteps,
  type Db,
} from "../src/db";
import { forEachDialect, insertWorkItem, seed, type DialectDb } from "./dialects";

const handles: DialectDb[] = [];
afterEach(async () => {
  for (const handle of handles.splice(0)) await handle.close();
});

const stop: LinearCommand = { type: "stop", source: "linear", itemId: "item", requestedAt: 50 };

async function owned(db: Db) {
  await insertWorkItem(db, "item");
  const instance = (id: string, heartbeatAt: number) => ({
    id,
    role: "all",
    host: id,
    startedAt: 0,
    heartbeatAt,
  });
  const run = (id: string) => ({
    id,
    itemId: "item",
    kind: "agent",
    agent: "codex",
    status: "active",
    createdAt: 0,
    updatedAt: 0,
  });
  await seed(
    db,
    (q) =>
      q.orm
        .insert(q.t.instance)
        .values([instance("self", 100_000), instance("peer", 100_000), instance("gone", 0)]),
    (q) => q.orm.insert(q.t.run).values([run("r1"), run("r2"), run("r3"), run("r4")]),
    (q) =>
      q.orm.insert(q.t.runOwner).values([
        { runId: "r1", ownerInstance: "self" },
        { runId: "r2", ownerInstance: "peer" },
        { runId: "r3", ownerInstance: "peer" },
        { runId: "r4", ownerInstance: "gone" },
      ]),
  );
}

forEachDialect((open) => {
  test("a command is forwarded once to each other live owner of the item's runs", async () => {
    const handle = await open();
    handles.push(handle);
    const { db } = handle;
    await owned(db);
    const forward = () => db.transaction((q) => forwardCommandSteps(q, "self", stop, 100_000));
    expect(await forward()).toEqual({ owners: ["peer"], inserted: true });
    expect(await forward()).toEqual({ owners: ["peer"], inserted: false });
    const jobs = await db.run(listJobsSteps);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({
      queue: commandDeliveryQueue("peer"),
      priority: 0,
      payload: { command: stop, stoppedAtVersion: 0 },
    });
    expect(
      await db.transaction((q) =>
        forwardCommandSteps(q, "self", { ...stop, itemId: "missing" }, 100_000),
      ),
    ).toEqual({ owners: [], inserted: false });
  });

  test("an instance drains its delivered commands and skips malformed ones", async () => {
    const handle = await open();
    handles.push(handle);
    const { db } = handle;
    await owned(db);
    await db.transaction((q) => forwardCommandSteps(q, "self", stop, 100_000));
    const malformed = await enqueueJobAsync(db, {
      queue: commandDeliveryQueue("peer"),
      payload: { command: { type: "nonsense" } },
      now: 100_000,
    });
    const delivered: unknown[] = [];
    const count = await drainInstanceCommandsAsync(
      db,
      "peer",
      (delivery) => delivered.push(delivery),
      100_000,
    );
    expect(count).toBe(1);
    expect(delivered).toEqual([{ command: stop, stoppedAtVersion: 0 }]);
    expect(await db.run((q) => getJobSteps(q, malformed))).toMatchObject({ status: "done" });
    expect(await drainInstanceCommandsAsync(db, "peer", () => {}, 100_000)).toBe(0);
  });
});
