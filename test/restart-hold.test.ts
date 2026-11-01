import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyDecision,
  beginImplementRun,
  bindWorkItemRepository,
  cancelOpenJobs,
  enqueueJob,
  getWorkItem,
  insertQueuedItem,
  listJobs,
  listRuns,
  listWorkItemEventRows,
  migrate,
  openDatabase,
  recoverOnStartup,
  requeueOrphanedWork,
  restartHold,
  saveCheckpoint,
} from "../src/db";
import { attachOrchestrator, questionEffects } from "../src/loop";
import { answer, findOpenQuestion } from "../src/questions";
import { workspaceAdmission } from "./fake-workspace";
import { migratedDatabase, tempDb, tempHome } from "./helpers";

const LATER = 2 * 60 * 60_000;
const ORPHAN_LATER = 60 * 60_000;

function seed(db: Database): void {
  insertQueuedItem(db, { id: "item", sessionKey: "session", now: 0 });
  bindWorkItemRepository(db, "item", {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  });
  beginImplementRun(db, "item", 1);
  saveCheckpoint(db, "item", { phase: "running", baseSha: "base", wipCommit: "head" });
  db.run("UPDATE work_item SET recovery_attempts=1, resumed_at=1 WHERE id='item'");
}

function fixture(): Database {
  const db = tempDb();
  seed(db);
  return db;
}

function asks(db: Database) {
  return listJobs(db).filter((job) => job.queue === "item.ask");
}

function liveAsks(db: Database) {
  return asks(db).filter((job) => job.status === "pending" || job.status === "running");
}

function executions(db: Database) {
  return listJobs(db).filter(
    (job) =>
      [JOB_KIND.resume, JOB_KIND.start, JOB_KIND.reverify].includes(job.queue as never) &&
      (job.status === "pending" || job.status === "running"),
  );
}

function actionableQuestions(db: Database) {
  return db
    .query(
      "SELECT id,status FROM question WHERE reason='restart' AND cancelled_at IS NULL AND status IN ('open','queued')",
    )
    .all();
}

function orchestrate(db: Database, now: number) {
  const clock = new FakeClock(now);
  const jobs = new JobLoop(db, clock);
  attachOrchestrator({
    db,
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: tempHome(),
    admission: workspaceAdmission(db),
  });
  return jobs;
}

function loseDelivery(db: Database, how: "cancelled" | "completed", now: number): void {
  if (how === "cancelled") cancelOpenJobs(db, { itemId: "item", reason: "interrupted", now });
  else
    db.run(
      "UPDATE job SET status='done', finished_at=?, locked_by=NULL WHERE queue='item.ask' AND status IN ('pending','running')",
      [now],
    );
}

