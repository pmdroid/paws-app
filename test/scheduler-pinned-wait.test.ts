import { expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  enqueueJob,
  insertQueuedItem,
  insertRun,
  pinnedSlotsReserved,
  putWorkspaceUser,
  releasePinnedSlot,
  runnerHasCapacity,
  syncWorkspaceMember,
  type Db,
} from "../src/db";
import { eq, sql, type SQL } from "drizzle-orm";
import { saveSchedulingContextSteps } from "../src/scheduler";
import { workspaceDispatchPg as workspaceDispatch } from "./fake-workspace";
import { tempStore } from "./pglite";

const NOW = 1_000_000;
const BACKOFF = NOW + 4 * 60_000;

const exec = (db: Db, query: SQL) => db.run((q) => q.exec(q.orm.execute(query)));

// Runner A has one slot, held by `busy`. X resumes pinned to A and waits for that slot on its
// backoff; Y is queued with a lower priority and no dependents.
async function fixture() {
  const { db, close } = await tempStore();
  const userId = await putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "user-linear",
    name: "Owner",
    email: "owner@example.invalid",
  });
  await exec(db, sql`INSERT INTO workspace VALUES('ws-1','org-1','Workspace',0)`);
  await syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now: 0,
  });
  await exec(
    db,
    sql`INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('A','ws-1',${userId},'A','active',0,${NOW})`,
  );
  await exec(db, sql`INSERT INTO runner_capacity(runner_id,capacity) VALUES('A',1)`);
  const work = (runId: string, ended: number | null) =>
    exec(
      db,
      sql`INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at,teardown_confirmed_at) VALUES(${runId},'A','ws-1',1,0,${`cmd-${runId}`},${NOW + 60_000},${ended},${ended})`,
    );

  await insertQueuedItem(db, { id: "busy", now: 0 });
  await applyWorkItemEvent(db, "busy", "dispatched");
  const busy = (await insertRun(db, { itemId: "busy", now: 0, status: "active" })).id;
  await work(busy, null);

  await insertQueuedItem(db, { id: "X", now: 1 });
  await db.run((q) => saveSchedulingContextSteps(q, { itemId: "X", priority: 1 }));
  await applyWorkItemEvent(db, "X", "dispatched");
  const lost = (await insertRun(db, { itemId: "X", now: 1, status: "lost" })).id;
  await exec(db, sql`UPDATE work_item SET current_run_id=${lost} WHERE id='X'`);
  await work(lost, NOW - 1);
  await applyWorkItemEvent(db, "X", "lease_expired");
  const resume = await enqueueJob(db, {
    queue: JOB_KIND.resume,
    payload: {
      itemId: "X",
      runId: lost,
      reason: "transient_failure",
      retry: 0,
      capacityWait: { since: NOW - 60_000, attempt: 2, runnerIds: ["A"] },
    },
    runAt: BACKOFF,
    now: NOW - 60_000,
  });

  await insertQueuedItem(db, { id: "Y", now: 2 });
  await db.run((q) => saveSchedulingContextSteps(q, { itemId: "Y", priority: 4 }));

  const runAt = async () =>
    (await db.run((q) =>
      q.one(q.orm.select({ runAt: q.t.job.runAt }).from(q.t.job).where(eq(q.t.job.id, resume))),
    ))!.runAt;
  const free = async (at: number) => {
    await exec(
      db,
      sql`UPDATE runner_work SET ended_at=${at},teardown_confirmed_at=${at} WHERE run_id=${busy}`,
    );
    await exec(db, sql`UPDATE run SET status='ended' WHERE id=${busy}`);
  };
  return { db, close, runAt, free };
}

