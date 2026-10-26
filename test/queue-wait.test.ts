import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock, ordinal, queueLine } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyWorkItemEvent,
  bindLinearSessionTask,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  putWorkspaceUser,
  saveQueuePositions,
  syncWorkspaceMember,
} from "../src/db";
import { createFakeTracker, type SessionUpdate } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { createLiveStatusProvider } from "../src/web";
import { tempDb, tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function oneBusyRunnerSlot(db: ReturnType<typeof tempDb>): void {
  const userId = putWorkspaceUser(db, {
    id: "runner-owner",
    linearUserId: "runner-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  db.run("INSERT INTO workspace VALUES('runner-ws','runner-org','Runners',0)");
  syncWorkspaceMember(db, {
    workspaceId: "runner-ws",
    userId,
    role: "owner",
    active: true,
    teamIds: [],
    now: 0,
  });
  db.run(
    "INSERT INTO runner(id,workspace_id,owner_user_id,name,status,created_at,last_seen_at) VALUES('runner','runner-ws',?,'runner','active',0,?)",
    [userId, 100 * DAY],
  );
  db.run("INSERT INTO runner_capacity(runner_id,capacity) VALUES('runner',1)");
  insertQueuedItem(db, { id: "busy", now: -1, sessionKey: "busy-session" });
}

test("a ready item waiting for a runner slot is queued once in Linear and fails after a day", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    scheduling: () => ({}),
  });
  try {
    oneBusyRunnerSlot(db);
    const item = insertQueuedItem(db, { id: "waiting", now: 1_000, sessionKey: "session" });
    ensureLinearSession(db, { sessionId: "session", issueId: item.linearIssueId, now: 1_000 });
    bindLinearSessionTask(db, "session", item.delegationId);
    const bodies = (kind: string) =>
      listOutbox(db)
        .map((row) => row.payload as { kind?: string; body?: string })
        .filter((payload) => payload.kind === kind)
        .map((payload) => payload.body ?? "");

    orchestrator.reconcileExecution();
    orchestrator.reconcileExecution();
    expect(bodies("thought").filter((body) => body.startsWith("Queued"))).toHaveLength(1);

    clock.advance(DAY - 1_000);
    orchestrator.reconcileExecution();
    expect(getWorkItem(db, "waiting")?.state).toBe("queued");

    clock.advance(2_000);
    orchestrator.reconcileExecution();
    expect(getWorkItem(db, "waiting")?.state).toBe("failed");
    expect(bodies("error").some((body) => body.includes("within 24 hours"))).toBe(true);
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
    db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot,
    scheduling: () => ({}),
  });
  try {
    oneBusyRunnerSlot(db);
    insertQueuedItem(db, { id: "ahead", now: 0 });
    const item = insertQueuedItem(db, { id: "waiting", now: 1_000, sessionKey: "session" });
    db.run("UPDATE work_item SET linear_identifier='PAS-1' WHERE id='waiting'");
    ensureLinearSession(db, { sessionId: "session", issueId: item.linearIssueId, now: 1_000 });
    bindLinearSessionTask(db, "session", item.delegationId);
    const bodies = (kind: string) =>
      listOutbox(db)
        .map((row) => row.payload as { kind?: string; body?: string })
        .filter((payload) => payload.kind === kind)
        .map((payload) => payload.body ?? "");

    orchestrator.reconcileExecution();
    expect(bodies("thought")).toContain(
      "Queued, 2nd in line. 1 of 1 runner slot is busy. Paws starts PAS-1 when a slot frees.",
    );

    clock.advance(2 * HOUR - 1_000);
    orchestrator.reconcileExecution();
    expect(getWorkItem(db, "waiting")?.state).toBe("queued");

    clock.advance(2_000);
    orchestrator.reconcileExecution();
    expect(getWorkItem(db, "waiting")?.state).toBe("failed");
    expect(bodies("error").some((body) => body.includes("PAS-1 within 2 hours"))).toBe(true);
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

test("the status API shows a queued item's place in line until it starts", () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "ahead", now: 0 });
    insertQueuedItem(db, { id: "waiting", now: 1 });
    saveQueuePositions(db, ["ahead", "waiting"], { busy: 4, total: 4 }, 2);
    const queueOf = (id: string) =>
      createLiveStatusProvider(db)
        .snapshot()
        .items.find((item) => item.id === id)?.queue;
    expect(queueOf("waiting")).toEqual({ position: 2, busySlots: 4, totalSlots: 4 });
    applyWorkItemEvent(db, "ahead", "dispatched");
    saveQueuePositions(db, ["waiting"], { busy: 4, total: 4 }, 3);
    expect(queueOf("ahead")).toBeUndefined();
    expect(queueOf("waiting")).toEqual({ position: 1, busySlots: 4, totalSlots: 4 });
    saveQueuePositions(db, ["waiting"], { busy: 4, total: 4 }, 4, new Map([["waiting", 3]]));
    expect(queueOf("waiting")).toEqual({ position: 1, busySlots: 4, totalSlots: 4, ownerCap: 3 });
  } finally {
    db.close();
  }
});

