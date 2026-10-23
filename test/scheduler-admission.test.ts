import assert from "node:assert/strict";
import { test } from "bun:test";
import {
  applyWorkItemEvent,
  bindLinearSessionTask,
  bindWorkItemRepository,
  claimNextJob,
  consumeWorkspaceBootstrap,
  enqueueJob,
  ensureLinearSession,
  getQueuePosition,
  insertQueuedItem,
  insertRun,
  listQueuePositions,
  putWorkspaceUser,
  recordLinearInstallation,
} from "../src/db";
import { intakeDelegatedIssue, readyItems, syncItemDependencies } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { dispatchReadyItems, saveSchedulingContext } from "../src/scheduler";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { JOB_KIND } from "../src/core";
import { tempDb } from "./helpers";

const repository = { owner: "owner", repo: "repo", remoteUrl: "https://example.invalid/repo.git" };

function brief(description: string): string {
  return JSON.stringify({
    issue: {
      source: "linear",
      issueId: "issue",
      identifier: "SCH-1",
      title: "Work",
      description,
      acceptanceCriteria: null,
    },
    epic: null,
  });
}

test("three ready items in one project and repository are all admitted", () => {
  const db = tempDb();
  try {
    const ids = ["a", "b", "c"];
    for (const [index, id] of ids.entries()) {
      insertQueuedItem(db, { id, now: index });
      bindWorkItemRepository(db, id, repository);
      saveSchedulingContext(db, { itemId: id, projectId: "project", paths: ["src/same.ts"] });
    }
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ids }), ids);
    const rows = db
      .query<{ project_key: string; paths: string; hot: number }, []>(
        "SELECT project_key, paths, hot FROM scheduler_admission ORDER BY item_id",
      )
      .all();
    assert.deepEqual(
      rows,
      ids.map(() => ({ project_key: "*", paths: "[]", hot: 0 })),
    );
  } finally {
    db.close();
  }
});

test("two ready items that share a Linear session are both admitted", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "one", now: 1, sessionKey: "shared" });
    insertQueuedItem(db, { id: "two", now: 2, sessionKey: "shared" });
    db.run("UPDATE work_item SET delegation_id=? WHERE id=?", ["epic-one", "two"]);
    ensureLinearSession(db, { sessionId: "shared", issueId: "lin-one", now: 1000 });
    bindLinearSessionTask(db, "shared", "epic-one");
    const sessions = db
      .query<{ id: string; sessionId: string | null }, []>(
        "SELECT id, session_key AS sessionId FROM work_item ORDER BY id",
      )
      .all();
    assert.deepEqual(sessions, [
      { id: "one", sessionId: "shared" },
      { id: "two", sessionId: "shared" },
    ]);
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ["one", "two"] }), [
      "one",
      "two",
    ]);
  } finally {
    db.close();
  }
});

test("two ready items with overlapping path hints are both admitted", () => {
  const db = tempDb();
  try {
    for (const [index, id] of ["left", "right"].entries()) {
      insertQueuedItem(db, { id, now: index });
      bindWorkItemRepository(db, id, repository);
      db.run("UPDATE work_item SET brief=? WHERE id=?", [
        brief(index === 0 ? "paths: src/shared/**" : "paths: src/shared/file.ts"),
        id,
      ]);
    }
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ["left", "right"] }), [
      "left",
      "right",
    ]);
    const rows = db
      .query<{ paths: string; hot: number }, []>(
        "SELECT paths, hot FROM scheduler_admission ORDER BY item_id",
      )
      .all();
    assert.deepEqual(rows, [
      { paths: "[]", hot: 0 },
      { paths: "[]", hot: 0 },
    ]);
  } finally {
    db.close();
  }
});

