import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, ordinal, queueLine } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  bindLinearSessionTask,
  clearQueueWait,
  ensureLinearSession,
  getQueuePosition,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  listQueuePositions,
  putWorkspaceUser,
  queueWaitSince,
  saveQueuePositions,
  syncWorkspaceMember,
  sqliteDb,
} from "../src/db";
import { createFakeTracker, type SessionUpdate } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { createLiveStatusProvider } from "../src/dashboard";
import { forEachDialect, insertWorkItem } from "./dialects";
import { tempDb, tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

async function oneBusyRunnerSlot(db: ReturnType<typeof tempDb>): Promise<void> {
  const userId = await putWorkspaceUser(sqliteDb(db), {
    id: "runner-owner",
    linearUserId: "runner-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  db.run("INSERT INTO workspace VALUES('runner-ws','runner-org','Runners',0)");
  await syncWorkspaceMember(sqliteDb(db), {
    workspaceId: "runner-ws",
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now: 0,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner','runner-ws',?,'runner','active',0,?)",
    [userId, 100 * DAY],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES('runner',1)");
  await insertQueuedItem(db, { id: "busy", now: -1, sessionKey: "busy-session" });
}

test("a ready item waiting for a runner slot is queued once in Linear and fails after a day", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: sqliteDb(db),
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: async () => ({}),
  });
  try {
    await oneBusyRunnerSlot(db);
    const item = await insertQueuedItem(db, { id: "waiting", now: 1_000, sessionKey: "session" });
    await ensureLinearSession(sqliteDb(db), {
      sessionId: "session",
      issueId: item.linearIssueId,
      now: 1_000,
    });
    await bindLinearSessionTask(sqliteDb(db), "session", item.delegationId);
    const bodies = async (kind: string) =>
      (await listOutbox(sqliteDb(db)))
        .map((row) => row.payload as { kind?: string; body?: string })
        .filter((payload) => payload.kind === kind)
        .map((payload) => payload.body ?? "");

    await orchestrator.reconcileExecution();
    await orchestrator.reconcileExecution();
    expect((await bodies("thought")).filter((body) => body.startsWith("Queued"))).toHaveLength(1);

    clock.advance(DAY - 1_000);
    await orchestrator.reconcileExecution();
    expect((await getWorkItem(sqliteDb(db), "waiting"))?.state).toBe("queued");

    clock.advance(2_000);
    await orchestrator.reconcileExecution();
    expect((await getWorkItem(sqliteDb(db), "waiting"))?.state).toBe("failed");
    expect((await bodies("error")).some((body) => body.includes("within 24 hours"))).toBe(true);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});

test("the queued thought shows the place in line, and the start timeout comes from settings", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const pawsRoot = tempHome();
  writeFileSync(join(pawsRoot, "config.toml"), "[queue]\nstart_timeout_hours = 2\n");
  const orchestrator = new Orchestrator({
    store: sqliteDb(db),
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot,
    scheduling: async () => ({}),
  });
  try {
    await oneBusyRunnerSlot(db);
    await insertQueuedItem(db, { id: "ahead", now: 0 });
    const item = await insertQueuedItem(db, { id: "waiting", now: 1_000, sessionKey: "session" });
    db.run("UPDATE work_item SET linear_identifier='PAS-1' WHERE id='waiting'");
    await ensureLinearSession(sqliteDb(db), {
      sessionId: "session",
      issueId: item.linearIssueId,
      now: 1_000,
    });
    await bindLinearSessionTask(sqliteDb(db), "session", item.delegationId);
    const bodies = async (kind: string) =>
      (await listOutbox(sqliteDb(db)))
        .map((row) => row.payload as { kind?: string; body?: string })
        .filter((payload) => payload.kind === kind)
        .map((payload) => payload.body ?? "");

    await orchestrator.reconcileExecution();
    expect(await bodies("thought")).toContain(
      "Queued, 2nd in line. 1 of 1 runner slot is busy. Paws starts PAS-1 when a slot frees.",
    );

    clock.advance(2 * HOUR - 1_000);
    await orchestrator.reconcileExecution();
    expect((await getWorkItem(sqliteDb(db), "waiting"))?.state).toBe("queued");

    clock.advance(2_000);
    await orchestrator.reconcileExecution();
    expect((await getWorkItem(sqliteDb(db), "waiting"))?.state).toBe("failed");
    expect((await bodies("error")).some((body) => body.includes("PAS-1 within 2 hours"))).toBe(
      true,
    );
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});

test("queue lines use ordinals and singular slots", () => {
  expect(queueLine({ position: 1, busySlots: 1, totalSlots: 1 })).toBe(
    "Queued, 1st in line. 1 of 1 runner slot is busy.",
  );
  expect([2, 3, 4, 11, 12, 13, 21, 22, 23, 101, 111].map((position) => ordinal(position))).toEqual([
    "2nd",
    "3rd",
    "4th",
    "11th",
    "12th",
    "13th",
    "21st",
    "22nd",
    "23rd",
    "101st",
    "111th",
  ]);
});

test("the status API shows a queued item's place in line until it starts", async () => {
  const db = tempDb();
  try {
    await insertQueuedItem(db, { id: "ahead", now: 0 });
    await insertQueuedItem(db, { id: "waiting", now: 1 });
    await saveQueuePositions(sqliteDb(db), ["ahead", "waiting"], { busy: 4, total: 4 }, 2);
    const queueOf = async (id: string) =>
      (await createLiveStatusProvider(db).issues()).issues.find((item) => item.id === id)?.queue;
    expect(await queueOf("waiting")).toEqual({ position: 2, busySlots: 4, totalSlots: 4 });
    await applyWorkItemEvent(sqliteDb(db), "ahead", "dispatched");
    await saveQueuePositions(sqliteDb(db), ["waiting"], { busy: 4, total: 4 }, 3);
    expect(await queueOf("ahead")).toBeUndefined();
    expect(await queueOf("waiting")).toEqual({ position: 1, busySlots: 4, totalSlots: 4 });
    await saveQueuePositions(
      sqliteDb(db),
      ["waiting"],
      { busy: 4, total: 4 },
      4,
      new Map([["waiting", 3]]),
    );
    expect(await queueOf("waiting")).toEqual({
      position: 1,
      busySlots: 4,
      totalSlots: 4,
      ownerCap: 3,
    });
  } finally {
    db.close();
  }
});

test("a runner-queued item names its place in the title and plan, and a restart names its reason", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: sqliteDb(db),
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    tracker: createFakeTracker(),
    scheduling: async () => ({}),
  });
  try {
    await oneBusyRunnerSlot(db);
    await insertQueuedItem(db, { id: "ahead", now: 0, sessionKey: "ahead-session" });
    const item = await insertQueuedItem(db, { id: "waiting", now: 1_000, sessionKey: "session" });
    db.run("UPDATE work_item SET linear_identifier='PAS-1' WHERE id='waiting'");
    await ensureLinearSession(sqliteDb(db), {
      sessionId: "session",
      issueId: item.linearIssueId,
      now: 1_000,
    });
    await bindLinearSessionTask(sqliteDb(db), "session", item.delegationId);
    const latest = async (op: string) =>
      (await listOutbox(sqliteDb(db), "session")).findLast((row) => row.op === op)
        ?.payload as SessionUpdate;

    await orchestrator.reconcileExecution();
    expect((await latest("linear.session.summary")).summary).toBe(
      "PAS-1: 2nd in line for a runner",
    );
    expect((await latest("linear.session.plan")).plan?.[0]).toEqual({
      content: "Wait for a runner",
      status: "inProgress",
    });

    clock.advance(25 * 60_000);
    await orchestrator.reconcileExecution();
    expect(
      (await listOutbox(sqliteDb(db), "session"))
        .map((row) => row.payload as { body?: string; ephemeral?: boolean })
        .filter((payload) => payload.ephemeral),
    ).toEqual([expect.objectContaining({ body: "Still 2nd in line for a runner." })]);

    // A Closeout restart that is still waiting for a runner shows what it waits to do.
    db.run(
      `INSERT INTO work_item_event(item_id,version,at,from_state,to_state,event,kind,reason)
       VALUES('waiting',(SELECT version FROM work_item WHERE id='waiting'),0,'verifying','queued','restart','restart','findings')`,
    );
    db.run(
      `INSERT INTO job(queue,payload,run_at,max_attempts,created_at)
       VALUES('run.resume',json_object('itemId','waiting','reason','findings'),0,3,0)`,
    );
    await orchestrator.reconcileExecution();
    expect((await latest("linear.session.summary")).summary).toBe(
      "PAS-1: waiting for a runner to fix Closeout findings (1 of 3)",
    );
    const plan = (await latest("linear.session.plan")).plan ?? [];
    expect(
      plan.find((step) => step.status === "inProgress" && step.content.startsWith("Fix")),
    ).toEqual({
      content: "Fix Closeout findings (1 of 3)",
      status: "inProgress",
    });
    expect(plan.filter((step) => step.content.startsWith("Wait"))).toEqual([
      { content: "Wait for a runner", status: "completed" },
    ]);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});

test("paused and recovering items get a waiting title and no ephemeral", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: sqliteDb(db),
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    tracker: createFakeTracker(),
    scheduling: async () => ({}),
  });
  try {
    const item = await insertQueuedItem(db, { id: "paused", now: 1_000, sessionKey: "session" });
    db.run("UPDATE work_item SET linear_identifier='PAS-2' WHERE id='paused'");
    await ensureLinearSession(sqliteDb(db), {
      sessionId: "session",
      issueId: item.linearIssueId,
      now: 1_000,
    });
    await bindLinearSessionTask(sqliteDb(db), "session", item.delegationId);
    await applyWorkItemEvent(sqliteDb(db), "paused", "dispatched");
    await applyWorkItemEvent(sqliteDb(db), "paused", "pause");
    await putWorkspaceUser(sqliteDb(db), {
      id: "pascal",
      linearUserId: "pascal",
      name: "Pascal",
      email: "pascal@example.invalid",
    });
    db.run(
      "INSERT INTO workspace_access_audit(workspace_id,user_id,action,subject,created_at) VALUES(NULL,'pascal','execution.pause','paused',0)",
    );
    const summary = async () =>
      (
        (await listOutbox(sqliteDb(db), "session")).findLast(
          (row) => row.op === "linear.session.summary",
        )?.payload as SessionUpdate | undefined
      )?.summary;
    await orchestrator.reconcileExecution();
    expect(await summary()).toBe("PAS-2: paused by Pascal");
    clock.advance(60 * 60_000);
    await orchestrator.reconcileExecution();
    expect(
      (await listOutbox(sqliteDb(db), "session")).filter((row) => row.op === "activity"),
    ).toEqual([]);

    db.run("UPDATE work_item SET state='recovering' WHERE id='paused'");
    clock.advance(5 * 60_000);
    await orchestrator.reconcileExecution();
    expect(await summary()).toBe("PAS-2: recovering an interrupted turn");
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});

