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
  getWorkItem,
  insertQueuedItem,
  insertRun,
  listQueuePositions,
  putWorkspaceUser,
  recordLinearInstallation,
  type Db,
} from "../src/db";
import { asc, eq, sql, type SQL } from "drizzle-orm";
import { intakeDelegatedIssue, readyItemsSteps, syncItemDependencies } from "../src/intake";
import { createFakeLinearIssueLifecycle, createFakeTracker } from "../src/linear";
import { saveSchedulingContextSteps } from "../src/scheduler";
import { issueWorkspaceBootstrap, workspaceId, workspaceTokenHash } from "../src/workspace";
import { JOB_KIND } from "../src/core";
import { confirmFakeMergePg, workspaceDispatchPg as workspaceDispatch } from "./fake-workspace";
import { tempStore } from "./pglite";

const exec = (db: Db, query: SQL) => db.run((q) => q.exec(q.orm.execute(query)));

const admissions = (db: Db) =>
  db.run((q) =>
    q.all(
      q.orm
        .select({
          projectKey: q.t.schedulerAdmission.projectKey,
          paths: q.t.schedulerAdmission.paths,
          hot: q.t.schedulerAdmission.hot,
        })
        .from(q.t.schedulerAdmission)
        .orderBy(asc(q.t.schedulerAdmission.itemId)),
    ),
  );

const hasOutbox = async (db: Db, key: string) =>
  (
    await db.run((q) =>
      q.all(q.orm.select().from(q.t.outbox).where(eq(q.t.outbox.orderingKey, key))),
    )
  ).length > 0;

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

test("three ready items in one project and repository are all admitted", async () => {
  const { db, close } = await tempStore();
  try {
    const ids = ["a", "b", "c"];
    for (const [index, id] of ids.entries()) {
      await insertQueuedItem(db, { id, now: index });
      await bindWorkItemRepository(db, id, repository);
      await db.run((q) =>
        saveSchedulingContextSteps(q, { itemId: id, projectId: "project", paths: ["src/same.ts"] }),
      );
    }
    assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ids);
    assert.deepEqual(
      await admissions(db),
      ids.map(() => ({ projectKey: "*", paths: [], hot: 0 })),
    );
  } finally {
    await close();
  }
});

test("two ready items that share a Linear session are both admitted", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "one", now: 1, sessionKey: "shared" });
    await insertQueuedItem(db, { id: "two", now: 2, sessionKey: "shared" });
    await exec(db, sql`UPDATE work_item SET delegation_id='epic-one' WHERE id='two'`);
    await ensureLinearSession(db, { sessionId: "shared", issueId: "lin-one", now: 1000 });
    await bindLinearSessionTask(db, "shared", "epic-one");
    const sessions = await db.run((q) =>
      q.all(
        q.orm
          .select({ id: q.t.workItem.id, sessionId: q.t.workItem.sessionKey })
          .from(q.t.workItem)
          .orderBy(asc(q.t.workItem.id)),
      ),
    );
    assert.deepEqual(sessions, [
      { id: "one", sessionId: "shared" },
      { id: "two", sessionId: "shared" },
    ]);
    assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ["one", "two"]);
  } finally {
    await close();
  }
});

test("two ready items with overlapping path hints are both admitted", async () => {
  const { db, close } = await tempStore();
  try {
    for (const [index, id] of ["left", "right"].entries()) {
      await insertQueuedItem(db, { id, now: index });
      await bindWorkItemRepository(db, id, repository);
      const value = brief(index === 0 ? "paths: src/shared/**" : "paths: src/shared/file.ts");
      await exec(db, sql`UPDATE work_item SET brief=${value} WHERE id=${id}`);
    }
    assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ["left", "right"]);
    assert.deepEqual(
      (await admissions(db)).map(({ paths, hot }) => ({ paths, hot })),
      [
        { paths: [], hot: 0 },
        { paths: [], hot: 0 },
      ],
    );
  } finally {
    await close();
  }
});