test("a freed slot on the pinned runner goes to the item waiting on it, not to a queued item", async () => {
  const { db, close, runAt, free } = await fixture();
  try {
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(await runAt()).toBe(BACKOFF);
    await free(NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(await runAt()).toBe(NOW + 2);
    // The wake stands until X's job runs; Y keeps waiting meanwhile.
    expect(await workspaceDispatch(db, { now: NOW + 3 })).toEqual([]);
    expect(await runAt()).toBe(NOW + 2);
  } finally {
    await close();
  }
});

test("a queued item ranked ahead of the waiting item takes the freed slot", async () => {
  const { db, close, runAt, free } = await fixture();
  try {
    await db.run((q) => saveSchedulingContextSteps(q, { itemId: "Y", priority: 1 }));
    await db.run((q) => saveSchedulingContextSteps(q, { itemId: "X", priority: 4 }));
    await free(NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual(["Y"]);
    expect(await runAt()).toBe(BACKOFF);
  } finally {
    await close();
  }
});

test("a wait on an offline pinned runner reserves nothing", async () => {
  const { db, close, runAt } = await fixture();
  try {
    await exec(
      db,
      sql`INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('B','ws-1','user-1','B','active',0,${NOW + 120_000})`,
    );
    await exec(db, sql`UPDATE runner SET last_seen_at=0 WHERE id='A'`);
    expect(await workspaceDispatch(db, { now: NOW + 120_000 })).toEqual(["Y"]);
    expect(await runAt()).toBe(BACKOFF);
  } finally {
    await close();
  }
});

test("a wait past its hold reserves nothing", async () => {
  const { db, close, runAt, free } = await fixture();
  try {
    await exec(
      db,
      sql`UPDATE job SET payload=jsonb_set(payload,'{capacityWait,holdMs}','1000') WHERE queue=${JOB_KIND.resume}`,
    );
    await free(NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual(["Y"]);
    expect(await runAt()).toBe(BACKOFF);
  } finally {
    await close();
  }
});

test("with another runner free, the waiting item's slot stays off limits to the queued item", async () => {
  const { db, close, runAt, free } = await fixture();
  try {
    await exec(
      db,
      sql`INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('B','ws-1','user-1','B','active',0,${NOW})`,
    );
    await free(NOW + 1);
    // A and B each have a free slot: X is woken for A, and Y is admitted for B.
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual(["Y"]);
    expect(await runAt()).toBe(NOW + 2);
    // Placement keeps Y off A while X holds A's slot, and gives X its own slot.
    const reserved = await pinnedSlotsReserved(db, "A", "Y", NOW + 2);
    expect(reserved).toBe(1);
    expect(await runnerHasCapacity(db, "A", NOW + 2, "", reserved)).toBe(false);
    expect(await pinnedSlotsReserved(db, "B", "Y", NOW + 2)).toBe(0);
    expect(await pinnedSlotsReserved(db, "A", "X", NOW + 2)).toBe(0);
    // Once X is placed the reservation is gone.
    await releasePinnedSlot(db, "X");
    expect(await pinnedSlotsReserved(db, "A", "Y", NOW + 2)).toBe(0);
  } finally {
    await close();
  }
});

test("a waiting item ranked behind a queued item that took the last slot reserves nothing", async () => {
  const { db, close, runAt, free } = await fixture();
  try {
    await db.run((q) => saveSchedulingContextSteps(q, { itemId: "Y", priority: 1 }));
    await db.run((q) => saveSchedulingContextSteps(q, { itemId: "X", priority: 4 }));
    await free(NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual(["Y"]);
    expect(await pinnedSlotsReserved(db, "A", "Y", NOW + 2)).toBe(0);
    expect(await runAt()).toBe(BACKOFF);
  } finally {
    await close();
  }
});

test("a waiting item on a full runner holds the slot that frees next", async () => {
  const { db, close } = await fixture();
  try {
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(await pinnedSlotsReserved(db, "A", "Y", NOW)).toBe(1);
  } finally {
    await close();
  }
});

test("a reservation is released when its runner goes offline", async () => {
  const { db, close } = await fixture();
  try {
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(await pinnedSlotsReserved(db, "A", "Y", NOW)).toBe(1);
    await exec(db, sql`UPDATE runner SET last_seen_at=0 WHERE id='A'`);
    await workspaceDispatch(db, { now: NOW + 120_000 });
    expect(await pinnedSlotsReserved(db, "A", "Y", NOW + 120_000)).toBe(0);
  } finally {
    await close();
  }
});