forEachDialect((open) => {
  test("an item's wait starts once per version and clears", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "waiting");
      expect(await queueWaitSince(db, "waiting", 1, 100)).toBe(100);
      expect(await queueWaitSince(db, "waiting", 1, 200)).toBe(100);
      expect(await queueWaitSince(db, "waiting", 2, 300)).toBe(300);
      await clearQueueWait(db, "waiting");
      expect(await queueWaitSince(db, "waiting", 2, 400)).toBe(400);
    } finally {
      await close();
    }
  });

  test("the waiting line is replaced on every save and empties without slots", async () => {
    const { db, close } = await open();
    try {
      for (const id of ["a", "b", "c"]) await insertWorkItem(db, id);
      await saveQueuePositions(db, ["a", "b", "c"], { busy: 2, total: 2 }, 1, new Map([["c", 3]]));
      expect(await listQueuePositions(db)).toEqual([
        { itemId: "a", position: 1, busySlots: 2, totalSlots: 2, ownerCap: null },
        { itemId: "b", position: 2, busySlots: 2, totalSlots: 2, ownerCap: null },
        { itemId: "c", position: 3, busySlots: 2, totalSlots: 2, ownerCap: 3 },
      ]);
      await saveQueuePositions(db, ["c", "b"], { busy: 1, total: 2 }, 2);
      expect(await getQueuePosition(db, "b")).toEqual({
        itemId: "b",
        position: 2,
        busySlots: 1,
        totalSlots: 2,
        ownerCap: null,
      });
      expect(await getQueuePosition(db, "a")).toBeNull();
      await saveQueuePositions(db, ["a"], null, 3);
      expect(await listQueuePositions(db)).toEqual([]);
    } finally {
      await close();
    }
  });
});

test("on SQLite the functions settle before they return", async () => {
  const db = tempDb();
  try {
    await insertQueuedItem(db, { id: "a", now: 0 });
    const since = queueWaitSince(sqliteDb(db), "a", 1, 5);
    expect(Bun.peek.status(since)).toBe("fulfilled");
    expect(await since).toBe(5);
    await saveQueuePositions(sqliteDb(db), ["a"], { busy: 1, total: 1 }, 1);
    expect((await getQueuePosition(sqliteDb(db), "a"))?.position).toBe(1);
    await expect(
      saveQueuePositions(sqliteDb(db), ["missing"], { busy: 1, total: 1 }, 2),
    ).rejects.toThrow("FOREIGN KEY");
    expect((await getQueuePosition(sqliteDb(db), "a"))?.position).toBe(1);
  } finally {
    db.close();
  }
});
