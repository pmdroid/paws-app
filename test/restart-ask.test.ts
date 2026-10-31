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
      const prior = enqueueJob(db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id },
        now: 1,
      });
      joinMergeQueue(db, { itemId: item.id, repository: "owner/repo", now: 1 });
      const result = restart(db, item, { reason, body: "Keep the branch and fix this.", now: 2 });
      if (result.kind !== "restarted") throw new Error("Expected a restart");
      const jobId = result.jobId;
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