test("a task_block dependency is admitted only after its blocker item is merged", async () => {
  const { db, close } = await tempStore();
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
    const intake = await intakeDelegatedIssue(db, tracker, {
      linearIssueId: "parent",
      now: 1000,
    });
    assert(intake.ok);
    const ids = new Map(intake.items.map((item) => [item.linearIssueId, item.id]));
    await exec(db, sql`INSERT INTO workspace VALUES('workspace','org','Workspace',1000)`);
    await recordLinearInstallation(db, {
      organizationId: "org",
      oauthClientId: "client",
      appUserId: "app",
      sessionId: "session",
      teamId: "team",
      observedAtMs: 1000,
    });
    await bindLinearSessionTask(db, "session", intake.delegation.id, {
      actorId: "owner",
    });
    for (const item of intake.items)
      await syncItemDependencies(db, {
        itemId: item.id,
        workspaceId: "workspace",
        expectedGeneration: (
          await db.run((q) => readyItemsSteps(q, { itemId: item.id, workspaceId: "workspace" }))
        ).generation,
        tracker,
        lifecycle,
      });
    await exec(
      db,
      sql`INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('a', 'b')`,
    );
    const blocker = ids.get("a");
    const blocked = ids.get("b");
    assert(blocker);
    assert(blocked);
    assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), [blocker]);
    await confirmFakeMergePg(db, blocker);
    await exec(db, sql`UPDATE work_item SET state='merged' WHERE id=${blocker}`);
    assert.deepEqual(await workspaceDispatch(db, { now: 1001 }), [blocked]);
  } finally {
    await close();
  }
});

test("a longer task_block chain is admitted before an unrelated ready item", async () => {
  const { db, close } = await tempStore();
  try {
    for (const [index, id] of ["d", "c", "b", "a"].entries()) {
      await insertQueuedItem(db, { id, now: index });
      await bindWorkItemRepository(db, id, repository);
    }
    await exec(
      db,
      sql`INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('lin-item-a', 'lin-item-b')`,
    );
    await exec(
      db,
      sql`INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('lin-item-b', 'lin-item-c')`,
    );
    const admitted = await workspaceDispatch(db, {
      now: 1000,
    });
    assert.deepEqual(admitted, ["a", "d"]);
    assert.ok(admitted.indexOf("a") < admitted.indexOf("d"));
  } finally {
    await close();
  }
});

test("task_block depth stays on the active item when a merged row shares its issue", async () => {
  const { db, close } = await tempStore();
  try {
    for (const [index, id] of ["old", "d", "b", "a"].entries()) {
      await insertQueuedItem(db, { id, now: index });
      await bindWorkItemRepository(db, id, repository);
    }
    await exec(
      db,
      sql`UPDATE work_item SET state='merged', linear_issue_id='lin-item-a' WHERE id='old'`,
    );
    await exec(
      db,
      sql`INSERT INTO task_block(blocker_linear_issue_id, blocked_linear_issue_id) VALUES('lin-item-a', 'lin-item-b')`,
    );
    assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ["a", "d"]);
  } finally {
    await close();
  }
});

async function runnerWithSlots(db: Db, capacity: number): Promise<void> {
  const userId = await putWorkspaceUser(db, {
    id: workspaceId(),
    linearUserId: "owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  const workspace = await consumeWorkspaceBootstrap(db, {
    id: workspaceId(),
    organizationId: "org",
    name: "Fixture",
    userId,
    tokenHash: workspaceTokenHash(await issueWorkspaceBootstrap(db, "org", 0)),
    now: 0,
  });
  await exec(
    db,
    sql`INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner',${workspace.id},${userId},'runner','active',0,1000)`,
  );
  await exec(db, sql`INSERT INTO runner_capacity(runner_id,capacity) VALUES('runner',${capacity})`);
}

async function placeOnRunner(db: Db, itemId: string): Promise<void> {
  const run = await insertRun(db, { itemId, now: 0, status: "active" });
  await exec(
    db,
    sql`INSERT INTO runner_work(run_id,runner_id,workspace_id,generation,runner_fence,command_id,lease_until)
    SELECT ${run.id},id,workspace_id,1,0,${`cmd-${itemId}`},${60_000} FROM runner WHERE id='runner'`,
  );
}

