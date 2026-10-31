import { describe, expect, test } from "bun:test";
import { FakeClock, JOB_KIND } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  applyDecision,
  applyWorkItemEvent,
  beginImplementRun,
  bindWorkItemRepository,
  claimNextJob,
  enqueueJob,
  failWorkItem,
  getJob,
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
  recordTurn,
  saveCheckpoint,
} from "../src/db";
import { acceptCloseout, ask, attachOrchestrator, questionEffects, restart } from "../src/loop";
import { answer, findOpenQuestion } from "../src/questions";
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
  test.each(["findings", "ci", "review", "conflict", "follow_up", "answer"] as const)(
    "%s restarts preserve the run and session and dispatch their original handoff",
    (reason) => {
      const { db, item } = fixture();
      db.run(
        "UPDATE work_item SET turn_count=4,recovery_attempts=2,awake_ms=500,agent_ms=500 WHERE id=?",
        [item.id],
      );
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
        turnCount: reason === "answer" ? 0 : 4,
        recoveryAttempts: 2,
        awakeMs: 500,
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

  test.each(["answer", "follow_up", "conflict"] as const)(
    "%s authorized restart of failed work clears cancellation and admits on the next scheduler tick",
    (reason) => {
      const { db, item } = fixture();
      try {
        db.run(
          "UPDATE work_item SET turn_count=3,max_turns=4,recovery_attempts=2,awake_ms=1000,max_awake_ms=1000,agent_ms=1000 WHERE id=?",
          [item.id],
        );
        expect(recordTurn(db, item.id, 2).capped).toBe(true);
        const failed = getWorkItem(db, item.id)!;
        expect(failed).toMatchObject({ state: "failed", cancelRequested: true });
        // Both existing explicit Linear retry paths clear the fence before calling restart.
        // Keep the old item snapshot to cover the criteria-change caller's stale flag.
        if (reason !== "answer")
          db.run("UPDATE work_item SET cancel_requested=0 WHERE id=?", [item.id]);
        db.run(
          "CREATE TRIGGER queue_requires_clear_fence BEFORE UPDATE OF state ON work_item WHEN NEW.state='queued' AND NEW.cancel_requested=1 BEGIN SELECT RAISE(ABORT,'queue edge still cancelled'); END",
        );
        const jobId = restart(db, failed, { reason, body: "Retry from this branch", now: 3 });
        expect(getWorkItem(db, item.id)).toMatchObject({
          state: "queued",
          cancelRequested: false,
          turnCount: 0,
          recoveryAttempts: 0,
          awakeMs: 0,
          agentMs: 0,
          maxTurns: 4,
          maxAwakeMs: 1000,
          currentRunId: item.currentRunId,
          sessionKey: item.sessionKey,
        });
        expect(workspaceDispatch(db, { now: 4 })).toEqual([item.id]);
        expect(claimNextJob(db, { now: 4 })?.id).toBe(jobId!);
        expect(getJob(db, jobId!)?.payload).toMatchObject({
          handoff: "Retry from this branch",
          reason,
        });
        expect(recordTurn(db, item.id, 5).capped).toBe(false);
        expect(getWorkItem(db, item.id)?.turnCount).toBe(1);
      } finally {
        db.close();
      }
    },
  );

  test.each(["findings", "ci", "review", "conflict", "follow_up"] as const)(
    "%s cannot automatically restart failure-fenced work or mutate its jobs",
    (reason) => {
      const { db, item } = fixture();
      try {
        db.run(
          "UPDATE work_item SET turn_count=4,recovery_attempts=2,awake_ms=500,agent_ms=500 WHERE id=?",
          [item.id],
        );
        failWorkItem(db, getWorkItem(db, item.id)!, "cap:turns", "Turn limit reached", 2);
        enqueueJob(db, { queue: JOB_KIND.reverify, payload: { itemId: item.id }, now: 2 });
        const before = {
          item: getWorkItem(db, item.id),
          run: getRun(db, item.currentRunId!),
          jobs: listJobs(db),
          events: listWorkItemEventRows(db, item.id),
          outbox: listOutbox(db),
        };
        expect(
          restart(db, before.item!, { reason, body: "Automatic feedback", now: 3 }),
        ).toBeNull();
        expect({
          item: getWorkItem(db, item.id),
          run: getRun(db, item.currentRunId!),
          jobs: listJobs(db),
          events: listWorkItemEventRows(db, item.id),
          outbox: listOutbox(db),
        }).toEqual(before);
        expect(workspaceDispatch(db, { now: 4 })).toEqual([]);
      } finally {
        db.close();
      }
    },
  );

  test.each(["cancelled", "merged", "completed"] as const)(
    "%s work cannot be restarted even by an answer",
    (state) => {
      const { db, item } = fixture();
      try {
        db.run("UPDATE work_item SET state=?,cancel_requested=1 WHERE id=?", [state, item.id]);
        const current = getWorkItem(db, item.id)!;
        expect(restart(db, current, { reason: "answer", body: "Reply", now: 2 })).toBeNull();
        expect(getWorkItem(db, item.id)).toEqual(current);
      } finally {
        db.close();
      }
    },
  );

  test("a restart of live work preserves its cancellation request", () => {
    const { db, item } = fixture();
    try {
      db.run("UPDATE work_item SET cancel_requested=1 WHERE id=?", [item.id]);
      restart(db, getWorkItem(db, item.id)!, { reason: "findings", body: "Fix findings", now: 2 });
      expect(getWorkItem(db, item.id)).toMatchObject({ state: "queued", cancelRequested: true });
      expect(workspaceDispatch(db, { now: 3 })).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("a failed resume enqueue rolls back the restart edge and cancellation reset", () => {
    const { db, item } = fixture();
    try {
      db.run(
        "UPDATE work_item SET turn_count=4,recovery_attempts=2,awake_ms=500,agent_ms=500 WHERE id=?",
        [item.id],
      );
      failWorkItem(db, getWorkItem(db, item.id)!, "auth", "Authentication failed", 2);
      const failed = getWorkItem(db, item.id)!;
      const events = listWorkItemEventRows(db, item.id);
      db.run(
        "CREATE TRIGGER reject_resume BEFORE INSERT ON job WHEN NEW.queue='run.resume' BEGIN SELECT RAISE(ABORT,'injected'); END",
      );
      expect(() => restart(db, failed, { reason: "answer", body: "Retry", now: 3 })).toThrow(
        "injected",
      );
      expect(getWorkItem(db, item.id)).toEqual(failed);
      expect(listWorkItemEventRows(db, item.id)).toEqual(events);
    } finally {
      db.close();
    }
  });

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
