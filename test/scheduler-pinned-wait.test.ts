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
} from "../src/db";
import { saveSchedulingContext } from "../src/scheduler";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

const NOW = 1_000_000;
const BACKOFF = NOW + 4 * 60_000;

// Runner A has one slot, held by `busy`. X resumes pinned to A and waits for that slot on its
// backoff; Y is queued with a lower priority and no dependents.
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
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('A','ws-1',?,'A','active',0,?)",
    [userId, NOW],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES('A',1)");
  const work = (runId: string, ended: number | null) =>
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,ended_at) VALUES(?,'A','ws-1',1,0,?,?,?)",
      [runId, `cmd-${runId}`, NOW + 60_000, ended],
    );

  insertQueuedItem(db, { id: "busy", now: 0 });
  applyWorkItemEvent(db, "busy", "dispatched");
  const busy = insertRun(db, { itemId: "busy", now: 0, status: "active" }).id;
  work(busy, null);

  insertQueuedItem(db, { id: "X", now: 1 });
  saveSchedulingContext(db, { itemId: "X", priority: 1 });
  applyWorkItemEvent(db, "X", "dispatched");
  const lost = insertRun(db, { itemId: "X", now: 1, status: "lost" }).id;
  db.run("UPDATE work_item SET current_run_id=? WHERE id='X'", [lost]);
  work(lost, NOW - 1);
  applyWorkItemEvent(db, "X", "lease_expired");
  const resume = enqueueJob(db, {
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

  insertQueuedItem(db, { id: "Y", now: 2 });
  saveSchedulingContext(db, { itemId: "Y", priority: 4 });

  const runAt = () =>
    db.query<{ runAt: number }, [number]>("SELECT run_at AS runAt FROM job WHERE id=?").get(resume)!
      .runAt;
  const free = (at: number) => {
    db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [at, busy]);
    db.run("UPDATE run SET status='ended' WHERE id=?", [busy]);
  };
  return { db, runAt, free };
}

test("a freed slot on the pinned runner goes to the item waiting on it, not to a queued item", () => {
  const { db, runAt, free } = fixture();
  try {
    expect(workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(runAt()).toBe(BACKOFF);
    free(NOW + 1);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(runAt()).toBe(NOW + 2);
    // The wake stands until X's job runs; Y keeps waiting meanwhile.
    expect(workspaceDispatch(db, { now: NOW + 3 })).toEqual([]);
    expect(runAt()).toBe(NOW + 2);
  } finally {
    db.close();
  }
});

test("a queued item ranked ahead of the waiting item takes the freed slot", () => {
  const { db, runAt, free } = fixture();
  try {
    saveSchedulingContext(db, { itemId: "Y", priority: 1 });
    saveSchedulingContext(db, { itemId: "X", priority: 4 });
    free(NOW + 1);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual(["Y"]);
    expect(runAt()).toBe(BACKOFF);
  } finally {
    db.close();
  }
});

test("a wait on an offline pinned runner reserves nothing", () => {
  const { db, runAt } = fixture();
  try {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('B','ws-1','user-1','B','active',0,?)",
      [NOW + 120_000],
    );
    db.run("UPDATE runner SET last_seen_at=0 WHERE id='A'");
    expect(workspaceDispatch(db, { now: NOW + 120_000 })).toEqual(["Y"]);
    expect(runAt()).toBe(BACKOFF);
  } finally {
    db.close();
  }
});

test("a wait past its hold reserves nothing", () => {
  const { db, runAt, free } = fixture();
  try {
    db.run("UPDATE job SET payload=json_set(payload,'$.capacityWait.holdMs',1000) WHERE queue=?", [
      JOB_KIND.resume,
    ]);
    free(NOW + 1);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual(["Y"]);
    expect(runAt()).toBe(BACKOFF);
  } finally {
    db.close();
  }
});

test("with another runner free, the waiting item's slot stays off limits to the queued item", () => {
  const { db, runAt, free } = fixture();
  try {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('B','ws-1','user-1','B','active',0,?)",
      [NOW],
    );
    free(NOW + 1);
    // A and B each have a free slot: X is woken for A, and Y is admitted for B.
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual(["Y"]);
    expect(runAt()).toBe(NOW + 2);
    // Placement keeps Y off A while X holds A's slot, and gives X its own slot.
    const reserved = pinnedSlotsReserved(db, "A", "Y", NOW + 2);
    expect(reserved).toBe(1);
    expect(runnerHasCapacity(db, "A", NOW + 2, "", reserved)).toBe(false);
    expect(pinnedSlotsReserved(db, "B", "Y", NOW + 2)).toBe(0);
    expect(pinnedSlotsReserved(db, "A", "X", NOW + 2)).toBe(0);
    // Once X is placed the reservation is gone.
    releasePinnedSlot(db, "X");
    expect(pinnedSlotsReserved(db, "A", "Y", NOW + 2)).toBe(0);
  } finally {
    db.close();
  }
});

test("a waiting item ranked behind a queued item that took the last slot reserves nothing", () => {
  const { db, runAt, free } = fixture();
  try {
    saveSchedulingContext(db, { itemId: "Y", priority: 1 });
    saveSchedulingContext(db, { itemId: "X", priority: 4 });
    free(NOW + 1);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual(["Y"]);
    expect(pinnedSlotsReserved(db, "A", "Y", NOW + 2)).toBe(0);
    expect(runAt()).toBe(BACKOFF);
  } finally {
    db.close();
  }
});

test("a waiting item on a full runner holds the slot that frees next", () => {
  const { db } = fixture();
  try {
    expect(workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(pinnedSlotsReserved(db, "A", "Y", NOW)).toBe(1);
  } finally {
    db.close();
  }
});

test("a reservation is released when its runner goes offline", () => {
  const { db } = fixture();
  try {
    expect(workspaceDispatch(db, { now: NOW })).toEqual([]);
    expect(pinnedSlotsReserved(db, "A", "Y", NOW)).toBe(1);
    db.run("UPDATE runner SET last_seen_at=0 WHERE id='A'");
    workspaceDispatch(db, { now: NOW + 120_000 });
    expect(pinnedSlotsReserved(db, "A", "Y", NOW + 120_000)).toBe(0);
  } finally {
    db.close();
  }
});
