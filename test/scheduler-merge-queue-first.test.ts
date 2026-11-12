import { expect, test } from "bun:test";
import { JOB_KIND } from "../src/core";
import {
  applyWorkItemEvent,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  insertRun,
  joinMergeQueue,
  pinnedSlotsReserved,
  putWorkspaceUser,
  restart,
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

// Runners A and B have one slot each, both held by busy work. N is queued with the highest Linear
// priority. Merge-queue items join with `mergeItem`.
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
  const work = (runId: string, runnerId: string, ended: number | null) =>
    exec(
      db,
      sql`INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at,teardown_confirmed_at) VALUES(${runId},${runnerId},'ws-1',1,0,${`cmd-${runId}`},${NOW + 60_000},${ended},${ended})`,
    );
  const busy = new Map<string, string>();
  for (const runnerId of ["A", "B"]) {
    await exec(
      db,
      sql`INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(${runnerId},'ws-1',${userId},${runnerId},'active',0,${NOW})`,
    );
    await exec(db, sql`INSERT INTO runner_capacity(runner_id,capacity) VALUES(${runnerId},1)`);
    const itemId = `busy-${runnerId}`;
    await insertQueuedItem(db, { id: itemId, now: 0 });
    await applyWorkItemEvent(db, itemId, "dispatched");
    const runId = (await insertRun(db, { itemId, now: 0, status: "active" })).id;
    await work(runId, runnerId, null);
    busy.set(runnerId, runId);
  }

  await insertQueuedItem(db, { id: "N", now: 1 });
  await db.run((q) => saveSchedulingContextSteps(q, { itemId: "N", priority: 1 }));

  /** An item that Closeout accepted, ran on A and joined the merge queue at `readyAt`. */
  const mergeItem = async (id: string, readyAt: number) => {
    await insertQueuedItem(db, { id, now: 2 });
    await db.run((q) => saveSchedulingContextSteps(q, { itemId: id, priority: 4 }));
    await applyWorkItemEvent(db, id, "dispatched");
    const runId = (await insertRun(db, { itemId: id, now: 2, status: "ended" })).id;
    await exec(db, sql`UPDATE work_item SET current_run_id=${runId} WHERE id=${id}`);
    await work(runId, "A", NOW - 1);
    await applyWorkItemEvent(db, id, "turn_ended");
    await applyWorkItemEvent(db, id, "closeout_accepted");
    await joinMergeQueue(db, { itemId: id, repository: "acme/app", now: readyAt });
    return runId;
  };
  /** The item re-verifies; its job waits for a slot on `runnerIds`, all busy. */
  const reverify = async (id: string, runnerIds: string[]) => {
    await applyWorkItemEvent(db, id, "reverify_requested");
    return await enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: {
        itemId: id,
        capacityWait: { since: NOW - 60_000, attempt: 2, runnerIds },
      },
      runAt: BACKOFF,
      now: NOW - 60_000,
    });
  };
  const runAt = async (jobId: number) =>
    (await db.run((q) =>
      q.one(q.orm.select({ runAt: q.t.job.runAt }).from(q.t.job).where(eq(q.t.job.id, jobId))),
    ))!.runAt;
  const free = async (runnerId: string, at: number) => {
    const runId = busy.get(runnerId)!;
    await exec(
      db,
      sql`UPDATE runner_work SET ended_at=${at},teardown_confirmed_at=${at} WHERE run_id=${runId}`,
    );
    await exec(db, sql`UPDATE run SET status='ended' WHERE id=${runId}`);
  };
  return { db, close, mergeItem, reverify, runAt, free };
}

