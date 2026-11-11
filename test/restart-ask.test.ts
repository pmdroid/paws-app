import { describe, expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyDecision,
  applyWorkItemEvent,
  beginImplementRun,
  beginMergeCall,
  endMergeCall,
  listMergeQueues,
  bindWorkItemRepository,
  claimNextJob,
  enqueueJob,
  getJob,
  fixRounds,
  getRun,
  getWorkItem,
  insertQueuedItem,
  jobVersionCurrent,
  joinMergeQueue,
  listJobs,
  listOutbox,
  listRuns,
  listWorkItemEventRows,
  recoverOnStartup,
  saveCheckpoint,
  sqliteDb,
} from "../src/db";
import {
  acceptCloseout,
  askSteps,
  attachOrchestrator,
  questionEffects,
  restart,
} from "../src/loop";
import { itemReadiness } from "../src/intake";
import { findOpenQuestion } from "../src/questions";
import { ask as rawAsk, answer } from "./questions";
import { workspaceAdmission, workspaceDispatch } from "./fake-workspace";
import { tempDb, tempHome } from "./helpers";

async function fixture() {
  const db = tempDb();
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
  return { db, item: (await getWorkItem(sqliteDb(db), "item"))! };
}

describe("restart and ask", () => {
  test("a durable merge marker fences restart until the lane settles the merge call", async () => {
    const { db } = await fixture();
    db.run("UPDATE work_item SET state='merge_queue' WHERE id='item'");
    await joinMergeQueue(sqliteDb(db), { itemId: "item", repository: "owner/repo", now: 2 });
    const jobs = (await listJobs(sqliteDb(db))).length;
    const queue = listMergeQueues(db);
    await beginMergeCall(sqliteDb(db), "item", "head", 3);
    expect(
      restart(db, (await getWorkItem(sqliteDb(db), "item"))!, {
        reason: "review",
        body: "Fix it.",
        now: 4,
      }),
    ).toBeNull();
    expect((await getWorkItem(sqliteDb(db), "item"))?.state).toBe("merge_queue");
    expect(await listJobs(sqliteDb(db))).toHaveLength(jobs);
    expect(listMergeQueues(db)).toEqual(queue);
    await endMergeCall(sqliteDb(db), "item");
    expect(
      restart(db, (await getWorkItem(sqliteDb(db), "item"))!, {
        reason: "review",
        body: "Fix it.",
        now: 5,
      }),
    ).not.toBeNull();
    expect((await getWorkItem(sqliteDb(db), "item"))?.state).toBe("queued");
  });

  test("a failed item restarted with a stale cancel request is queued ready to start", async () => {
    const { db } = await fixture();
    db.run(
      "UPDATE work_item SET state='failed',cancel_requested=1,recovery_attempts=2 WHERE id='item'",
    );
    restart(db, (await getWorkItem(sqliteDb(db), "item"))!, {
      reason: "answer",
      body: "Try again.",
      now: 2,
    });
    expect(await getWorkItem(sqliteDb(db), "item")).toMatchObject({
      state: "queued",
      cancelRequested: false,
      recoveryAttempts: 0,
    });
    expect(await itemReadiness(db, "item", "start")).not.toBe("cancelled");
  });

  test("a restart keeps the cancel request of an item a person is stopping", async () => {
    const { db } = await fixture();
    db.run("UPDATE work_item SET cancel_requested=1 WHERE id='item'");
    restart(db, (await getWorkItem(sqliteDb(db), "item"))!, {
      reason: "findings",
      body: "Fix this.",
      now: 2,
    });
    expect((await getWorkItem(sqliteDb(db), "item"))?.cancelRequested).toBe(true);
  });

  test.each(["findings", "ci", "review", "conflict", "follow_up", "answer"] as const)(
    "%s restarts preserve the run and session and dispatch their original handoff",
    async (reason) => {
      const { db, item } = await fixture();
      const prior = await enqueueJob(sqliteDb(db), {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id },
        now: 1,
      });
      await joinMergeQueue(sqliteDb(db), { itemId: item.id, repository: "owner/repo", now: 1 });
      const jobId = restart(db, item, { reason, body: "Keep the branch and fix this.", now: 2 });
      const queued = (await getWorkItem(sqliteDb(db), item.id))!;
      expect(queued).toMatchObject({
        state: "queued",
        sessionKey: item.sessionKey,
        currentRunId: item.currentRunId,
      });
      expect(queued.version).toBeGreaterThan(item.version);
      expect(await listRuns(sqliteDb(db), item.id)).toHaveLength(1);
      expect((await getRun(sqliteDb(db), item.currentRunId!))?.status).toBe("ended");
      expect((await getJob(sqliteDb(db), prior))?.status).toBe("cancelled");
      expect(db.query("SELECT 1 FROM merge_queue_entry WHERE item_id=?").get(item.id)).toBeNull();
      const event = (await listWorkItemEventRows(sqliteDb(db), item.id)).at(-1)!;
      expect(event).toMatchObject({ kind: "restart", reason, version: queued.version });
      expect(event.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(await workspaceDispatch(db, { now: 3 })).toEqual([item.id]);
      expect((await claimNextJob(sqliteDb(db), { now: 3 }))?.id).toBe(jobId!);
      expect((await getJob(sqliteDb(db), jobId!))?.payload).toMatchObject({
        handoff: "Keep the branch and fix this.",
        runId: item.currentRunId,
      });
      expect(
        (await listJobs(sqliteDb(db))).filter((job) => job.queue === JOB_KIND.start),
      ).toHaveLength(0);
      db.close();
    },
  );

  test("same-head CI recurs with fresh handoff and accounting, while stale replays do nothing", async () => {
    const { db, item } = await fixture();
    const jobKey = "ci-failed:item:recheck:head";
    const first = restart(db, item, { reason: "ci", body: "first failure", jobKey, now: 2 })!;
    expect(restart(db, item, { reason: "ci", body: "first failure", jobKey, now: 2 })).toBeNull();
    expect(fixRounds(db, item.id)).toBe(1);
    db.run("UPDATE job SET status='done', attempts=4, finished_at=3 WHERE id=?", [first]);
    await beginImplementRun(sqliteDb(db), item.id, 4);
    const secondItem = (await getWorkItem(sqliteDb(db), item.id))!;
    const second = restart(db, secondItem, {
      reason: "ci",
      body: "second failure",
      jobKey,
      now: 5,
    })!;
    expect(second).toBe(first);
    expect(await getJob(sqliteDb(db), second)).toMatchObject({
      status: "pending",
      attempts: 0,
      runAt: 5,
      finishedAt: null,
      payload: { handoff: "second failure", reason: "ci" },
    });
    expect(await jobVersionCurrent(sqliteDb(db), (await getJob(sqliteDb(db), second))!)).toBe(true);
    expect(fixRounds(db, item.id)).toBe(2);
    expect(
      restart(db, secondItem, { reason: "ci", body: "second failure", jobKey, now: 5 }),
    ).toBeNull();
    expect(fixRounds(db, item.id)).toBe(2);
    expect(await listJobs(sqliteDb(db))).toHaveLength(1);

    restart(db, (await getWorkItem(sqliteDb(db), item.id))!, {
      reason: "answer",
      body: "try again",
      now: 6,
    });
    expect(fixRounds(db, item.id)).toBe(0);
    await beginImplementRun(sqliteDb(db), item.id, 7);
    restart(db, (await getWorkItem(sqliteDb(db), item.id))!, {
      reason: "ci",
      body: "third failure",
      jobKey,
      now: 8,
    });
    expect(fixRounds(db, item.id)).toBe(1);
    db.close();
  });

  test("a restart without a pending job rolls back the edge and handoff", async () => {
    const { db, item } = await fixture();
    await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.resume,
      jobKey: "blocked",
      payload: { itemId: "other" },
    });
    db.run("UPDATE job SET status='running' WHERE job_key='blocked'");
    expect(() =>
      restart(db, item, { reason: "ci", body: "fix", jobKey: "blocked", now: 2 }),
    ).toThrow("pending resume");
    expect(await getWorkItem(sqliteDb(db), item.id)).toEqual(item);
    expect((await getRun(sqliteDb(db), item.currentRunId!))?.status).toBe("active");
    expect(
      (await listWorkItemEventRows(sqliteDb(db), item.id)).filter(
        (event) => event.kind === "restart",
      ),
    ).toHaveLength(0);
    db.close();
  });

  test("repeated startup keeps one runnable restart question and one actionable question", async () => {
    const { db } = await fixture();
    db.run("UPDATE work_item SET recovery_attempts=1, resumed_at=1 WHERE id='item'");
    await recoverOnStartup(sqliteDb(db), 100);
    await recoverOnStartup(sqliteDb(db), 200);
    const pending = (await listJobs(sqliteDb(db))).filter((job) => job.queue === "item.ask");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    const clock = new FakeClock(300);
    const jobs = new JobLoop(db, clock);
    attachOrchestrator({
      store: sqliteDb(db),
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: tempHome(),
      admission: workspaceAdmission(db),
    });
    await jobs.tick(["item.ask"]);
    await recoverOnStartup(sqliteDb(db), 400);
    await jobs.tick(["item.ask"]);
    expect((await getWorkItem(sqliteDb(db), "item"))?.state).toBe("awaiting_input");
    expect(
      db.query("SELECT id FROM question WHERE status IN ('open','queued')").all(),
    ).toHaveLength(1);
    expect((await findOpenQuestion(sqliteDb(db), "session"))?.reason).toBe("restart");
    db.close();
  });

  test.each(["open", "queued"] as const)(
    "startup retains an existing %s restart question even when its ask job is done",
    async (status) => {
      const { db, item } = await fixture();
      const owner = { itemId: item.id, runId: item.currentRunId, sessionId: "session" };
      if (status === "queued") await rawAsk(db, owner, "agent", "First question", { now: 2 });
      await rawAsk(db, owner, "agent", "Restart?", { reason: "restart", now: 3 });
      const id = await enqueueJob(sqliteDb(db), {
        queue: "item.ask",
        jobKey: `restart-ask:${item.id}:${item.version}`,
        payload: { itemId: item.id, reason: "restart" },
        now: 4,
      });
      db.run("UPDATE job SET status='done' WHERE id=?", [id]);
      db.run("UPDATE work_item SET recovery_attempts=1, resumed_at=1 WHERE id='item'");
      await recoverOnStartup(sqliteDb(db), 100);
      await recoverOnStartup(sqliteDb(db), 200);
      expect((await getJob(sqliteDb(db), id))?.status).toBe("done");
      expect(
        db
          .query("SELECT status FROM question WHERE reason='restart' AND cancelled_at IS NULL")
          .all(),
      ).toEqual([{ status }]);
      db.close();
    },
  );

  test("a failed restart rolls back its fence, cancellations, and capacity release", async () => {
    const { db, item } = await fixture();
    const job = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id },
    });
    db.run(
      "CREATE TRIGGER reject_restart BEFORE INSERT ON work_item_event WHEN NEW.kind='restart' BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    expect(() => restart(db, item, { reason: "findings", body: "fix", now: 2 })).toThrow(
      "injected",
    );
    expect(await getWorkItem(sqliteDb(db), item.id)).toEqual(item);
    expect((await getJob(sqliteDb(db), job))?.status).toBe("pending");
    expect((await getRun(sqliteDb(db), item.currentRunId!))?.status).toBe("active");
    db.close();
  });

  test("an old job after restart cannot accept, ask, or execute its handler", async () => {
    const { db, item } = await fixture();
    await applyWorkItemEvent(sqliteDb(db), item.id, "turn_ended");
    const verifying = (await getWorkItem(sqliteDb(db), item.id))!;
    const oldId = await enqueueJob(sqliteDb(db), {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id },
      now: 1,
    });
    const old = (await claimNextJob(sqliteDb(db), { now: 1 }))!;
    restart(db, verifying, { reason: "findings", body: "fix", now: 2 });
    expect(await jobVersionCurrent(sqliteDb(db), old)).toBe(false);
    const before = {
      events: await listWorkItemEventRows(sqliteDb(db), item.id),
      outbox: await listOutbox(sqliteDb(db)),
      jobs: await listJobs(sqliteDb(db)),
    };
    expect(
      await acceptCloseout(sqliteDb(db), {
        itemId: item.id,
        expected: { version: verifying.version, runId: verifying.currentRunId },
        base: "base",
        head: "head",
        summary: "stale",
        now: 3,
      }),
    ).toBeNull();
    await expect(
      sqliteDb(db).transaction((q) =>
        askSteps(
          q,
          {
            itemId: item.id,
            runId: verifying.currentRunId,
            sessionId: "session",
            version: verifying.version,
          },
          "agent",
          "stale?",
        ),
      ),
    ).rejects.toThrow("stale");
    expect({
      events: await listWorkItemEventRows(sqliteDb(db), item.id),
      outbox: await listOutbox(sqliteDb(db)),
      jobs: await listJobs(sqliteDb(db)),
    }).toEqual(before);
    // Even a replay of the persisted old job is ignored at the orchestrator boundary.
    db.run("UPDATE job SET status='pending', run_at=0 WHERE id=?", [oldId]);
    const clock = new FakeClock(3);
    const jobs = new JobLoop(db, clock);
    attachOrchestrator({
      store: sqliteDb(db),
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: tempHome(),
      admission: workspaceAdmission(db),
    });
    await jobs.tick([JOB_KIND.reverify]);
    expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("queued");
    expect(await findOpenQuestion(sqliteDb(db), "session")).toBeNull();
    expect(await listOutbox(sqliteDb(db))).toEqual(before.outbox);
    db.close();
  });

  test("questions queue once, record their reason, and their answer restarts the same run", async () => {
    const { db, item } = await fixture();
    await sqliteDb(db).transaction((q) =>
      askSteps(
        q,
        { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
        "agent",
        "Which direction?",
        { now: 2 },
      ),
    );
    const next = await sqliteDb(db).transaction((q) =>
      askSteps(
        q,
        { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
        "agent",
        "Start again?",
        { now: 3 },
      ),
    );
    expect(next.status).toBe("queued");
    expect(
      (await listWorkItemEventRows(sqliteDb(db), item.id))
        .filter((event) => event.kind === "ask")
        .map((event) => event.reason),
    ).toEqual(["agent", "agent"]);
    await answer(
      db,
      { sessionId: "session", deliveryId: "one", body: "Use A", answeredBy: "lead", now: 4 },
      questionEffects(sqliteDb(db), { now: 4 }),
    );
    expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("awaiting_input");
    await answer(
      db,
      { sessionId: "session", deliveryId: "two", body: "Continue", answeredBy: "lead", now: 5 },
      questionEffects(sqliteDb(db), { now: 5 }),
    );
    expect(await getWorkItem(sqliteDb(db), item.id)).toMatchObject({
      state: "queued",
      currentRunId: item.currentRunId,
      sessionKey: "session",
    });
    const resumes = (await listJobs(sqliteDb(db))).filter((job) => job.queue === JOB_KIND.resume);
    expect(resumes).toHaveLength(1);
    expect((resumes[0]!.payload as { handoff: string }).handoff).toContain("Answer: Use A");
    expect((resumes[0]!.payload as { handoff: string }).handoff).toContain("Answer: Continue");
    db.close();
  });

  test("a repeated-recovery question queues behind the existing question instead of failing", async () => {
    const { db, item } = await fixture();
    await sqliteDb(db).transaction((q) =>
      askSteps(
        q,
        { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
        "agent",
        "Which direction?",
        { now: 2 },
      ),
    );
    await applyDecision(
      sqliteDb(db),
      (await getWorkItem(sqliteDb(db), item.id))!,
      { type: "ask_restart" },
      3,
    );
    const clock = new FakeClock(4);
    const jobs = new JobLoop(db, clock);
    attachOrchestrator({
      store: sqliteDb(db),
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: tempHome(),
      admission: workspaceAdmission(db),
    });
    await jobs.tick(["item.ask"]);
    expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("awaiting_input");
    expect((await findOpenQuestion(sqliteDb(db), "session"))?.body).toBe("Which direction?");
    expect(db.query("SELECT reason FROM question WHERE status='queued'").all()).toEqual([
      { reason: "restart" },
    ]);
    db.close();
  });

  test("startup keeps awaiting-input items and schedules a catch-up read", async () => {
    const { db, item } = await fixture();
    await sqliteDb(db).transaction((q) =>
      askSteps(
        q,
        { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
        "agent",
        "Continue?",
        { now: 2 },
      ),
    );
    await recoverOnStartup(sqliteDb(db), 3);
    expect((await getWorkItem(sqliteDb(db), item.id))?.state).toBe("awaiting_input");
    expect((await findOpenQuestion(sqliteDb(db), "session"))?.body).toBe("Continue?");
    expect(
      (await listJobs(sqliteDb(db))).filter((job) => job.queue === JOB_KIND.catchup),
    ).toHaveLength(1);
    db.close();
  });
});
