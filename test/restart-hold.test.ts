import { afterEach, describe, expect, test } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
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
  recoverOnStartup,
  requeueOrphanedWork,
  restartHold,
  saveCheckpoint,
  type Db,
} from "../src/db";
import { attachOrchestrator, questionEffects } from "../src/loop";
import { findOpenQuestion } from "../src/questions";
import { answerPg as answer } from "./questions";
import { workspaceAdmission } from "./fake-workspace";
import { seed as seedRows } from "./dialects";
import { tempHome, withHomeStore } from "./helpers";
import { tempStore } from "./pglite";

const LATER = 2 * 60 * 60_000;
const ORPHAN_LATER = 60 * 60_000;

async function seed(db: Db): Promise<void> {
  await insertQueuedItem(db, { id: "item", sessionKey: "session", now: 0 });
  await bindWorkItemRepository(db, "item", {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  });
  await beginImplementRun(db, "item", 1);
  await saveCheckpoint(db, "item", {
    phase: "running",
    baseSha: "base",
    wipCommit: "head",
  });
  await setState(db, { recoveryAttempts: 1, resumedAt: 1 });
}

function setState(
  db: Db,
  set: { state?: "cancelled"; recoveryAttempts?: number; resumedAt?: number },
) {
  return seedRows(db, (q) =>
    q.orm.update(q.t.workItem).set(set).where(eq(q.t.workItem.id, "item")),
  );
}

const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of opened.splice(0)) await close();
});

async function fixture(): Promise<Db> {
  const { db, close } = await tempStore();
  opened.push(close);
  await seed(db);
  return db;
}

async function asks(db: Db) {
  return (await listJobs(db)).filter((job) => job.queue === "item.ask");
}

async function liveAsks(db: Db) {
  return (await asks(db)).filter((job) => job.status === "pending" || job.status === "running");
}

async function executions(db: Db) {
  return (await listJobs(db)).filter(
    (job) =>
      [JOB_KIND.resume, JOB_KIND.start, JOB_KIND.reverify].includes(job.queue as never) &&
      (job.status === "pending" || job.status === "running"),
  );
}

async function actionableQuestions(db: Db) {
  return (await db.run((q) => q.all(q.orm.select().from(q.t.question)))).filter(
    (row) =>
      row.reason === "restart" &&
      row.cancelledAt === null &&
      (row.status === "open" || row.status === "queued"),
  );
}

function orchestrate(db: Db, now: number) {
  const clock = new FakeClock(now);
  const jobs = new JobLoop(db, clock);
  attachOrchestrator({
    store: db,
    jobs,
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: tempHome(),
    admission: workspaceAdmission(db),
  });
  return jobs;
}

async function loseDelivery(db: Db, how: "cancelled" | "completed", now: number): Promise<void> {
  if (how === "cancelled") await cancelOpenJobs(db, { itemId: "item", reason: "interrupted", now });
  else
    await seedRows(db, (q) =>
      q.orm
        .update(q.t.job)
        .set({ status: "done", finishedAt: now, lockedBy: null })
        .where(and(eq(q.t.job.queue, "item.ask"), inArray(q.t.job.status, ["pending", "running"]))),
    );
}