test("a freed slot goes to the merge-queue re-verify, not to a queued item with a higher priority", async () => {
  const { db, close, mergeItem, reverify, runAt, free } = await fixture();
  try {
    await mergeItem("M", NOW - 120_000);
    const job = await reverify("M", ["A", "B"]);
    expect(await workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(await runAt(job)).toBe(BACKOFF);
    // The re-verify is not pinned: B's freed slot is its, and N keeps waiting.
    await free("B", NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(await runAt(job)).toBe(NOW + 2);
    expect(await pinnedSlotsReserved(db, "B", "N", NOW + 2)).toBe(1);
    expect(await pinnedSlotsReserved(db, "A", "N", NOW + 2)).toBe(0);
    expect(await workspaceDispatch(db, { now: NOW + 3 })).toEqual([]);
  } finally {
    await close();
  }
});

test("the first item in merge order gets the freed slot first", async () => {
  const { db, close, mergeItem, reverify, runAt, free } = await fixture();
  try {
    await mergeItem("second", NOW - 60_000);
    await mergeItem("first", NOW - 120_000);
    const later = await reverify("second", ["A", "B"]);
    const earlier = await reverify("first", ["A", "B"]);
    await free("A", NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(await runAt(earlier)).toBe(NOW + 2);
    expect(await runAt(later)).toBe(BACKOFF);
    await free("B", NOW + 3);
    expect(await workspaceDispatch(db, { now: NOW + 4 })).toEqual([]);
    expect(await runAt(later)).toBe(NOW + 4);
  } finally {
    await close();
  }
});

test("a pinned merge-queue wait keeps to its runner, ahead of a queued item with a higher priority", async () => {
  const { db, close, mergeItem, reverify, runAt, free } = await fixture();
  try {
    await mergeItem("M", NOW - 120_000);
    const job = await reverify("M", ["A"]);
    // B frees: M's agent turn is pinned to A, so N may take B.
    await free("B", NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual(["N"]);
    expect(await runAt(job)).toBe(BACKOFF);
    expect(await pinnedSlotsReserved(db, "A", "N", NOW + 2)).toBe(1);
  } finally {
    await close();
  }
});

test("a conflict fix sent back from the merge queue is admitted before a queued item with a higher priority", async () => {
  const { db, close, mergeItem, free } = await fixture();
  try {
    await mergeItem("M", NOW - 120_000);
    // M's owner already runs both busy items; N's owner runs nothing.
    await exec(
      db,
      sql`UPDATE work_item SET owner_user_id='user-1' WHERE id IN ('M','busy-A','busy-B')`,
    );
    await restart(db, (await getWorkItem(db, "M"))!, {
      reason: "conflict",
      body: "Resolve conflicts",
      now: NOW,
    });
    expect(await workspaceDispatch(db, { now: NOW + 1 })).toEqual([]);
    await free("A", NOW + 2);
    expect(await workspaceDispatch(db, { now: NOW + 3 })).toEqual(["M"]);
  } finally {
    await close();
  }
});

test("findings from a merge-queue re-verify send the fix ahead of a queued item with a higher priority", async () => {
  const { db, close, mergeItem, free } = await fixture();
  try {
    await mergeItem("M", NOW - 120_000);
    await applyWorkItemEvent(db, "M", "reverify_requested");
    await restart(db, (await getWorkItem(db, "M"))!, {
      reason: "findings",
      body: "Fix findings",
      now: NOW,
    });
    await free("A", NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual(["M"]);
  } finally {
    await close();
  }
});

test("a fix sent back by a first Closeout keeps the usual order", async () => {
  const { db, close, free } = await fixture();
  try {
    await insertQueuedItem(db, { id: "F", now: 2 });
    await db.run((q) => saveSchedulingContextSteps(q, { itemId: "F", priority: 4 }));
    await applyWorkItemEvent(db, "F", "dispatched");
    await applyWorkItemEvent(db, "F", "turn_ended");
    await restart(db, (await getWorkItem(db, "F"))!, {
      reason: "findings",
      body: "Fix findings",
      now: NOW,
    });
    await free("A", NOW + 1);
    expect(await workspaceDispatch(db, { now: NOW + 2 })).toEqual(["N"]);
  } finally {
    await close();
  }
});