async function leaveRunner(db: Db, itemId: string): Promise<void> {
  await exec(
    db,
    sql`UPDATE runner_work SET ended_at=0,teardown_confirmed_at=0 WHERE run_id IN (SELECT id FROM run WHERE item_id=${itemId})`,
  );
  await exec(db, sql`UPDATE run SET status='ended' WHERE item_id=${itemId}`);
}

test("a waiting item's place in line moves up as items ahead start or leave", async () => {
  const { db, close } = await tempStore();
  try {
    await runnerWithSlots(db, 2);
    for (const id of ["busy-1", "busy-2"]) {
      await insertQueuedItem(db, { id, now: 0 });
      await applyWorkItemEvent(db, id, "dispatched");
      await placeOnRunner(db, id);
    }
    const ready = ["a", "b", "c", "d"];
    for (const [index, id] of ready.entries()) await insertQueuedItem(db, { id, now: index + 1 });
    const line = async () =>
      (await listQueuePositions(db)).map(({ itemId, position, busySlots, totalSlots }) => [
        itemId,
        position,
        `${busySlots}/${totalSlots}`,
      ]);

    assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), []);
    assert.deepEqual(await line(), [
      ["a", 1, "2/2"],
      ["b", 2, "2/2"],
      ["c", 3, "2/2"],
      ["d", 4, "2/2"],
    ]);
    assert.deepEqual(await getQueuePosition(db, "c"), {
      itemId: "c",
      position: 3,
      busySlots: 2,
      totalSlots: 2,
      ownerCap: null,
    });

    // A slot frees and the first item starts: everyone behind it moves up.
    await applyWorkItemEvent(db, "busy-1", "blocking_question");
    await leaveRunner(db, "busy-1");
    assert.deepEqual(await workspaceDispatch(db, { now: 1001 }), ["a"]);
    assert.deepEqual(await line(), [
      ["b", 1, "2/2"],
      ["c", 2, "2/2"],
      ["d", 3, "2/2"],
    ]);

    // An item ahead leaves the queue.
    await exec(db, sql`UPDATE work_item SET cancel_requested=1 WHERE id='b'`);
    await workspaceDispatch(db, { now: 1002 });
    assert.deepEqual(await line(), [
      ["c", 1, "2/2"],
      ["d", 2, "2/2"],
    ]);
    assert.equal(await getQueuePosition(db, "b"), null);

    // With no runner online, admission is unlimited as in local execution, and there is no line.
    await exec(db, sql`UPDATE runner SET last_seen_at=0`);
    await workspaceDispatch(db, { now: 120_000 });
    assert.deepEqual(await line(), []);
  } finally {
    await close();
  }
});

test("queued items wait for a free runner slot, and work in flight keeps its slot", async () => {
  const { db, close } = await tempStore();
  try {
    await runnerWithSlots(db, 2);
    await insertQueuedItem(db, { id: "busy", now: 0 });
    await applyWorkItemEvent(db, "busy", "dispatched");
    await placeOnRunner(db, "busy");
    for (const [index, id] of ["a", "b", "c"].entries())
      await insertQueuedItem(db, { id, now: index + 1 });
    assert.deepEqual(await workspaceDispatch(db, { now: 1000 }), ["a"]);
    assert.deepEqual(await workspaceDispatch(db, { now: 1001 }), []);
    await applyWorkItemEvent(db, "busy", "blocking_question");
    await leaveRunner(db, "busy");
    assert.deepEqual(await workspaceDispatch(db, { now: 1002 }), ["b"]);
  } finally {
    await close();
  }
});

