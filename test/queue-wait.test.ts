import { expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  bindLinearSessionTask,
  ensureLinearSession,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  replaceQueueLine,
} from "../src/db";
import { Orchestrator } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

const DAY = 24 * 60 * 60 * 1000;

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

test("the queued thought names the place in line, and the start timeout follows the setting", async () => {
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
      replaceQueueLine(db, {
        itemIds: ["ahead", "waiting"],
        busySlots: 4,
        totalSlots: 4,
        now: clock.now(),
      });
    },
  });
  try {
    insertQueuedItem(db, { id: "ahead", now: 900, sessionKey: "other" });
    const item = insertQueuedItem(db, { id: "waiting", now: 1_000, sessionKey: "session" });
    ensureLinearSession(db, { sessionId: "session", issueId: item.linearIssueId, now: 1_000 });
    bindLinearSessionTask(db, "session", item.delegationId);
    const bodies = (kind: string) =>
      listOutbox(db)
        .filter((row) => row.orderingKey === "session")
        .map((row) => row.payload as { kind?: string; body?: string })
        .filter((payload) => payload.kind === kind)
        .map((payload) => payload.body ?? "");

    orchestrator.reconcileExecution();
    expect(bodies("thought").filter((body) => body.startsWith("Queued"))).toEqual([
      expect.stringMatching(/^Queued, 2nd in line\. 4 of 4 runner slots are busy\. Paws starts /),
    ]);

    clock.advance(2 * 3_600_000 - 1);
    orchestrator.reconcileExecution();
    expect(getWorkItem(db, "waiting")?.state).toBe("queued");

    clock.advance(1);
    orchestrator.reconcileExecution();
    expect(getWorkItem(db, "waiting")?.state).toBe("failed");
    expect(bodies("error").some((body) => body.includes("within 2 hours"))).toBe(true);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});
