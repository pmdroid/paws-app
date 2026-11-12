import { expect, test } from "bun:test";
import { JOB_KIND, queueLine } from "../src/core";
import {
  applyWorkItemEvent,
  enqueueJob,
  getQueuePosition,
  insertQueuedItem,
  insertRun,
  putWorkspaceUser,
  runnerSlotFree,
  syncWorkspaceMember,
  listWorkItems,
  type Db,
} from "../src/db";
import { eq } from "drizzle-orm";
import { json, seed } from "./dialects";
import { workspaceDispatchPg as workspaceDispatch } from "./fake-workspace";
import { tempStore } from "./pglite";

const NOW = 1_000;
const READY = ["next-1", "next-2", "next-3", "next-4"];

const workspaceRow = (db: Db) =>
  seed(db, (q) =>
    q.orm
      .insert(q.t.workspace)
      .values({ id: "ws-1", linearOrganizationId: "org-1", name: "Workspace", createdAt: 0 }),
  );

const runnerRow = (db: Db, id: string, ownerUserId: string, capacity: number) =>
  seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id,
        workspaceId: "ws-1",
        ownerUserId,
        name: id,
        status: "active",
        createdAt: 0,
        lastSeenAt: NOW,
      }),
    (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: id, capacity }),
  );

const ended = (db: Db, runId: string) =>
  seed(db, (q) =>
    q.orm
      .update(q.t.runnerWork)
      .set({ endedAt: NOW + 2, teardownConfirmedAt: NOW + 2 })
      .where(eq(q.t.runnerWork.runId, runId)),
  );

const locked = (db: Db, id: number, payload?: unknown) =>
  seed(db, (q) =>
    q.orm
      .update(q.t.job)
      .set({
        status: "running",
        lockedBy: "worker",
        lockedUntil: NOW + 60_000,
        ...(payload === undefined ? {} : { payload: json(db, payload) }),
      })
      .where(eq(q.t.job.id, id)),
  );

async function fixture() {
  const { db, close } = await tempStore();
  const userId = await putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "user-linear",
    name: "Owner",
    email: "owner@example.invalid",
  });
  await workspaceRow(db);
  await syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now: 0,
  });
  for (const [id, capacity] of [
    ["goldbox", 2],
    ["agentbox", 3],
  ] as const) {
    await runnerRow(db, id, userId, capacity);
  }
  async function running(id: string) {
    await insertQueuedItem(db, { id, now: 0 });
    await applyWorkItemEvent(db, id, "dispatched");
    const run = await insertRun(db, { itemId: id, now: 0, status: "active" });
    const job = await enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: id },
      runAt: NOW + 60_000,
      now: 0,
    });
    return { runId: run.id, job };
  }
  async function placed(id: string) {
    const { runId } = await running(id);
    await seed(db, (q) =>
      q.orm.insert(q.t.runnerWork).values({
        runId,
        runnerId: "goldbox",
        workspaceId: "ws-1",
        generation: 1,
        runnerFence: 0,
        commandId: `cmd-${id}`,
        leaseUntil: NOW + 60_000,
      }),
    );
    return runId;
  }
  await placed("placed-1");
  const second = await placed("placed-2");
  const stuck = [];
  for (const id of ["stuck-1", "stuck-2", "stuck-3"]) stuck.push((await running(id)).job);
  for (const [index, id] of READY.entries()) await insertQueuedItem(db, { id, now: index + 1 });
  return { db, close, second, stuck };
}

test("work running without a runner placement leaves its slot free for the next task", async () => {
  const { db, close, second } = await fixture();
  try {
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["next-1", "next-2", "next-3"]);
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual([]);
    await ended(db, second);
    await seed(db, (q) =>
      q.orm.update(q.t.run).set({ status: "ended" }).where(eq(q.t.run.id, second)),
    );
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual(["next-4"]);
  } finally {
    await close();
  }
});

test("a task between its run and Closeout keeps its runner slot until the run ends", async () => {
  const { db, close, second } = await fixture();
  try {
    expect(await workspaceDispatch(db, { now: NOW })).toHaveLength(3);
    await ended(db, second);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(await runnerSlotFree(db, ["goldbox"], NOW + 2)).toBe(false);
    await seed(db, (q) =>
      q.orm.update(q.t.run).set({ status: "ended" }).where(eq(q.t.run.id, second)),
    );
    expect(await runnerSlotFree(db, ["goldbox"], NOW + 3)).toBe(true);
    expect(await workspaceDispatch(db, { now: NOW + 3 })).toEqual(["next-4"]);
  } finally {
    await close();
  }
});

test("a task waiting for CI between its run and Closeout frees its runner slot", async () => {
  const { db, close, second } = await fixture();
  try {
    expect(await workspaceDispatch(db, { now: NOW })).toHaveLength(3);
    await ended(db, second);
    const recheck = await enqueueJob(db, {
      queue: JOB_KIND.resume,
      payload: { itemId: "placed-2" },
      now: NOW + 2,
    });
    await locked(db, recheck, {
      itemId: "placed-2",
      awakeWait: { kind: "ci", worker: "worker", attempt: 0 },
    });
    expect(await runnerSlotFree(db, ["goldbox"], NOW + 2)).toBe(true);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual(["next-4"]);
    await locked(db, recheck, { itemId: "placed-2" });
    expect(await runnerSlotFree(db, ["goldbox"], NOW + 3)).toBe(false);
  } finally {
    await close();
  }
});

test("a placement in progress holds a slot until its run reaches a runner", async () => {
  const { db, close, stuck } = await fixture();
  try {
    await locked(db, stuck[0]!);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual(["next-1", "next-2"]);
  } finally {
    await close();
  }
});

test("the queue line reports the slots the scheduler counts as busy", async () => {
  const { db, close } = await fixture();
  try {
    const admitted = await workspaceDispatch(db, { now: NOW });
    const position = await getQueuePosition(db, "next-4");
    expect(position).toMatchObject({ busySlots: 2 + admitted.length, totalSlots: 5 });
    expect(queueLine(position!)).toBe("Queued, 1st in line. 5 of 5 runner slots are busy.");
  } finally {
    await close();
  }
});

test("twelve items ready at once on ten slots start ten and leave two queued", async () => {
  const { db, close } = await tempStore();
  try {
    const userId = await putWorkspaceUser(db, {
      id: "user-1",
      linearUserId: "user-linear",
      name: "Owner",
      email: "owner@example.invalid",
    });
    await workspaceRow(db);
    await syncWorkspaceMember(db, {
      workspaceId: "ws-1",
      userId,
      role: "admin",
      active: true,
      teamIds: [],
      now: 0,
    });
    for (const [id, capacity] of [
      ["goldbox", 6],
      ["agentbox", 4],
    ] as const) {
      await runnerRow(db, id, userId, capacity);
    }
    const ids = Array.from({ length: 12 }, (_, index) => `burst-${index + 10}`);
    for (const [index, id] of ids.entries()) await insertQueuedItem(db, { id, now: index + 1 });
    const admitted = await workspaceDispatch(db, { now: NOW });
    expect(admitted).toEqual(ids.slice(0, 10));
    // A second pass before anything is placed finds no slot either.
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual([]);
    const states = await listWorkItems(db);
    expect(states.every(({ state }) => state === "queued")).toBe(true);
  } finally {
    await close();
  }
});