describe("restart hold", () => {
  test("three startups across file reopens keep one decision and no execution", () => {
    const path = join(tempHome(), "paws.db");
    let db = migratedDatabase(path);
    seed(db);
    expect(recoverOnStartup(db, 100).map((decision) => decision.type)).toEqual(["ask_restart"]);
    expect(getWorkItem(db, "item")?.state).toBe("recovering");
    db.close();

    for (const [index, now] of [200, LATER, LATER * 2, LATER * 3].entries()) {
      db = openDatabase(path);
      migrate(db);
      if (index % 2 === 0) loseDelivery(db, "cancelled", now - 1);
      expect(recoverOnStartup(db, now).map((decision) => decision.type)).toEqual(["ask_restart"]);
      expect(restartHold(db, getWorkItem(db, "item")!)).not.toBeNull();
      expect(liveAsks(db)).toHaveLength(1);
      expect(executions(db)).toEqual([]);
      db.close();
    }
  });

  test.each(["pending", "cancelled", "completed"] as const)(
    "the startup window and orphan grace keep the decision when delivery is %s",
    (delivery) => {
      const db = fixture();
      recoverOnStartup(db, 100);
      if (delivery !== "pending") loseDelivery(db, delivery, 150);
      expect(requeueOrphanedWork(db, ORPHAN_LATER)).toEqual([]);
      expect(executions(db)).toEqual([]);
      expect(liveAsks(db)).toHaveLength(1);
      if (delivery !== "pending") loseDelivery(db, delivery, ORPHAN_LATER + 1);
      recoverOnStartup(db, ORPHAN_LATER + LATER);
      expect(getWorkItem(db, "item")?.state).toBe("recovering");
      expect(executions(db)).toEqual([]);
      expect(liveAsks(db)).toHaveLength(1);
      db.close();
    },
  );

  test("a delivered question survives startups, and one answer resumes once", async () => {
    const db = fixture();
    recoverOnStartup(db, 100);
    await orchestrate(db, 200).tick(["item.ask"]);
    expect(getWorkItem(db, "item")?.state).toBe("awaiting_input");
    for (const now of [300, LATER, LATER * 2]) {
      recoverOnStartup(db, now);
      expect(requeueOrphanedWork(db, now + ORPHAN_LATER)).toEqual([]);
    }
    expect(liveAsks(db)).toEqual([]);
    expect(actionableQuestions(db)).toHaveLength(1);
    expect(executions(db)).toEqual([]);

    const reply = {
      sessionId: "session",
      deliveryId: "reply-1",
      body: "Start again",
      answeredBy: "lead",
      now: LATER * 3,
    };
    expect(answer(db, reply, questionEffects(db, { now: reply.now })).status).toBe("answered");
    expect(answer(db, reply, questionEffects(db, { now: reply.now })).status).toBe("duplicate");
    expect(
      answer(db, { ...reply, deliveryId: "reply-2" }, questionEffects(db, { now: reply.now }))
        .status,
    ).toBe("unasked");
    const item = getWorkItem(db, "item")!;
    expect(item).toMatchObject({ state: "queued", recoveryAttempts: 1 });
    expect(restartHold(db, item)).toBeNull();
    expect(db.query("SELECT 1 FROM restart_hold").all()).toEqual([]);
    expect(executions(db)).toHaveLength(1);
    expect(executions(db)[0]?.jobKey).toStartWith("resume:answer:");
    db.close();
  });

  test("an answer to a cancelled restart question does not resume", async () => {
    const db = fixture();
    recoverOnStartup(db, 100);
    await orchestrate(db, 200).tick(["item.ask"]);
    db.run("UPDATE question SET cancelled_at=250 WHERE reason='restart'");
    const reply = { sessionId: "session", deliveryId: "late", body: "Go", answeredBy: "lead" };
    expect(answer(db, reply, questionEffects(db, { now: 300 })).status).toBe("unasked");
    expect(executions(db)).toEqual([]);
    recoverOnStartup(db, LATER);
    expect(liveAsks(db)).toHaveLength(1);
    expect(executions(db)).toEqual([]);
    db.close();
  });

  test("a resume job that reaches a held item does not run it", async () => {
    const db = fixture();
    recoverOnStartup(db, 100);
    const runs = listRuns(db, "item").length;
    enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "stray",
      payload: { itemId: "item", freshSession: true, reason: "agent_dead" },
      now: 150,
    });
    await orchestrate(db, 200).tick([JOB_KIND.resume]);
    expect(listWorkItemEventRows(db, "item").map((event) => event.event)).not.toContain(
      "recovered",
    );
    expect(restartHold(db, getWorkItem(db, "item")!)).not.toBeNull();
    expect(listRuns(db, "item")).toHaveLength(runs);
    db.close();
  });

  test("a second ask decision keeps the first question instead of adding one", async () => {
    const db = fixture();
    recoverOnStartup(db, 100);
    await orchestrate(db, 200).tick(["item.ask"]);
    applyDecision(db, getWorkItem(db, "item")!, { type: "ask_restart" }, 300);
    expect(liveAsks(db)).toEqual([]);
    expect(actionableQuestions(db)).toHaveLength(1);
    expect(findOpenQuestion(db, "session")?.reason).toBe("restart");
    db.close();
  });

  test("leaving the held states releases the hold", () => {
    const db = fixture();
    recoverOnStartup(db, 100);
    db.run("UPDATE work_item SET state='cancelled' WHERE id='item'");
    expect(db.query("SELECT 1 FROM restart_hold").all()).toEqual([]);
    db.close();
  });

  test("migration keeps a restart decision that was already waiting", () => {
    const db = openDatabase(":memory:");
    migrate(db, { until: "20261101T0739_job_activation" });
    seed(db);
    db.run("UPDATE work_item SET state='recovering' WHERE id='item'");
    const version = getWorkItem(db, "item")!.version;
    enqueueJob(db, {
      queue: "item.ask",
      jobKey: `restart-ask:item:${version}`,
      payload: { itemId: "item", reason: "restart" },
      now: 2,
    });
    cancelOpenJobs(db, { itemId: "item", reason: "startup", now: 3 });
    migrate(db);
    expect(restartHold(db, getWorkItem(db, "item")!)).toMatchObject({ sessionId: "session" });
    recoverOnStartup(db, LATER);
    expect(executions(db)).toEqual([]);
    expect(liveAsks(db)).toHaveLength(1);
    db.close();
  });
});
