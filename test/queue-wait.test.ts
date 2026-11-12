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
  enqueueJob,
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
  type Db,
} from "../src/db";
import { createFakeTracker, type SessionUpdate } from "../src/linear";
import { Orchestrator } from "../src/loop";
import { createLiveStatusProvider } from "../src/dashboard";
import { eq } from "drizzle-orm";
import { forEachDialect, insertWorkItem, seed } from "./dialects";
import { tempHome } from "./helpers";
import { workspaceAdmission } from "./fake-workspace";
import { tempStore } from "./pglite";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function renameItem(db: Db, id: string, linearIdentifier: string): Promise<void> {
  return seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ linearIdentifier }).where(eq(q.t.workItem.id, id)),
  );
}

async function oneBusyRunnerSlot(db: Db): Promise<void> {
  const userId = await putWorkspaceUser(db, {
    id: "runner-owner",
    linearUserId: "runner-owner",
    name: "Owner",
    email: "owner@example.invalid",
  });
  await seed(db, (q) =>
    q.orm.insert(q.t.workspace).values({
      id: "runner-ws",
      linearOrganizationId: "runner-org",
      name: "Runners",
      createdAt: 0,
    }),
  );
  await syncWorkspaceMember(db, {
    workspaceId: "runner-ws",
    userId,
    role: "admin",
    active: true,
    teamIds: [],
    now: 0,
  });
  await seed(
    db,
    (q) =>
      q.orm.insert(q.t.runner).values({
        id: "runner",
        workspaceId: "runner-ws",
        ownerUserId: userId,
        name: "runner",
        status: "active",
        createdAt: 0,
        lastSeenAt: 100 * DAY,
      }),
    (q) => q.orm.insert(q.t.runnerCapacity).values({ runnerId: "runner", capacity: 1 }),
  );
  await insertQueuedItem(db, { id: "busy", now: -1, sessionKey: "busy-session" });
}

test("a ready item waiting for a runner slot is queued once in Linear and fails after a day", async () => {
  const { db, close: closeDb } = await tempStore();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: db,
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
    await ensureLinearSession(db, {
      sessionId: "session",
      issueId: item.linearIssueId,
      now: 1_000,
    });
    await bindLinearSessionTask(db, "session", item.delegationId);
    const bodies = async (kind: string) =>
      (await listOutbox(db))
        .map((row) => row.payload as { kind?: string; body?: string })
        .filter((payload) => payload.kind === kind)
        .map((payload) => payload.body ?? "");

    await orchestrator.reconcileExecution();
    await orchestrator.reconcileExecution();
    expect((await bodies("thought")).filter((body) => body.startsWith("Queued"))).toHaveLength(1);

    clock.advance(DAY - 1_000);
    await orchestrator.reconcileExecution();
    expect((await getWorkItem(db, "waiting"))?.state).toBe("queued");

    clock.advance(2_000);
    await orchestrator.reconcileExecution();
    expect((await getWorkItem(db, "waiting"))?.state).toBe("failed");
    expect((await bodies("error")).some((body) => body.includes("within 24 hours"))).toBe(true);
  } finally {
    await orchestrator.shutdown();
    await closeDb();
  }
});

