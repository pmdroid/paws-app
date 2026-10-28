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
} from "../src/db";
import { tempDb } from "./helpers";
import { workspaceDispatch } from "./fake-workspace";

const NOW = 1_000;
const READY = ["next-1", "next-2", "next-3", "next-4"];

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
    role: "admin",
    active: true,
    teamIds: [],
    now: 0,
  });
  for (const [id, capacity] of [
    ["goldbox", 2],
    ["agentbox", 3],
  ] as const) {
    db.run(
      "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',0,?)",
      [id, "ws-1", userId, id, NOW],
    );
    db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,?)", [id, capacity]);
  }
  function running(id: string) {
    insertQueuedItem(db, { id, now: 0 });
    applyWorkItemEvent(db, id, "dispatched");
    const run = insertRun(db, { itemId: id, now: 0, status: "active" });
    const job = enqueueJob(db, {
      queue: JOB_KIND.start,
      payload: { itemId: id },
      runAt: NOW + 60_000,
      now: 0,
    });
    return { runId: run.id, job };
  }
  function placed(id: string) {
    const { runId } = running(id);
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until) VALUES(?,'goldbox','ws-1',1,0,?,?)",
      [runId, `cmd-${id}`, NOW + 60_000],
    );
    return runId;
  }
  placed("placed-1");
  const second = placed("placed-2");
  const stuck = ["stuck-1", "stuck-2", "stuck-3"].map((id) => running(id).job);
  for (const [index, id] of READY.entries()) insertQueuedItem(db, { id, now: index + 1 });
  return { db, second, stuck };
}

test("work running without a runner placement leaves its slot free for the next task", () => {
  const { db, second } = fixture();
  try {
    expect(workspaceDispatch(db, { now: NOW })).toEqual(["next-1", "next-2", "next-3"]);
    expect(workspaceDispatch(db, { now: NOW + 1 })).toEqual([]);
    db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [NOW + 2, second]);
    db.run("UPDATE run SET status='ended' WHERE id=?", [second]);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual(["next-4"]);
  } finally {
    db.close();
  }
});

test("a task between its run and Closeout keeps its runner slot until the run ends", () => {
  const { db, second } = fixture();
  try {
    expect(workspaceDispatch(db, { now: NOW })).toHaveLength(3);
    db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [NOW + 2, second]);
    expect(workspaceDispatch(db, { now: NOW + 2 })).toEqual([]);
    expect(runnerSlotFree(db, ["goldbox"], NOW + 2)).toBe(false);
    db.run("UPDATE run SET status='ended' WHERE id=?", [second]);
    expect(runnerSlotFree(db, ["goldbox"], NOW + 3)).toBe(true);
    expect(workspaceDispatch(db, { now: NOW + 3 })).toEqual(["next-4"]);
  } finally {
    db.close();
  }
});

test("a placement in progress holds a slot until its run reaches a runner", () => {
  const { db, stuck } = fixture();
  try {
    db.run("UPDATE job SET status='running',locked_by='worker',locked_until=? WHERE id=?", [
      NOW + 60_000,
      stuck[0]!,
    ]);
    expect(workspaceDispatch(db, { now: NOW })).toEqual(["next-1", "next-2"]);
  } finally {
    db.close();
  }
});

test("the queue line reports the slots the scheduler counts as busy", () => {
  const { db } = fixture();
  try {
    const admitted = workspaceDispatch(db, { now: NOW });
    const position = getQueuePosition(db, "next-4");
    expect(position).toMatchObject({ busySlots: 2 + admitted.length, totalSlots: 5 });
    expect(queueLine(position!)).toBe("Queued, 1st in line. 5 of 5 runner slots are busy.");
  } finally {
    db.close();
  }
});
