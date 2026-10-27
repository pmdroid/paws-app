import { expect, test } from "bun:test";
import {
  insertRun,
  listRunnerOverview,
  markRun,
  noteRunnerSessionMove,
  putWorkspaceUser,
  releaseRunCapacity,
  requestRunnerSessionMove,
  syncWorkspaceMember,
} from "../src/db";
import { RUNNER_LEASE_GRACE_MS } from "../src/runner-protocol";
import { tempDb } from "./helpers";

function fixture(now: number) {
  const db = tempDb();
  const userId = putWorkspaceUser(db, {
    id: "user-1",
    linearUserId: "user-linear",
    name: "Owner",
    email: "owner@example.invalid",
  });
  db.run("INSERT INTO workspace VALUES(?,?,?,?)", ["ws-1", "org-1", "Workspace", now]);
  syncWorkspaceMember(db, {
    workspaceId: "ws-1",
    userId,
    role: "owner",
    active: true,
    teamIds: [],
    now,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES(?,?,?,?,'active',?,?)",
    ["runner-1", "ws-1", userId, "Runner", now, now],
  );
  function work(
    index: number,
    lease: number,
    options: { state?: string; startedAt?: number; title?: string } = {},
  ) {
    db.run(
      "INSERT INTO work_item(id,delegation_id,linear_issue_id,linear_identifier,title,state,branch_name,position,created_at) VALUES(?,?,?,?,?,?,?,0,?)",
      [
        `item-${index}`,
        `epic-${index}`,
        `issue-${index}`,
        `ENG-${index}`,
        options.title ?? "Task",
        options.state ?? "running",
        `paws/eng-${index}`,
        now,
      ],
    );
    const run = insertRun(db, {
      itemId: `item-${index}`,
      now: options.startedAt ?? now,
      status: "active",
    });
    db.run(
      "INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until,last_sequence) VALUES(?,?,?,1,0,?,?,0)",
      [run.id, "runner-1", "ws-1", `cmd-${index}`, lease],
    );
    return run.id;
  }
  return { db, work };
}

test("the runner overview reports used and total slots like placement counts them", () => {
  const now = Date.now();
  const { db, work } = fixture(now);
  expect(listRunnerOverview(db, "ws-1", now)[0]?.slots).toEqual({ used: 0, total: 1 });
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES(?,3)", ["runner-1"]);
  work(0, now + 60_000);
  markRun(db, work(1, now - RUNNER_LEASE_GRACE_MS - 1), "ended", now);
  expect(listRunnerOverview(db, "ws-1", now)[0]?.slots).toEqual({ used: 1, total: 3 });
  work(2, now - 1);
  expect(listRunnerOverview(db, "ws-1", now)[0]?.slots).toEqual({ used: 2, total: 3 });
});

test("the runner overview lists each live session with its issue and phase", () => {
  const now = Date.now();
  const { db, work } = fixture(now);
  expect(listRunnerOverview(db, "ws-1", now)[0]?.running).toEqual([]);
  const lease = now + 60_000;
  const working = work(0, lease, { startedAt: now - 50_000, title: "Write the parser" });
  const closeout = work(1, lease, { state: "verifying", startedAt: now - 40_000 });
  const fixing = work(2, lease, { startedAt: now - 30_000 });
  db.run(
    "INSERT INTO closeout_progress(id,item_id,task_id,base,head,policy_digest,decision,started_at,updated_at,finished_at) VALUES('p-2','item-2','task','a','b','d','rejected',?,?,?)",
    [now - 20_000, now - 20_000, now - 20_000],
  );
  const merging = work(3, lease, { state: "merge_queue", startedAt: now - 20_000 });
  markRun(db, work(4, now - RUNNER_LEASE_GRACE_MS - 1, { startedAt: now - 10_000 }), "ended", now);
  releaseRunCapacity(db, work(5, lease, { startedAt: now - 5_000 }), now);

  expect(listRunnerOverview(db, "ws-1", now)[0]?.running).toEqual([
    {
      runId: working,
      identifier: "ENG-0",
      title: "Write the parser",
      phase: "working",
      startedAt: now - 50_000,
      movable: true,
      move: null,
    },
    {
      runId: closeout,
      identifier: "ENG-1",
      title: "Task",
      phase: "closeout",
      startedAt: now - 40_000,
      movable: true,
      move: null,
    },
    {
      runId: fixing,
      identifier: "ENG-2",
      title: "Task",
      phase: "fixing",
      startedAt: now - 30_000,
      movable: true,
      move: null,
    },
    {
      runId: merging,
      identifier: "ENG-3",
      title: "Task",
      phase: "merging",
      startedAt: now - 20_000,
      movable: true,
      move: null,
    },
  ]);
});

test("a run placed on a runner stays in its list through Closeout and leaves when it ends", () => {
  const now = Date.now();
  const { db, work } = fixture(now);
  const runId = work(0, now + 60_000, { startedAt: now - 30_000, title: "Write the parser" });
  const session = {
    runId,
    identifier: "ENG-0",
    title: "Write the parser",
    phase: "working" as const,
    startedAt: now - 30_000,
    movable: true,
    move: null,
  };
  expect(listRunnerOverview(db, "ws-1", now)[0]?.running).toEqual([session]);

  db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [now, runId]);
  db.run("UPDATE work_item SET state='verifying' WHERE id='item-0'");
  const [held] = listRunnerOverview(db, "ws-1", now + 120_000);
  expect(held?.running).toEqual([{ ...session, phase: "closeout", movable: false }]);
  expect(held?.slots.used).toBe(1);

  releaseRunCapacity(db, runId, now + 130_000);
  const [after] = listRunnerOverview(db, "ws-1", now + 130_000);
  expect(after?.running).toEqual([]);
  expect(after?.slots.used).toBe(0);
});

test("a session moving off a runner shows its move there, and not once it landed elsewhere", () => {
  const now = Date.now();
  const { db, work } = fixture(now);
  const runId = work(0, now + 60_000);
  requestRunnerSessionMove(db, { runId, runnerId: "runner-1", userId: "owner", now });
  expect(listRunnerOverview(db, "ws-1", now)[0]?.running[0]?.move).toEqual({
    status: "moving",
    reason: null,
  });
  // Handed over and waiting: the slot is held, the lease ended, and the row says why.
  db.run("UPDATE runner_work SET ended_at=? WHERE run_id=?", [now, runId]);
  noteRunnerSessionMove(db, {
    runId,
    runnerId: "runner-1",
    status: "waiting",
    reason: "Every other runner is busy.",
    now,
  });
  const [waiting] = listRunnerOverview(db, "ws-1", now)[0]!.running;
  expect(waiting).toMatchObject({
    movable: false,
    move: { status: "waiting", reason: "Every other runner is busy." },
  });
  // It lands on runner-2: it leaves runner-1's list and shows on runner-2's with no move.
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner-2','ws-1','user-1','other','active',?,?)",
    [now, now],
  );
  db.run("UPDATE runner_work SET runner_id='runner-2',ended_at=NULL WHERE run_id=?", [runId]);
  const overview = listRunnerOverview(db, "ws-1", now);
  expect(overview.find((runner) => runner.id === "runner-1")?.running).toEqual([]);
  expect(overview.find((runner) => runner.id === "runner-2")?.running).toMatchObject([
    { runId, movable: true, move: null },
  ]);
});
