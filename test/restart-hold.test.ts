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
  legacyMigrate,
  openDatabase,
  recoverOnStartup,
  requeueOrphanedWork,
  restartHold,
  saveCheckpoint,
  sqliteDb,
} from "../src/db";
import { attachOrchestrator, questionEffects } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { answer } from "./questions";
import { workspaceAdmission } from "./fake-workspace";
import { legacyMigratedDatabase, legacyTempDb, tempHome } from "./helpers";

const LATER = 2 * 60 * 60_000;
const ORPHAN_LATER = 60 * 60_000;

async function seed(db: Database): Promise<void> {
  insertQueuedItem(db, { id: "item", sessionKey: "session", now: 0 });
  await bindWorkItemRepository(sqliteDb(db), "item", {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  });
  await beginImplementRun(sqliteDb(db), "item", 1);
  await saveCheckpoint(sqliteDb(db), "item", {
    phase: "running",
    baseSha: "base",
    wipCommit: "head",
  });
  db.run("UPDATE work_item SET recovery_attempts=1, resumed_at=1 WHERE id='item'");
}

async function fixture(): Promise<Database> {
  const db = legacyTempDb();
  await seed(db);
  return db;
}

async function asks(db: Database) {
  return (await listJobs(sqliteDb(db))).filter((job) => job.queue === "item.ask");
}

async function liveAsks(db: Database) {
  return (await asks(db)).filter((job) => job.status === "pending" || job.status === "running");
}

