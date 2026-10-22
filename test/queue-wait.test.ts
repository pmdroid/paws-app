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
  saveQueuePositions,
} from "../src/db";
import { Orchestrator } from "../src/loop";
import { createLiveStatusProvider } from "../src/web";
import { tempDb, tempHome } from "./helpers";

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

test("a ready item waiting for a runner slot is queued once in Linear and fails after a day", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    db,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot: tempHome(),
    dispatchReady() {},
  });
  try {
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
    expect(bodies("thought").filter((body) => body.startsWith("Queued:"))).toHaveLength(1);

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
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    clock,
    pawsRoot,
    dispatchReady() {
      saveQueuePositions(db, ["ahead", "waiting"], { busy: 4, total: 4 }, clock.now());
    },
  });
  try {
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
      "Queued, 2nd in line. 4 of 4 runner slots are busy. Paws starts PAS-1 when a slot frees.",
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
  } finally {
    db.close();
  }
});
