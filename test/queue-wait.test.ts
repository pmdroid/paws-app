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
  immediate,
  insertQueuedItem,
  listOutbox,
  listQueuePositions,
  putWorkspaceUser,
  queueWaitSince,
  saveQueuePositions,
  syncWorkspaceMember,
  settled,
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
    settled(saveQueuePositions(sqliteDb(db), ["ahead", "waiting"], { busy: 4, total: 4 }, 2));
    const queueOf = (id: string) =>
      createLiveStatusProvider(db)
        .issues()
        .issues.find((item) => item.id === id)?.queue;
    expect(queueOf("waiting")).toEqual({ position: 2, busySlots: 4, totalSlots: 4 });
    applyWorkItemEvent(db, "ahead", "dispatched");
    settled(saveQueuePositions(sqliteDb(db), ["waiting"], { busy: 4, total: 4 }, 3));
    expect(queueOf("ahead")).toBeUndefined();
    expect(queueOf("waiting")).toEqual({ position: 1, busySlots: 4, totalSlots: 4 });
    settled(
      saveQueuePositions(
        sqliteDb(db),
        ["waiting"],
        { busy: 4, total: 4 },
        4,
        new Map([["waiting", 3]]),
      ),
    );
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

  test("a transaction rolls back when its body fails, and a nested one only its own part", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      await saveQueuePositions(db, ["a"], { busy: 1, total: 1 }, 1);
      const failed = db.transaction(async (tx) => {
        await saveQueuePositions(tx, [], { busy: 0, total: 1 }, 2);
        expect(await listQueuePositions(tx)).toEqual([]);
        throw new Error("stop");
      });
      await expect(failed).rejects.toThrow("stop");
      expect(await listQueuePositions(db)).toHaveLength(1);
      await db.transaction(async (outer) => {
        await saveQueuePositions(outer, [], { busy: 0, total: 1 }, 3);
        await outer
          .transaction(async (inner) => {
            await insertWorkItem(inner, "b");
            throw new Error("inner");
          })
          .catch(() => {});
      });
      expect(await listQueuePositions(db)).toEqual([]);
      await expect(saveQueuePositions(db, ["b"], { busy: 0, total: 1 }, 4)).rejects.toThrow();
    } finally {
      await close();
    }
  });

  test("independent transactions started together each commit their own rows", async () => {
    const { db, close } = await open();
    try {
      const writes = ["a", "b"].map((id) =>
        db.transaction(async (tx) => {
          await insertWorkItem(tx, id);
          await saveQueuePositions(tx, [id], { busy: 0, total: 1 }, 1);
        }),
      );
      await Promise.all(writes);
      expect((await listQueuePositions(db)).map((entry) => entry.itemId)).toEqual(["b"]);
      await expect(saveQueuePositions(db, ["a", "b"], { busy: 0, total: 1 }, 2)).resolves.toBe(
        undefined,
      );
    } finally {
      await close();
    }
  });
});

test("on SQLite the functions settle before they return, and settled() refuses a pending promise", async () => {
  const db = tempDb();
  try {
    insertQueuedItem(db, { id: "a", now: 0 });
    settled(saveQueuePositions(sqliteDb(db), ["a"], { busy: 1, total: 1 }, 1));
    expect(settled(getQueuePosition(sqliteDb(db), "a"))?.position).toBe(1);
    expect(() => settled(new Promise(() => {}))).toThrow("pending");
    let inner: Promise<void> | undefined;
    immediate(db, () => {
      inner = sqliteDb(db).transaction(() => saveQueuePositions(sqliteDb(db), [], null, 3));
    });
    await expect(inner!).rejects.toThrow("synchronous immediate()");
    expect(settled(getQueuePosition(sqliteDb(db), "a"))?.position).toBe(1);
    expect(() =>
      settled(saveQueuePositions(sqliteDb(db), ["missing"], { busy: 1, total: 1 }, 2)),
    ).toThrow("FOREIGN KEY");
  } finally {
    db.close();
  }
});
