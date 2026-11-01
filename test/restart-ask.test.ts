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
} from "../src/db";
import { acceptCloseout, ask, attachOrchestrator, questionEffects, restart } from "../src/loop";
import { itemReadiness } from "../src/intake";
import { ask as rawAsk, answer, findOpenQuestion } from "../src/questions";
import { workspaceAdmission, workspaceDispatch } from "./fake-workspace";
import { tempDb, tempHome } from "./helpers";

function fixture() {
  const db = tempDb();
  insertQueuedItem(db, { id: "item", sessionKey: "session", now: 0 });
  bindWorkItemRepository(db, "item", {
    owner: "owner",
    repo: "repo",
    remoteUrl: "https://example.invalid/repo.git",
  });
  beginImplementRun(db, "item", 1);
  saveCheckpoint(db, "item", { phase: "running", baseSha: "base", wipCommit: "head" });
  return { db, item: getWorkItem(db, "item")! };
}

describe("restart and ask", () => {
  test("a durable merge marker fences restart until the lane settles the merge call", () => {
    const { db } = fixture();
    db.run("UPDATE work_item SET state='merge_queue' WHERE id='item'");
    joinMergeQueue(db, { itemId: "item", repository: "owner/repo", now: 2 });
    const jobs = listJobs(db).length;
    const queue = listMergeQueues(db);
    beginMergeCall(db, "item", "head", 3);
    expect(
      restart(db, getWorkItem(db, "item")!, { reason: "review", body: "Fix it.", now: 4 }),
    ).toBeNull();
    expect(getWorkItem(db, "item")?.state).toBe("merge_queue");
    expect(listJobs(db)).toHaveLength(jobs);
    expect(listMergeQueues(db)).toEqual(queue);
    endMergeCall(db, "item");
    expect(
      restart(db, getWorkItem(db, "item")!, { reason: "review", body: "Fix it.", now: 5 }),
    ).not.toBeNull();
    expect(getWorkItem(db, "item")?.state).toBe("queued");
  });

  test("a failed item restarted with a stale cancel request is queued ready to start", () => {
    const { db } = fixture();
    db.run(
      "UPDATE work_item SET state='failed',cancel_requested=1,turn_count=5,recovery_attempts=2 WHERE id='item'",
    );
    restart(db, getWorkItem(db, "item")!, { reason: "answer", body: "Try again.", now: 2 });
    expect(getWorkItem(db, "item")).toMatchObject({
      state: "queued",
      cancelRequested: false,
      turnCount: 0,
      recoveryAttempts: 0,
    });
    expect(itemReadiness(db, "item", "start")).not.toBe("cancelled");
  });

  test("a restart keeps the cancel request of an item a person is stopping", () => {
    const { db } = fixture();
    db.run("UPDATE work_item SET cancel_requested=1 WHERE id='item'");
    restart(db, getWorkItem(db, "item")!, { reason: "findings", body: "Fix this.", now: 2 });
    expect(getWorkItem(db, "item")?.cancelRequested).toBe(true);
  });

  test.each(["findings", "ci", "review", "conflict", "follow_up", "answer"] as const)(
    "%s restarts preserve the run and session and dispatch their original handoff",
    (reason) => {
      const { db, item } = fixture();
      const prior = enqueueJob(db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id },
        now: 1,
      });
      joinMergeQueue(db, { itemId: item.id, repository: "owner/repo", now: 1 });
      const jobId = restart(db, item, { reason, body: "Keep the branch and fix this.", now: 2 });
      const queued = getWorkItem(db, item.id)!;
      expect(queued).toMatchObject({
        state: "queued",
        sessionKey: item.sessionKey,
        currentRunId: item.currentRunId,
      });
      expect(queued.version).toBeGreaterThan(item.version);
      expect(listRuns(db, item.id)).toHaveLength(1);
      expect(getRun(db, item.currentRunId!)?.status).toBe("ended");
      expect(getJob(db, prior)?.status).toBe("cancelled");
      expect(db.query("SELECT 1 FROM merge_queue_entry WHERE item_id=?").get(item.id)).toBeNull();
      const event = listWorkItemEventRows(db, item.id).at(-1)!;
      expect(event).toMatchObject({ kind: "restart", reason, version: queued.version });
      expect(event.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(workspaceDispatch(db, { now: 3 })).toEqual([item.id]);
      expect(claimNextJob(db, { now: 3 })?.id).toBe(jobId!);
      expect(getJob(db, jobId!)?.payload).toMatchObject({
        handoff: "Keep the branch and fix this.",
        runId: item.currentRunId,
      });
      expect(listJobs(db).filter((job) => job.queue === JOB_KIND.start)).toHaveLength(0);
      db.close();
    },
  );

  test("same-head CI recurs with fresh handoff and accounting, while stale replays do nothing", () => {
    const { db, item } = fixture();
    const jobKey = "ci-failed:item:recheck:head";
    const first = restart(db, item, { reason: "ci", body: "first failure", jobKey, now: 2 })!;
    expect(restart(db, item, { reason: "ci", body: "first failure", jobKey, now: 2 })).toBeNull();
    expect(fixRounds(db, item.id)).toBe(1);
    db.run("UPDATE job SET status='done', attempts=4, finished_at=3 WHERE id=?", [first]);
    beginImplementRun(db, item.id, 4);
    const secondItem = getWorkItem(db, item.id)!;
    const second = restart(db, secondItem, {
      reason: "ci",
      body: "second failure",
      jobKey,
      now: 5,
    })!;
    expect(second).toBe(first);
    expect(getJob(db, second)).toMatchObject({
      status: "pending",
      attempts: 0,
      runAt: 5,
      finishedAt: null,
      payload: { handoff: "second failure", reason: "ci" },
    });
    expect(jobVersionCurrent(db, getJob(db, second)!)).toBe(true);
    expect(fixRounds(db, item.id)).toBe(2);
    expect(
      restart(db, secondItem, { reason: "ci", body: "second failure", jobKey, now: 5 }),
    ).toBeNull();
    expect(fixRounds(db, item.id)).toBe(2);
    expect(listJobs(db)).toHaveLength(1);

    restart(db, getWorkItem(db, item.id)!, { reason: "answer", body: "try again", now: 6 });
    expect(fixRounds(db, item.id)).toBe(0);
    beginImplementRun(db, item.id, 7);
    restart(db, getWorkItem(db, item.id)!, { reason: "ci", body: "third failure", jobKey, now: 8 });
    expect(fixRounds(db, item.id)).toBe(1);
    db.close();
  });

  test("a restart without a pending job rolls back the edge and handoff", () => {
    const { db, item } = fixture();
    enqueueJob(db, { queue: JOB_KIND.resume, jobKey: "blocked", payload: { itemId: "other" } });
    db.run("UPDATE job SET status='running' WHERE job_key='blocked'");
    expect(() =>
      restart(db, item, { reason: "ci", body: "fix", jobKey: "blocked", now: 2 }),
    ).toThrow("pending resume");
    expect(getWorkItem(db, item.id)).toEqual(item);
    expect(getRun(db, item.currentRunId!)?.status).toBe("active");
    expect(
      listWorkItemEventRows(db, item.id).filter((event) => event.kind === "restart"),
    ).toHaveLength(0);
    db.close();
  });

  test("repeated startup keeps one runnable restart question and one actionable question", async () => {
    const { db } = fixture();
    db.run("UPDATE work_item SET recovery_attempts=1, resumed_at=1 WHERE id='item'");
    recoverOnStartup(db, 100);
    recoverOnStartup(db, 200);
    const pending = listJobs(db).filter((job) => job.queue === "item.ask");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    const clock = new FakeClock(300);
    const jobs = new JobLoop(db, clock);
    attachOrchestrator({
      db,
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: tempHome(),
      admission: workspaceAdmission(db),
    });
    await jobs.tick(["item.ask"]);
    recoverOnStartup(db, 400);
    await jobs.tick(["item.ask"]);
    expect(getWorkItem(db, "item")?.state).toBe("awaiting_input");
    expect(
      db.query("SELECT id FROM question WHERE status IN ('open','queued')").all(),
    ).toHaveLength(1);
    expect(findOpenQuestion(db, "session")?.reason).toBe("restart");
    db.close();
  });

  test.each(["open", "queued"] as const)(
    "startup retains an existing %s restart question even when its ask job is done",
    (status) => {
      const { db, item } = fixture();
      const owner = { itemId: item.id, runId: item.currentRunId, sessionId: "session" };
      if (status === "queued") rawAsk(db, owner, "agent", "First question", { now: 2 });
      rawAsk(db, owner, "agent", "Restart?", { reason: "restart", now: 3 });
      const id = enqueueJob(db, {
        queue: "item.ask",
        jobKey: `restart-ask:${item.id}:${item.version}`,
        payload: { itemId: item.id, reason: "restart" },
        now: 4,
      });
      db.run("UPDATE job SET status='done' WHERE id=?", [id]);
      db.run("UPDATE work_item SET recovery_attempts=1, resumed_at=1 WHERE id='item'");
      recoverOnStartup(db, 100);
      recoverOnStartup(db, 200);
      expect(getJob(db, id)?.status).toBe("done");
      expect(
        db
          .query("SELECT status FROM question WHERE reason='restart' AND cancelled_at IS NULL")
          .all(),
      ).toEqual([{ status }]);
      db.close();
    },
  );

  test("a failed restart rolls back its fence, cancellations, and capacity release", () => {
    const { db, item } = fixture();
    const job = enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId: item.id } });
    db.run(
      "CREATE TRIGGER reject_restart BEFORE INSERT ON work_item_event WHEN NEW.kind='restart' BEGIN SELECT RAISE(ABORT,'injected'); END",
    );
    expect(() => restart(db, item, { reason: "findings", body: "fix", now: 2 })).toThrow(
      "injected",
    );
    expect(getWorkItem(db, item.id)).toEqual(item);
    expect(getJob(db, job)?.status).toBe("pending");
    expect(getRun(db, item.currentRunId!)?.status).toBe("active");
    db.close();
  });

  test("an old job after restart cannot accept, ask, or execute its handler", async () => {
    const { db, item } = fixture();
    applyWorkItemEvent(db, item.id, "turn_ended");
    const verifying = getWorkItem(db, item.id)!;
    const oldId = enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id },
      now: 1,
    });
    const old = claimNextJob(db, { now: 1 })!;
    restart(db, verifying, { reason: "findings", body: "fix", now: 2 });
    expect(jobVersionCurrent(db, old)).toBe(false);
    const before = {
      events: listWorkItemEventRows(db, item.id),
      outbox: listOutbox(db),
      jobs: listJobs(db),
    };
    expect(
      acceptCloseout(db, {
        itemId: item.id,
        expected: { version: verifying.version, runId: verifying.currentRunId },
        base: "base",
        head: "head",
        summary: "stale",
        now: 3,
      }),
    ).toBeNull();
    expect(() =>
      ask(
        db,
        {
          itemId: item.id,
          runId: verifying.currentRunId,
          sessionId: "session",
          version: verifying.version,
        },
        "agent",
        "stale?",
      ),
    ).toThrow("stale");
    expect({
      events: listWorkItemEventRows(db, item.id),
      outbox: listOutbox(db),
      jobs: listJobs(db),
    }).toEqual(before);
    // Even a replay of the persisted old job is ignored at the orchestrator boundary.
    db.run("UPDATE job SET status='pending', run_at=0 WHERE id=?", [oldId]);
    const clock = new FakeClock(3);
    const jobs = new JobLoop(db, clock);
    attachOrchestrator({
      db,
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: tempHome(),
      admission: workspaceAdmission(db),
    });
    await jobs.tick([JOB_KIND.reverify]);
    expect(getWorkItem(db, item.id)?.state).toBe("queued");
    expect(findOpenQuestion(db, "session")).toBeNull();
    expect(listOutbox(db)).toEqual(before.outbox);
    db.close();
  });

  test("questions queue once, record their reason, and their answer restarts the same run", () => {
    const { db, item } = fixture();
    ask(
      db,
      { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
      "agent",
      "Which direction?",
      { now: 2 },
    );
    const next = ask(
      db,
      { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
      "agent",
      "Start again?",
      { now: 3 },
    );
    expect(next.status).toBe("queued");
    expect(
      listWorkItemEventRows(db, item.id)
        .filter((event) => event.kind === "ask")
        .map((event) => event.reason),
    ).toEqual(["agent", "agent"]);
    answer(
      db,
      { sessionId: "session", deliveryId: "one", body: "Use A", answeredBy: "lead", now: 4 },
      questionEffects(db, { now: 4 }),
    );
    expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
    answer(
      db,
      { sessionId: "session", deliveryId: "two", body: "Continue", answeredBy: "lead", now: 5 },
      questionEffects(db, { now: 5 }),
    );
    expect(getWorkItem(db, item.id)).toMatchObject({
      state: "queued",
      currentRunId: item.currentRunId,
      sessionKey: "session",
    });
    const resumes = listJobs(db).filter((job) => job.queue === JOB_KIND.resume);
    expect(resumes).toHaveLength(1);
    expect((resumes[0]!.payload as { handoff: string }).handoff).toContain("Answer: Use A");
    expect((resumes[0]!.payload as { handoff: string }).handoff).toContain("Answer: Continue");
    db.close();
  });

  test("a repeated-recovery question queues behind the existing question instead of failing", async () => {
    const { db, item } = fixture();
    ask(
      db,
      { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
      "agent",
      "Which direction?",
      { now: 2 },
    );
    applyDecision(db, getWorkItem(db, item.id)!, { type: "ask_restart" }, 3);
    const clock = new FakeClock(4);
    const jobs = new JobLoop(db, clock);
    attachOrchestrator({
      db,
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: tempHome(),
      admission: workspaceAdmission(db),
    });
    await jobs.tick(["item.ask"]);
    expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(db, "session")?.body).toBe("Which direction?");
    expect(db.query("SELECT reason FROM question WHERE status='queued'").all()).toEqual([
      { reason: "restart" },
    ]);
    db.close();
  });

  test("startup keeps awaiting-input items and schedules a catch-up read", () => {
    const { db, item } = fixture();
    ask(
      db,
      { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
      "agent",
      "Continue?",
      { now: 2 },
    );
    recoverOnStartup(db, 3);
    expect(getWorkItem(db, item.id)?.state).toBe("awaiting_input");
    expect(findOpenQuestion(db, "session")?.body).toBe("Continue?");
    expect(listJobs(db).filter((job) => job.queue === JOB_KIND.catchup)).toHaveLength(1);
    db.close();
  });
});