test("a task_block dependency is admitted only after its blocker item is merged", async () => {
  const db = tempDb();
  try {
    const tracker = createFakeTracker([
      {
        linearIssueId: "parent",
        identifier: "DEP-1",
        title: "Parent",
        description: null,
        subIssues: ["a", "b"].map((id, index) => ({
          linearIssueId: id,
          identifier: `DEP-${index + 2}`,
          title: id,
        })),
      },
    ]);
    const lifecycle = createFakeLinearIssueLifecycle({
      id: "a",
      teamId: "team",
      stateType: "started",
      assigneeId: null,
      delegateId: null,
    });
    const intake = await intakeDelegatedIssue(db, tracker, { linearIssueId: "parent", now: 1000 });
    assert(intake.ok);
    const ids = new Map(intake.items.map((item) => [item.linearIssueId, item.id]));
    db.run("INSERT INTO workspace VALUES('workspace','org','Workspace',1000)");
    recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    bindLinearSessionTask(db, "session", intake.delegation.id, { actorId: "owner" });
    for (const item of intake.items)
      await syncItemDependencies(db, {
        itemId: item.id,
        workspaceId: "workspace",
        expectedGeneration: readyItems(db, { itemId: item.id, workspaceId: "workspace" })
          .generation,
        tracker,
        lifecycle,
      });
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('a', 'b')",
    );
    const blocker = ids.get("a");
    const blocked = ids.get("b");
    assert(blocker);
    assert(blocked);
    assert.deepEqual(dispatchReadyItems(db, { now: 1000 }), [blocker]);
    db.run("UPDATE work_item SET state='merged' WHERE id=?", [blocker]);
    assert.deepEqual(dispatchReadyItems(db, { now: 1001 }), [blocked]);
  } finally {
    db.close();
  }
});

test("a longer task_block chain is admitted before an unrelated ready item", () => {
  const db = tempDb();
  try {
    for (const [index, id] of ["d", "c", "b", "a"].entries()) {
      insertQueuedItem(db, { id, now: index });
      bindWorkItemRepository(db, id, repository);
    }
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('lin-item-a', 'lin-item-b')",
    );
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('lin-item-b', 'lin-item-c')",
    );
    const admitted = dispatchReadyItems(db, {
      now: 1000,
      legacyReadyItemIds: ["d", "c", "b", "a"],
    });
    assert.deepEqual(admitted, ["a", "b", "d", "c"]);
    assert.ok(admitted.indexOf("a") < admitted.indexOf("d"));
  } finally {
    db.close();
  }
});

test("task_block depth stays on the active item when a merged row shares its issue", () => {
  const db = tempDb();
  try {
    for (const [index, id] of ["old", "d", "b", "a"].entries()) {
      insertQueuedItem(db, { id, now: index });
      bindWorkItemRepository(db, id, repository);
    }
    db.run("UPDATE work_item SET state='merged', linear_issue_id='lin-item-a' WHERE id='old'");
    db.run(
      "INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('lin-item-a', 'lin-item-b')",
    );
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ["a", "b", "d"] }), [
      "a",
      "d",
      "b",
    ]);
  } finally {
    db.close();
  }
});

function runnerWithSlots(db: ReturnType<typeof tempDb>, capacity: number): void {
  const userId = putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(issueWorkspaceBootstrap(db, "org", 0)),
    now: 0,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner',?,?,'runner','active',0,1000)",
    [workspace.id, userId],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES('runner',?)", [capacity]);
}

function placeOnRunner(db: ReturnType<typeof tempDb>, itemId: string): void {
  const run = insertRun(db, { itemId, now: 0, status: "active" });
  db.run(
    `INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until)
    SELECT ?,id,workspace_id,1,0,?,? FROM runner WHERE id='runner'`,
    [run.id, `cmd-${itemId}`, 60_000],
  );
}

function leaveRunner(db: ReturnType<typeof tempDb>, itemId: string): void {
  db.run("UPDATE runner_work SET ended_at=0 WHERE run_id IN (SELECT id FROM run WHERE item_id=?)", [
    itemId,
  ]);
  db.run("UPDATE run SET status='ended' WHERE item_id=?", [itemId]);
}