async function executions(db: Database) {
  return (await listJobs(sqliteDb(db))).filter(
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

async function loseDelivery(
  db: Database,
  how: "cancelled" | "completed",
  now: number,
): Promise<void> {
  if (how === "cancelled")
    await cancelOpenJobs(sqliteDb(db), { itemId: "item", reason: "interrupted", now });
  else
    db.run(
      "UPDATE job SET status='done', finished_at=?, locked_by=NULL WHERE queue='item.ask' AND status IN ('pending','running')",
      [now],
    );
}

describe("restart hold", () => {
  test("three startups across file reopens keep one decision and no execution", async () => {
    const path = join(tempHome(), "paws.db");
    let db = legacyMigratedDatabase(path);
    await seed(db);
    expect((await recoverOnStartup(sqliteDb(db), 100)).map((decision) => decision.type)).toEqual([
      "ask_restart",
    ]);
    expect((await getWorkItem(sqliteDb(db), "item"))?.state).toBe("recovering");
    db.close();

    for (const [index, now] of [200, LATER, LATER * 2, LATER * 3].entries()) {
      db = openDatabase(path);
      legacyMigrate(db);
      if (index % 2 === 0) await loseDelivery(db, "cancelled", now - 1);
      expect((await recoverOnStartup(sqliteDb(db), now)).map((decision) => decision.type)).toEqual([
        "ask_restart",
      ]);
      expect(
        await restartHold(sqliteDb(db), (await getWorkItem(sqliteDb(db), "item"))!),
      ).not.toBeNull();
      expect(await liveAsks(db)).toHaveLength(1);
      expect(await executions(db)).toEqual([]);
      db.close();
    }
  });

  test.each(["pending", "cancelled", "completed"] as const)(
    "the startup window and orphan grace keep the decision when delivery is %s",
    async (delivery) => {
      const db = await fixture();
      await recoverOnStartup(sqliteDb(db), 100);
      if (delivery !== "pending") await loseDelivery(db, delivery, 150);
      expect(await requeueOrphanedWork(sqliteDb(db), ORPHAN_LATER)).toEqual([]);
      expect(await executions(db)).toEqual([]);
      expect(await liveAsks(db)).toHaveLength(1);
      if (delivery !== "pending") await loseDelivery(db, delivery, ORPHAN_LATER + 1);
      await recoverOnStartup(sqliteDb(db), ORPHAN_LATER + LATER);
      expect((await getWorkItem(sqliteDb(db), "item"))?.state).toBe("recovering");
      expect(await executions(db)).toEqual([]);
      expect(await liveAsks(db)).toHaveLength(1);
      db.close();
    },
  );

  test("a delivered question survives startups, and one answer resumes once", async () => {
    const db = await fixture();
    await recoverOnStartup(sqliteDb(db), 100);
    await orchestrate(db, 200).tick(["item.ask"]);
    expect((await getWorkItem(sqliteDb(db), "item"))?.state).toBe("awaiting_input");
    for (const now of [300, LATER, LATER * 2]) {
      await recoverOnStartup(sqliteDb(db), now);
      expect(await requeueOrphanedWork(sqliteDb(db), now + ORPHAN_LATER)).toEqual([]);
    }
    expect(await liveAsks(db)).toEqual([]);
    expect(actionableQuestions(db)).toHaveLength(1);
    expect(await executions(db)).toEqual([]);

    const reply = {
      sessionId: "session",
      deliveryId: "reply-1",
      body: "Start again",
      answeredBy: "lead",
      now: LATER * 3,
    };
    expect(
      (await answer(db, reply, questionEffects(sqliteDb(db), { now: reply.now }))).status,
    ).toBe("answered");
    expect(
      (await answer(db, reply, questionEffects(sqliteDb(db), { now: reply.now }))).status,
    ).toBe("duplicate");
    expect(
      (
        await answer(
          db,
          { ...reply, deliveryId: "reply-2" },
          questionEffects(sqliteDb(db), { now: reply.now }),
        )
      ).status,
    ).toBe("unasked");
    const item = (await getWorkItem(sqliteDb(db), "item"))!;
    expect(item).toMatchObject({ state: "queued", recoveryAttempts: 1 });
    expect(await restartHold(sqliteDb(db), item)).toBeNull();
    expect(db.query("SELECT 1 FROM restart_hold").all()).toEqual([]);
    expect(await executions(db)).toHaveLength(1);
    expect((await executions(db))[0]?.jobKey).toStartWith("resume:answer:");
    db.close();
  });

  test("an answer to a cancelled restart question does not resume", async () => {
    const db = await fixture();
    await recoverOnStartup(sqliteDb(db), 100);
    await orchestrate(db, 200).tick(["item.ask"]);
    db.run("UPDATE question SET cancelled_at=250 WHERE reason='restart'");
    const reply = { sessionId: "session", deliveryId: "late", body: "Go", answeredBy: "lead" };
    expect((await answer(db, reply, questionEffects(sqliteDb(db), { now: 300 }))).status).toBe(
      "unasked",
    );
    expect(await executions(db)).toEqual([]);
    await recoverOnStartup(sqliteDb(db), LATER);
    expect(await liveAsks(db)).toHaveLength(1);
    expect(await executions(db)).toEqual([]);
    db.close();
  });

  test("a resume job that reaches a held item does not run it", async () => {
    const db = await fixture();
    await recoverOnStartup(sqliteDb(db), 100);
    const runs = (await listRuns(sqliteDb(db), "item")).length;
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.resume,
      jobKey: "stray",
      payload: { itemId: "item", freshSession: true, reason: "agent_dead" },
      now: 150,
    });
    await orchestrate(db, 200).tick([JOB_KIND.resume]);
    expect(
      (await listWorkItemEventRows(sqliteDb(db), "item")).map((event) => event.event),
    ).not.toContain("recovered");
    expect(
      await restartHold(sqliteDb(db), (await getWorkItem(sqliteDb(db), "item"))!),
    ).not.toBeNull();
    expect(await listRuns(sqliteDb(db), "item")).toHaveLength(runs);
    db.close();
  });

  test("a second ask decision keeps the first question instead of adding one", async () => {
    const db = await fixture();
    await recoverOnStartup(sqliteDb(db), 100);
    await orchestrate(db, 200).tick(["item.ask"]);
    await applyDecision(
      sqliteDb(db),
      (await getWorkItem(sqliteDb(db), "item"))!,
      { type: "ask_restart" },
      300,
    );
    expect(await liveAsks(db)).toEqual([]);
    expect(actionableQuestions(db)).toHaveLength(1);
    expect((await findOpenQuestion(sqliteDb(db), "session"))?.reason).toBe("restart");
    db.close();
  });

  test("leaving the held states releases the hold", async () => {
    const db = await fixture();
    await recoverOnStartup(sqliteDb(db), 100);
    db.run("UPDATE work_item SET state='cancelled' WHERE id='item'");
    expect(db.query("SELECT 1 FROM restart_hold").all()).toEqual([]);
    db.close();
  });

  test("migration keeps a restart decision that was already waiting", async () => {
    const db = openDatabase(":memory:");
    legacyMigrate(db, { until: "20261101T0739_job_activation" });
    await seed(db);
    db.run("UPDATE work_item SET state='recovering' WHERE id='item'");
    const version = (await getWorkItem(sqliteDb(db), "item"))!.version;
    await enqueueJob(sqliteDb(db), {
      queue: "item.ask",
      jobKey: `restart-ask:item:${version}`,
      payload: { itemId: "item", reason: "restart" },
      now: 2,
    });
    await cancelOpenJobs(sqliteDb(db), { itemId: "item", reason: "startup", now: 3 });
    legacyMigrate(db);
    expect(
      await restartHold(sqliteDb(db), (await getWorkItem(sqliteDb(db), "item"))!),
    ).toMatchObject({
      sessionId: "session",
    });
    await recoverOnStartup(sqliteDb(db), LATER);
    expect(await executions(db)).toEqual([]);
    expect(await liveAsks(db)).toHaveLength(1);
    db.close();
  });
});