test("the queued thought shows the place in line, and the start timeout comes from settings", async () => {
  const { db, close: closeDb } = await tempStore();
  const clock = new FakeClock(1_000);
  const pawsRoot = tempHome();
  writeFileSync(join(pawsRoot, "config.toml"), "[queue]\nstart_timeout_hours = 2\n");
  const orchestrator = new Orchestrator({
    store: db,
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
    await renameItem(db, "waiting", "PAS-1");
    await ensureLinearSession(db, {
      sessionId: "session",
      issueId: item.linearIssueId,
      now: 1_000,
    });
    await bindLinearSessionTask(db, "session", item.delegationId);
    const bodies = async (kind: string) =>
      (await listOutbox(db))
        .map((row) => row.payload as { kind?: string; body?: string })
        .filter((payload) => payload.kind === kind)
        .map((payload) => payload.body ?? "");

    await orchestrator.reconcileExecution();
    expect(await bodies("thought")).toContain(
      "Queued, 2nd in line. 1 of 1 runner slot is busy. Paws starts PAS-1 when a slot frees.",
    );

    clock.advance(2 * HOUR - 1_000);
    await orchestrator.reconcileExecution();
    expect((await getWorkItem(db, "waiting"))?.state).toBe("queued");

    clock.advance(2_000);
    await orchestrator.reconcileExecution();
    expect((await getWorkItem(db, "waiting"))?.state).toBe("failed");
    expect((await bodies("error")).some((body) => body.includes("PAS-1 within 2 hours"))).toBe(
      true,
    );
  } finally {
    await orchestrator.shutdown();
    await closeDb();
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
  const { db, close: closeDb } = await tempStore();
  try {
    await insertQueuedItem(db, { id: "ahead", now: 0 });
    await insertQueuedItem(db, { id: "waiting", now: 1 });
    await saveQueuePositions(db, ["ahead", "waiting"], { busy: 4, total: 4 }, 2);
    const queueOf = async (id: string) =>
      (await createLiveStatusProvider(db).issues()).issues.find((item) => item.id === id)?.queue;
    expect(await queueOf("waiting")).toEqual({ position: 2, busySlots: 4, totalSlots: 4 });
    await applyWorkItemEvent(db, "ahead", "dispatched");
    await saveQueuePositions(db, ["waiting"], { busy: 4, total: 4 }, 3);
    expect(await queueOf("ahead")).toBeUndefined();
    expect(await queueOf("waiting")).toEqual({ position: 1, busySlots: 4, totalSlots: 4 });
    await saveQueuePositions(db, ["waiting"], { busy: 4, total: 4 }, 4, new Map([["waiting", 3]]));
    expect(await queueOf("waiting")).toEqual({
      position: 1,
      busySlots: 4,
      totalSlots: 4,
      ownerCap: 3,
    });
  } finally {
    await closeDb();
  }
});

test("a runner-queued item names its place in the title and plan, and a restart names its reason", async () => {
  const { db, close: closeDb } = await tempStore();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: db,
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
    await renameItem(db, "waiting", "PAS-1");
    await ensureLinearSession(db, {
      sessionId: "session",
      issueId: item.linearIssueId,
      now: 1_000,
    });
    await bindLinearSessionTask(db, "session", item.delegationId);
    const latest = async (op: string) =>
      (await listOutbox(db, "session")).findLast((row) => row.op === op)?.payload as SessionUpdate;

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
      (await listOutbox(db, "session"))
        .map((row) => row.payload as { body?: string; ephemeral?: boolean })
        .filter((payload) => payload.ephemeral),
    ).toEqual([expect.objectContaining({ body: "Still 2nd in line for a runner." })]);

    // A Closeout restart that is still waiting for a runner shows what it waits to do.
    const version = (await getWorkItem(db, "waiting"))!.version;
    await seed(db, (q) =>
      q.orm.insert(q.t.workItemEvent).values({
        itemId: "waiting",
        version,
        at: 0,
        fromState: "verifying",
        toState: "queued",
        event: "restart",
        kind: "restart",
        reason: "findings",
      }),
    );
    await enqueueJob(db, {
      queue: "run.resume",
      payload: { itemId: "waiting", reason: "findings", fixRoundsAfter: 0 },
      runAt: 0,
      maxAttempts: 3,
      now: 0,
    });
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
    await closeDb();
  }
});

test("paused and recovering items get a waiting title and no ephemeral", async () => {
  const { db, close: closeDb } = await tempStore();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    store: db,
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
    await renameItem(db, "paused", "PAS-2");
    await ensureLinearSession(db, {
      sessionId: "session",
      issueId: item.linearIssueId,
      now: 1_000,
    });
    await bindLinearSessionTask(db, "session", item.delegationId);
    await applyWorkItemEvent(db, "paused", "dispatched");
    await applyWorkItemEvent(db, "paused", "pause");
    await putWorkspaceUser(db, {
      id: "pascal",
      linearUserId: "pascal",
      name: "Pascal",
      email: "pascal@example.invalid",
    });
    await seed(db, (q) =>
      q.orm.insert(q.t.workspaceAccessAudit).values({
        workspaceId: null,
        userId: "pascal",
        action: "execution.pause",
        subject: "paused",
        createdAt: 0,
      }),
    );
    const summary = async () =>
      (
        (await listOutbox(db, "session")).findLast((row) => row.op === "linear.session.summary")
          ?.payload as SessionUpdate | undefined
      )?.summary;
    await orchestrator.reconcileExecution();
    expect(await summary()).toBe("PAS-2: paused by Pascal");
    clock.advance(60 * 60_000);
    await orchestrator.reconcileExecution();
    expect((await listOutbox(db, "session")).filter((row) => row.op === "activity")).toEqual([]);

    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ state: "recovering" }).where(eq(q.t.workItem.id, "paused")),
    );
    clock.advance(5 * 60_000);
    await orchestrator.reconcileExecution();
    expect(await summary()).toBe("PAS-2: recovering an interrupted turn");
  } finally {
    await orchestrator.shutdown();
    await closeDb();
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