describe("restart hold", () => {
  test("three startups across file reopens keep one decision and no execution", async () => {
    const home = tempHome();
    await withHomeStore(home, async (db) => {
      await seed(db);
      expect((await recoverOnStartup(db, 100)).map((decision) => decision.type)).toEqual([
        "ask_restart",
      ]);
      expect((await getWorkItem(db, "item"))?.state).toBe("recovering");
    });

    for (const [index, now] of [200, LATER, LATER * 2, LATER * 3].entries())
      await withHomeStore(home, async (db) => {
        if (index % 2 === 0) await loseDelivery(db, "cancelled", now - 1);
        expect((await recoverOnStartup(db, now)).map((decision) => decision.type)).toEqual([
          "ask_restart",
        ]);
        expect(await restartHold(db, (await getWorkItem(db, "item"))!)).not.toBeNull();
        expect(await liveAsks(db)).toHaveLength(1);
        expect(await executions(db)).toEqual([]);
      });
  });

  test.each(["pending", "cancelled", "completed"] as const)(
    "the startup window and orphan grace keep the decision when delivery is %s",
    async (delivery) => {
      const db = await fixture();
      await recoverOnStartup(db, 100);
      if (delivery !== "pending") await loseDelivery(db, delivery, 150);
      expect(await requeueOrphanedWork(db, ORPHAN_LATER)).toEqual([]);
      expect(await executions(db)).toEqual([]);
      expect(await liveAsks(db)).toHaveLength(1);
      if (delivery !== "pending") await loseDelivery(db, delivery, ORPHAN_LATER + 1);
      await recoverOnStartup(db, ORPHAN_LATER + LATER);
      expect((await getWorkItem(db, "item"))?.state).toBe("recovering");
      expect(await executions(db)).toEqual([]);
      expect(await liveAsks(db)).toHaveLength(1);
    },
  );

  test("a delivered question survives startups, and one answer resumes once", async () => {
    const db = await fixture();
    await recoverOnStartup(db, 100);
    await orchestrate(db, 200).tick(["item.ask"]);
    expect((await getWorkItem(db, "item"))?.state).toBe("awaiting_input");
    for (const now of [300, LATER, LATER * 2]) {
      await recoverOnStartup(db, now);
      expect(await requeueOrphanedWork(db, now + ORPHAN_LATER)).toEqual([]);
    }
    expect(await liveAsks(db)).toEqual([]);
    expect(await actionableQuestions(db)).toHaveLength(1);
    expect(await executions(db)).toEqual([]);

    const reply = {
      sessionId: "session",
      deliveryId: "reply-1",
      body: "Start again",
      answeredBy: "lead",
      now: LATER * 3,
    };
    expect((await answer(db, reply, questionEffects(db, { now: reply.now }))).status).toBe(
      "answered",
    );
    expect((await answer(db, reply, questionEffects(db, { now: reply.now }))).status).toBe(
      "duplicate",
    );
    expect(
      (
        await answer(
          db,
          { ...reply, deliveryId: "reply-2" },
          questionEffects(db, { now: reply.now }),
        )
      ).status,
    ).toBe("unasked");
    const item = (await getWorkItem(db, "item"))!;
    expect(item).toMatchObject({ state: "queued", recoveryAttempts: 1 });
    expect(await restartHold(db, item)).toBeNull();
    expect(await executions(db)).toHaveLength(1);
    expect((await executions(db))[0]?.jobKey).toStartWith("resume:answer:");
  });

  test("an answer to a cancelled restart question does not resume", async () => {
    const db = await fixture();
    await recoverOnStartup(db, 100);
    await orchestrate(db, 200).tick(["item.ask"]);
    await seedRows(db, (q) =>
      q.orm
        .update(q.t.question)
        .set({ cancelledAt: 250 })
        .where(eq(q.t.question.reason, "restart")),
    );
    const reply = { sessionId: "session", deliveryId: "late", body: "Go", answeredBy: "lead" };
    expect((await answer(db, reply, questionEffects(db, { now: 300 }))).status).toBe("unasked");
    expect(await executions(db)).toEqual([]);
    await recoverOnStartup(db, LATER);
    expect(await liveAsks(db)).toHaveLength(1);
    expect(await executions(db)).toEqual([]);
  });

  test("a resume job that reaches a held item does not run it", async () => {
    const db = await fixture();
    await recoverOnStartup(db, 100);
    const runs = (await listRuns(db, "item")).length;
    await enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "stray",
      payload: { itemId: "item", freshSession: true, reason: "agent_dead" },
      now: 150,
    });
    await orchestrate(db, 200).tick([JOB_KIND.resume]);
    expect((await listWorkItemEventRows(db, "item")).map((event) => event.event)).not.toContain(
      "recovered",
    );
    expect(await restartHold(db, (await getWorkItem(db, "item"))!)).not.toBeNull();
    expect(await listRuns(db, "item")).toHaveLength(runs);
  });

  test("a second ask decision keeps the first question instead of adding one", async () => {
    const db = await fixture();
    await recoverOnStartup(db, 100);
    await orchestrate(db, 200).tick(["item.ask"]);
    await applyDecision(db, (await getWorkItem(db, "item"))!, { type: "ask_restart" }, 300);
    expect(await liveAsks(db)).toEqual([]);
    expect(await actionableQuestions(db)).toHaveLength(1);
    expect((await findOpenQuestion(db, "session"))?.reason).toBe("restart");
  });

  test("leaving the held states releases the hold", async () => {
    const db = await fixture();
    await recoverOnStartup(db, 100);
    expect(await restartHold(db, (await getWorkItem(db, "item"))!)).not.toBeNull();
    await setState(db, { state: "cancelled" });
    expect(await restartHold(db, (await getWorkItem(db, "item"))!)).toBeNull();
  });
});