test("work back in flight without an admission is re-admitted, so its jobs run in parallel", async () => {
  const { db, close } = await tempStore();
  try {
    for (const id of ["a", "b"]) {
      await insertQueuedItem(db, { id, now: 0 });
      await bindWorkItemRepository(db, id, repository);
      await applyWorkItemEvent(db, id, "dispatched");
      await applyWorkItemEvent(db, id, "turn_ended");
      await enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId: id }, now: 0 });
    }
    await workspaceDispatch(db, { now: 1000 });
    const claimed = [await claimNextJob(db, { now: 1000 }), await claimNextJob(db, { now: 1000 })];
    assert.deepEqual(
      claimed.map((job) => (job?.payload as { itemId?: string } | undefined)?.itemId ?? null),
      ["a", "b"],
    );
  } finally {
    await close();
  }
});

test("work stuck in flight with no job is queued again and doesn't block other starts", async () => {
  const { db, close } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "stuck", now: 0, sessionKey: "stuck-session" });
    await bindWorkItemRepository(db, "stuck", repository);
    await applyWorkItemEvent(db, "stuck", "dispatched");
    await applyWorkItemEvent(db, "stuck", "turn_ended");
    const finished = await enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: "stuck" },
      now: 0,
    });
    await exec(db, sql`UPDATE job SET status='done', finished_at=0 WHERE id=${finished}`);
    await insertQueuedItem(db, { id: "next", now: 1 });
    await bindWorkItemRepository(db, "next", repository);
    const now = 10 * 60_000;
    assert.deepEqual(await workspaceDispatch(db, { now }), ["next"]);
    const claimed = [await claimNextJob(db, { now }), await claimNextJob(db, { now })].map(
      (job) => `${job?.queue}:${(job?.payload as { itemId?: string } | undefined)?.itemId}`,
    );
    assert.deepEqual(claimed.sort(), [`${JOB_KIND.start}:next`, `${JOB_KIND.reverify}:stuck`]);
    assert.equal(await hasOutbox(db, "stuck-session"), true);
  } finally {
    await close();
  }
});

async function mergeQueueItem(db: Db, id: string): Promise<void> {
  await insertQueuedItem(db, { id, now: 0, sessionKey: `${id}-session` });
  await bindWorkItemRepository(db, id, repository);
  await applyWorkItemEvent(db, id, "dispatched");
  await applyWorkItemEvent(db, id, "turn_ended");
  await applyWorkItemEvent(db, id, "closeout_accepted");
}

test("an item in merge_queue whose merge job is gone fails closed into a re-verify", async () => {
  const { db, close } = await tempStore();
  try {
    await mergeQueueItem(db, "merging");
    const finished = await enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "merging", head: "h", summary: "s" },
      now: 0,
    });
    await exec(db, sql`UPDATE job SET status='dead', finished_at=0 WHERE id=${finished}`);
    const now = 10 * 60_000;
    await workspaceDispatch(db, { now });
    assert.equal((await getWorkItem(db, "merging"))?.state, "verifying");
    const job = await claimNextJob(db, { now });
    assert.equal(job?.queue, JOB_KIND.reverify);
    assert.deepEqual(job?.payload, {
      itemId: "merging",
      runId: null,
      recheckHead: true,
      failClosed: true,
    });
    assert.equal(await hasOutbox(db, "merging-session"), true);
  } finally {
    await close();
  }
});

test("an item in merge_queue with a parked merge job is left in the queue", async () => {
  const { db, close } = await tempStore();
  try {
    await mergeQueueItem(db, "waiting");
    await enqueueJob(db, {
      queue: JOB_KIND.merge,
      payload: { itemId: "waiting", head: "h", summary: "s" },
      now: 0,
      runAt: 60 * 60_000,
    });
    const older = await enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: "waiting" },
      now: 0,
    });
    await exec(db, sql`UPDATE job SET status='done', finished_at=0 WHERE id=${older}`);
    await workspaceDispatch(db, { now: 10 * 60_000 });
    assert.equal((await getWorkItem(db, "waiting"))?.state, "merge_queue");
    const pending = await db.run((q) =>
      q.all(
        q.orm
          .select()
          .from(q.t.job)
          .where(sql`${q.t.job.queue}=${JOB_KIND.reverify} AND ${q.t.job.status}='pending'`),
      ),
    );
    assert.deepEqual(pending, []);
  } finally {
    await close();
  }
});