test("a runner-queued item names its place in the title and plan, and a restart names its reason", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    tracker: createFakeTracker(),
    scheduling: () => ({}),
  });
  try {
    oneBusyRunnerSlot(db);
    insertQueuedItem(db, { id: "ahead", now: 0, sessionKey: "ahead-session" });
    const item = insertQueuedItem(db, { id: "waiting", now: 1_000, sessionKey: "session" });
    db.run("UPDATE work_item SET linear_identifier='PAS-1' WHERE id='waiting'");
    ensureLinearSession(db, { sessionId: "session", issueId: item.linearIssueId, now: 1_000 });
    bindLinearSessionTask(db, "session", item.delegationId);
    const latest = (op: string) =>
      listOutbox(db, "session").findLast((row) => row.op === op)?.payload as SessionUpdate;

    orchestrator.reconcileExecution();
    expect(latest("linear.session.summary").summary).toBe("PAS-1: 2nd in line for a runner");
    expect(latest("linear.session.plan").plan?.[0]).toEqual({
      content: "Wait for a runner",
      status: "inProgress",
    });

    clock.advance(25 * 60_000);
    orchestrator.reconcileExecution();
    expect(
      listOutbox(db, "session")
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
    orchestrator.reconcileExecution();
    expect(latest("linear.session.summary").summary).toBe(
      "PAS-1: waiting for a runner to fix Closeout findings (1 of 3)",
    );
    const plan = latest("linear.session.plan").plan ?? [];
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
    db,
    admission: workspaceAdmission(db),
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    tracker: createFakeTracker(),
    scheduling: () => ({}),
  });
  try {
    const item = insertQueuedItem(db, { id: "paused", now: 1_000, sessionKey: "session" });
    db.run("UPDATE work_item SET linear_identifier='PAS-2' WHERE id='paused'");
    ensureLinearSession(db, { sessionId: "session", issueId: item.linearIssueId, now: 1_000 });
    bindLinearSessionTask(db, "session", item.delegationId);
    applyWorkItemEvent(db, "paused", "dispatched");
    applyWorkItemEvent(db, "paused", "pause");
    putWorkspaceUser(db, {
      id: "pascal",
      linearUserId: "pascal",
      name: "Pascal",
      email: "pascal@example.invalid",
    });
    db.run(
      "INSERT INTO workspace_access_audit(workspace_id,user_id,action,subject,created_at) VALUES(NULL,'pascal','execution.pause','paused',0)",
    );
    const summary = () =>
      (
        listOutbox(db, "session").findLast((row) => row.op === "linear.session.summary")
          ?.payload as SessionUpdate | undefined
      )?.summary;
    orchestrator.reconcileExecution();
    expect(summary()).toBe("PAS-2: paused by Pascal");
    clock.advance(60 * 60_000);
    orchestrator.reconcileExecution();
    expect(listOutbox(db, "session").filter((row) => row.op === "activity")).toEqual([]);

    db.run("UPDATE work_item SET state='recovering' WHERE id='paused'");
    clock.advance(5 * 60_000);
    orchestrator.reconcileExecution();
    expect(summary()).toBe("PAS-2: recovering an interrupted turn");
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});