test("a waiting item's place in line moves up as items ahead start or leave", () => {
  const db = tempDb();
  try {
    runnerWithSlots(db, 2);
    for (const id of ["busy-1", "busy-2"]) {
      insertQueuedItem(db, { id, now: 0 });
      applyWorkItemEvent(db, id, "dispatched");
      placeOnRunner(db, id);
    }
    const ready = ["a", "b", "c", "d"];
    for (const [index, id] of ready.entries()) insertQueuedItem(db, { id, now: index + 1 });
    const line = () =>
      listQueuePositions(db).map(({ itemId, position, busySlots, totalSlots }) => [
        itemId,
        position,
        `${busySlots}/${totalSlots}`,
      ]);

    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ready }), []);
    assert.deepEqual(line(), [
      ["a", 1, "2/2"],
      ["b", 2, "2/2"],
      ["c", 3, "2/2"],
      ["d", 4, "2/2"],
    ]);
    assert.deepEqual(getQueuePosition(db, "c"), {
      itemId: "c",
      position: 3,
      busySlots: 2,
      totalSlots: 2,
    });

    // A slot frees and the first item starts: everyone behind it moves up.
    applyWorkItemEvent(db, "busy-1", "blocking_question");
    leaveRunner(db, "busy-1");
    assert.deepEqual(dispatchReadyItems(db, { now: 1001, legacyReadyItemIds: ready }), ["a"]);
    assert.deepEqual(line(), [
      ["b", 1, "2/2"],
      ["c", 2, "2/2"],
      ["d", 3, "2/2"],
    ]);

    // An item ahead leaves the queue.
    db.run("UPDATE work_item SET cancel_requested=1 WHERE id='b'");
    dispatchReadyItems(db, { now: 1002, legacyReadyItemIds: ready });
    assert.deepEqual(line(), [
      ["c", 1, "2/2"],
      ["d", 2, "2/2"],
    ]);
    assert.equal(getQueuePosition(db, "b"), null);

    // With no runner online, admission is unlimited as in local execution, and there is no line.
    db.run("UPDATE runner SET last_seen_at=0");
    dispatchReadyItems(db, { now: 120_000, legacyReadyItemIds: ready });
    assert.deepEqual(line(), []);
  } finally {
    db.close();
  }
});

test("queued items wait for a free runner slot, and work in flight keeps its slot", () => {
  const db = tempDb();
  try {
    runnerWithSlots(db, 2);
    insertQueuedItem(db, { id: "busy", now: 0 });
    applyWorkItemEvent(db, "busy", "dispatched");
    placeOnRunner(db, "busy");
    for (const [index, id] of ["a", "b", "c"].entries())
      insertQueuedItem(db, { id, now: index + 1 });
    const ready = ["a", "b", "c"];
    assert.deepEqual(dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: ready }), ["a"]);
    assert.deepEqual(dispatchReadyItems(db, { now: 1001, legacyReadyItemIds: ready }), []);
    applyWorkItemEvent(db, "busy", "blocking_question");
    leaveRunner(db, "busy");
    assert.deepEqual(dispatchReadyItems(db, { now: 1002, legacyReadyItemIds: ready }), ["b"]);
  } finally {
    db.close();
  }
});

test("work back in flight without an admission is re-admitted, so its jobs run in parallel", () => {
  const db = tempDb();
  try {
    for (const id of ["a", "b"]) {
      insertQueuedItem(db, { id, now: 0 });
      bindWorkItemRepository(db, id, repository);
      applyWorkItemEvent(db, id, "dispatched");
      applyWorkItemEvent(db, id, "turn_ended");
      enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId: id }, now: 0 });
    }
    dispatchReadyItems(db, { now: 1000, legacyReadyItemIds: [] });
    const claimed = [claimNextJob(db, { now: 1000 }), claimNextJob(db, { now: 1000 })];
    assert.deepEqual(
      claimed.map((job) => (job?.payload as { itemId?: string } | undefined)?.itemId ?? null),
      ["a", "b"],
    );
  } finally {
    db.close();
  }
});

test("work stuck in flight with no job is queued again and doesn't block other starts", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "stuck", now: 0, sessionKey: "stuck-session" });
    bindWorkItemRepository(db, "stuck", repository);
    applyWorkItemEvent(db, "stuck", "dispatched");
    applyWorkItemEvent(db, "stuck", "turn_ended");
    const finished = enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: "stuck" },
      now: 0,
    });
    db.run("UPDATE job SET status='done', finished_at=0 WHERE id=?", [finished]);
    insertQueuedItem(db, { id: "next", now: 1 });
    bindWorkItemRepository(db, "next", repository);
    const now = 10 * 60_000;
    assert.deepEqual(dispatchReadyItems(db, { now, legacyReadyItemIds: ["next"] }), ["next"]);
    const claimed = [claimNextJob(db, { now }), claimNextJob(db, { now })].map(
      (job) => `${job?.queue}:${(job?.payload as { itemId?: string } | undefined)?.itemId}`,
    );
    assert.deepEqual(claimed.sort(), [`${JOB_KIND.start}:next`, `${JOB_KIND.reverify}:stuck`]);
    assert.equal(
      db.query("SELECT 1 FROM outbox WHERE ordering_key='stuck-session'").get() !== null,
      true,
    );
  } finally {
    db.close();
  }
});
