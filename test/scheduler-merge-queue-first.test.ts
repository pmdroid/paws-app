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
} from "../src/db";
import { saveSchedulingContext } from "../src/scheduler";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

const NOW = 1_000_000;
const BACKOFF = NOW + 4 * 60_000;

// Runners A and B have one slot each, both held by busy work. N is queued with the highest Linear
// priority. Merge-queue items join with `mergeItem`.
function fixture() {
  const db = tempDb();
  const userId = putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "user-linear",
    name: "Owner",
    email: "owner@example.invalid",
  });
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", 0]);
  syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "owner",
    active: true,
    teamIds: [],
    now: 0,
  });
  const work = (runId: string, runnerId: string, ended: number | null) =>
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at) VALUES(?,?,'ws-1',1,0,?,?,?)",
      [runId, runnerId, `cmd-${runId}`, NOW + 60_000, ended],
    );
  const busy = new Map<string, string>();
  for (const runnerId of ["A", "B"]) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,'ws-1',?,?,'active',0,?)",
      [runnerId, userId, runnerId, NOW],
    );
    db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,1)", [runnerId]);
    const itemId = `busy-${runnerId}`;
    insertQueuedItem(db, { id: itemId, now: 0 });
    applyWorkItemEvent(db, itemId, "dispatched");
    const runId = insertRun(db, { itemId, now: 0, status: "active" }).id;
    work(runId, runnerId, null);
    busy.set(runnerId, runId);
  }

  insertQueuedItem(db, { id: "N", now: 1 });
  saveSchedulingContext(db, { itemId: "N", priority: 1 });

  /** An item that Closeout accepted, ran on A and joined the merge queue at `readyAt`. */
  const mergeItem = (id: string, readyAt: number) => {
    insertQueuedItem(db, { id, now: 2 });
    saveSchedulingContext(db, { itemId: id, priority: 4 });
    applyWorkItemEvent(db, id, "dispatched");
    const runId = insertRun(db, { itemId: id, now: 2, status: "ended" }).id;
    db.run("UPDATE work_item SET current_run_id=? WHERE id=?", [runId, id]);
    work(runId, "A", NOW - 1);
    applyWorkItemEvent(db, id, "turn_ended");
    applyWorkItemEvent(db, id, "closeout_accepted");
    joinMergeQueue(db, { itemId: id, repository: "acme/app", now: readyAt });
    return runId;
  };
  /** The item re-verifies; its job waits for a slot on `runnerIds`, all busy. */
  const reverify = (id: string, runnerIds: string[]) => {
    applyWorkItemEvent(db, id, "reverify_requested");
    return enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: {
        itemId: id,
        capacityWait: { since: NOW - 60_000, attempt: 2, runnerIds },
      },
      runAt: BACKOFF,
      now: NOW - 60_000,
    });
  };
  const runAt = (jobId: number) =>
    db.query<{ runAt: number }, [number]>("SELECT run_at AS runAt FROM job WHERE id=?").get(jobId)!
      .runAt;
  const free = (runnerId: string, at: number) => {
    db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [at, busy.get(runnerId)!]);
    db.run("UPDATE run SET status='ended' WHERE id=?", [busy.get(runnerId)!]);
  };
  return { db, mergeItem, reverify, runAt, free };
}

test("a freed slot goes to the merge-queue re-verify, not to a queued item with a higher priority", () => {
  const { db, mergeItem, reverify, runAt, free } = fixture();
  try {
    mergeItem("M", NOW - 120_000);
    const job = reverify("M", ["A", "B"]);
    expect(workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(runAt(job)).toBe(BACKOFF);
    // The re-verify is not pinned: B's freed slot is its, and N keeps waiting.
    free("B", NOW + 1);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(runAt(job)).toBe(NOW + 2);
    expect(pinnedSlotsReserved(db, "B", "N", NOW + 2)).toBe(1);
    expect(pinnedSlotsReserved(db, "A", "N", NOW + 2)).toBe(0);
    expect(workspaceDispatch(db, { now: NOW + 3 })).toEqual([]);
  } finally {
    db.close();
  }
});

test("the first item in merge order gets the freed slot first", () => {
  const { db, mergeItem, reverify, runAt, free } = fixture();
  try {
    mergeItem("second", NOW - 60_000);
    mergeItem("first", NOW - 120_000);
    const later = reverify("second", ["A", "B"]);
    const earlier = reverify("first", ["A", "B"]);
    free("A", NOW + 1);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(runAt(earlier)).toBe(NOW + 2);
    expect(runAt(later)).toBe(BACKOFF);
    free("B", NOW + 3);
    expect(workspaceDispatch(db, { now: NOW + 4 })).toEqual([]);
    expect(runAt(later)).toBe(NOW + 4);
  } finally {
    db.close();
  }
});

test("a pinned merge-queue wait keeps to its runner, ahead of a queued item with a higher priority", () => {
  const { db, mergeItem, reverify, runAt, free } = fixture();
  try {
    mergeItem("M", NOW - 120_000);
    const job = reverify("M", ["A"]);
    // B frees: M's agent turn is pinned to A, so N may take B.
    free("B", NOW + 1);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual(["N"]);
    expect(runAt(job)).toBe(BACKOFF);
    expect(pinnedSlotsReserved(db, "A", "N", NOW + 2)).toBe(1);
  } finally {
    db.close();
  }
});

test("a conflict fix sent back from the merge queue is admitted before a queued item with a higher priority", () => {
  const { db, mergeItem, free } = fixture();
  try {
    mergeItem("M", NOW - 120_000);
    // M's owner already runs both busy items; N's owner runs nothing.
    db.run("UPDATE work_item SET owner_user_id='user-1' WHERE id IN ('M','busy-A','busy-B')");
    restart(db, getWorkItem(db, "M")!, { reason: "conflict", body: "Resolve conflicts", now: NOW });
    expect(workspaceDispatch(db, { now: NOW + 1 })).toEqual([]);
    free("A", NOW + 2);
    expect(workspaceDispatch(db, { now: NOW + 3 })).toEqual(["M"]);
  } finally {
    db.close();
  }
});

test("findings from a merge-queue re-verify send the fix ahead of a queued item with a higher priority", () => {
  const { db, mergeItem, free } = fixture();
  try {
    mergeItem("M", NOW - 120_000);
    applyWorkItemEvent(db, "M", "reverify_requested");
    restart(db, getWorkItem(db, "M")!, { reason: "findings", body: "Fix findings", now: NOW });
    free("A", NOW + 1);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual(["M"]);
  } finally {
    db.close();
  }
});

test("a fix sent back by a first Closeout keeps the usual order", () => {
  const { db, free } = fixture();
  try {
    insertQueuedItem(db, { id: "F", now: 2 });
    saveSchedulingContext(db, { itemId: "F", priority: 4 });
    applyWorkItemEvent(db, "F", "dispatched");
    applyWorkItemEvent(db, "F", "turn_ended");
    restart(db, getWorkItem(db, "F")!, { reason: "findings", body: "Fix findings", now: NOW });
    free("A", NOW + 1);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual(["N"]);
  } finally {
    db.close();
  }
});
