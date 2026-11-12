import { afterEach, describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
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
  pgSchema,
  saveCheckpoint,
  type Db,
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
import { answerPg, askPg } from "./questions";
import { seed } from "./dialects";
import { workspaceAdmission, workspaceDispatchPg as workspaceDispatch } from "./fake-workspace";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

const opened: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of opened.splice(0)) await close();
});

const setItem = (db: Db, set: Partial<typeof pgSchema.workItem.$inferInsert>) =>
  seed(db, (q) => q.orm.update(q.t.workItem).set(set).where(eq(q.t.workItem.id, "item")));

const setJob = (db: Db, id: number, set: Partial<typeof pgSchema.job.$inferInsert>) =>
  seed(db, (q) => q.orm.update(q.t.job).set(set).where(eq(q.t.job.id, id)));

const questions = (db: Db) => db.run((q) => q.all(q.orm.select().from(q.t.question)));

async function fixture() {
  const { db, close } = await tempStore();
  opened.push(close);
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
  return { db, item: (await getWorkItem(db, "item"))! };
}

describe("restart and ask", () => {
  test("a durable merge marker fences restart until the lane settles the merge call", async () => {
    const { db } = await fixture();
    await setItem(db, { state: "merge_queue" });
    await joinMergeQueue(db, { itemId: "item", repository: "owner/repo", now: 2 });
    const jobs = (await listJobs(db)).length;
    const queue = await listMergeQueues(db);
    await beginMergeCall(db, "item", "head", 3);
    expect(
      await restart(db, (await getWorkItem(db, "item"))!, {
        reason: "review",
        body: "Fix it.",
        now: 4,
      }),
    ).toBeNull();
    expect((await getWorkItem(db, "item"))?.state).toBe("merge_queue");
    expect(await listJobs(db)).toHaveLength(jobs);
    expect(await listMergeQueues(db)).toEqual(queue);
    await endMergeCall(db, "item");
    expect(
      await restart(db, (await getWorkItem(db, "item"))!, {
        reason: "review",
        body: "Fix it.",
        now: 5,
      }),
    ).not.toBeNull();
    expect((await getWorkItem(db, "item"))?.state).toBe("queued");
  });

  test("a failed item restarted with a stale cancel request is queued ready to start", async () => {
    const { db } = await fixture();
    await setItem(db, { state: "failed", cancelRequested: 1, recoveryAttempts: 2 });
    await restart(db, (await getWorkItem(db, "item"))!, {
      reason: "answer",
      body: "Try again.",
      now: 2,
    });
    expect(await getWorkItem(db, "item")).toMatchObject({
      state: "queued",
      cancelRequested: false,
      recoveryAttempts: 0,
    });
    expect(await itemReadiness(db, "item", "start")).not.toBe("cancelled");
  });

  test("a restart keeps the cancel request of an item a person is stopping", async () => {
    const { db } = await fixture();
    await setItem(db, { cancelRequested: 1 });
    await restart(db, (await getWorkItem(db, "item"))!, {
      reason: "findings",
      body: "Fix this.",
      now: 2,
    });
    expect((await getWorkItem(db, "item"))?.cancelRequested).toBe(true);
  });

  test.each(["findings", "ci", "review", "conflict", "follow_up", "answer"] as const)(
    "%s restarts preserve the run and session and dispatch their original handoff",
    async (reason) => {
      const { db, item } = await fixture();
      const prior = await enqueueJob(db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: item.id },
        now: 1,
      });
      await joinMergeQueue(db, { itemId: item.id, repository: "owner/repo", now: 1 });
      const jobId = await restart(db, item, {
        reason,
        body: "Keep the branch and fix this.",
        now: 2,
      });
      const queued = (await getWorkItem(db, item.id))!;
      expect(queued).toMatchObject({
        state: "queued",
        sessionKey: item.sessionKey,
        currentRunId: item.currentRunId,
      });
      expect(queued.version).toBeGreaterThan(item.version);
      expect(await listRuns(db, item.id)).toHaveLength(1);
      expect((await getRun(db, item.currentRunId!))?.status).toBe("ended");
      expect((await getJob(db, prior))?.status).toBe("cancelled");
      expect(await db.run((q) => q.all(q.orm.select().from(q.t.mergeQueueEntry)))).toEqual([]);
      const event = (await listWorkItemEventRows(db, item.id)).at(-1)!;
      expect(event).toMatchObject({ kind: "restart", reason, version: queued.version });
      expect(event.payloadDigest).toMatch(/^[a-f0-9]{64}$/);
      expect(await workspaceDispatch(db, { now: 3 })).toEqual([item.id]);
      expect((await claimNextJob(db, { now: 3 }))?.id).toBe(jobId!);
      expect((await getJob(db, jobId!))?.payload).toMatchObject({
        handoff: "Keep the branch and fix this.",
        runId: item.currentRunId,
      });
      expect((await listJobs(db)).filter((job) => job.queue === JOB_KIND.start)).toHaveLength(0);
    },
  );

  test("same-head CI recurs with fresh handoff and accounting, while stale replays do nothing", async () => {
    const { db, item } = await fixture();
    const jobKey = "ci-failed:item:recheck:head";
    const first = (await restart(db, item, {
      reason: "ci",
      body: "first failure",
      jobKey,
      now: 2,
    }))!;
    expect(
      await restart(db, item, { reason: "ci", body: "first failure", jobKey, now: 2 }),
    ).toBeNull();
    expect(await fixRounds(db, item.id)).toBe(1);
    await setJob(db, first, { status: "done", attempts: 4, finishedAt: 3 });
    await beginImplementRun(db, item.id, 4);
    const secondItem = (await getWorkItem(db, item.id))!;
    const second = (await restart(db, secondItem, {
      reason: "ci",
      body: "second failure",
      jobKey,
      now: 5,
    }))!;
    expect(second).toBe(first);
    expect(await getJob(db, second)).toMatchObject({
      status: "pending",
      attempts: 0,
      runAt: 5,
      finishedAt: null,
      payload: { handoff: "second failure", reason: "ci" },
    });
    expect(await jobVersionCurrent(db, (await getJob(db, second))!)).toBe(true);
    expect(await fixRounds(db, item.id)).toBe(2);
    expect(
      await restart(db, secondItem, {
        reason: "ci",
        body: "second failure",
        jobKey,
        now: 5,
      }),
    ).toBeNull();
    expect(await fixRounds(db, item.id)).toBe(2);
    expect(await listJobs(db)).toHaveLength(1);

    await restart(db, (await getWorkItem(db, item.id))!, {
      reason: "answer",
      body: "try again",
      now: 6,
    });
    expect(await fixRounds(db, item.id)).toBe(0);
    await beginImplementRun(db, item.id, 7);
    await restart(db, (await getWorkItem(db, item.id))!, {
      reason: "ci",
      body: "third failure",
      jobKey,
      now: 8,
    });
    expect(await fixRounds(db, item.id)).toBe(1);
  });

  test("a restart without a pending job rolls back the edge and handoff", async () => {
    const { db, item } = await fixture();
    await enqueueJob(db, {
      queue: JOB_KIND.resume,
      jobKey: "blocked",
      payload: { itemId: "other" },
    });
    await seed(db, (q) =>
      q.orm.update(q.t.job).set({ status: "running" }).where(eq(q.t.job.jobKey, "blocked")),
    );
    await expect(
      restart(db, item, { reason: "ci", body: "fix", jobKey: "blocked", now: 2 }),
    ).rejects.toThrow("pending resume");
    expect(await getWorkItem(db, item.id)).toEqual(item);
    expect((await getRun(db, item.currentRunId!))?.status).toBe("active");
    expect(
      (await listWorkItemEventRows(db, item.id)).filter((event) => event.kind === "restart"),
    ).toHaveLength(0);
  });

  test("repeated startup keeps one runnable restart question and one actionable question", async () => {
    const { db } = await fixture();
    await setItem(db, { recoveryAttempts: 1, resumedAt: 1 });
    await recoverOnStartup(db, 100);
    await recoverOnStartup(db, 200);
    const pending = (await listJobs(db)).filter((job) => job.queue === "item.ask");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.status).toBe("pending");
    const clock = new FakeClock(300);
    const jobs = new JobLoop(db, clock);
    attachOrchestrator({
      store: db,
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: tempHome(),
      admission: workspaceAdmission(db),
    });
    await jobs.tick(["item.ask"]);
    await recoverOnStartup(db, 400);
    await jobs.tick(["item.ask"]);
    expect((await getWorkItem(db, "item"))?.state).toBe("awaiting_input");
    expect(
      (await questions(db)).filter((row) => row.status === "open" || row.status === "queued"),
    ).toHaveLength(1);
    expect((await findOpenQuestion(db, "session"))?.reason).toBe("restart");
  });

  test.each(["open", "queued"] as const)(
    "startup retains an existing %s restart question even when its ask job is done",
    async (status) => {
      const { db, item } = await fixture();
      const owner = { itemId: item.id, runId: item.currentRunId, sessionId: "session" };
      if (status === "queued") await askPg(db, owner, "agent", "First question", { now: 2 });
      await askPg(db, owner, "agent", "Restart?", { reason: "restart", now: 3 });
      const id = await enqueueJob(db, {
        queue: "item.ask",
        jobKey: `restart-ask:${item.id}:${item.version}`,
        payload: { itemId: item.id, reason: "restart" },
        now: 4,
      });
      await setJob(db, id, { status: "done" });
      await setItem(db, { recoveryAttempts: 1, resumedAt: 1 });
      await recoverOnStartup(db, 100);
      await recoverOnStartup(db, 200);
      expect((await getJob(db, id))?.status).toBe("done");
      expect(
        (await questions(db))
          .filter((row) => row.reason === "restart" && row.cancelledAt === null)
          .map((row) => ({ status: row.status })),
      ).toEqual([{ status }]);
    },
  );

  test("a failed restart rolls back its fence, cancellations, and capacity release", async () => {
    const { db, item } = await fixture();
    const job = await enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id },
    });
    await seed(
      db,
      (q) =>
        q.orm.execute(
          sql`CREATE FUNCTION reject_restart() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected'; END $$ LANGUAGE plpgsql`,
        ),
      (q) =>
        q.orm.execute(
          sql`CREATE TRIGGER reject_restart BEFORE INSERT ON work_item_event FOR EACH ROW WHEN (NEW.kind = 'restart') EXECUTE FUNCTION reject_restart()`,
        ),
    );
    const error = (await restart(db, item, { reason: "findings", body: "fix", now: 2 }).catch(
      (e: unknown) => e,
    )) as Error;
    expect(String(error.cause)).toContain("injected");
    expect(await getWorkItem(db, item.id)).toEqual(item);
    expect((await getJob(db, job))?.status).toBe("pending");
    expect((await getRun(db, item.currentRunId!))?.status).toBe("active");
  });

  test("an old job after restart cannot accept, ask, or execute its handler", async () => {
    const { db, item } = await fixture();
    await applyWorkItemEvent(db, item.id, "turn_ended");
    const verifying = (await getWorkItem(db, item.id))!;
    const oldId = await enqueueJob(db, {
      queue: JOB_KIND.reverify,
      payload: { itemId: item.id },
      now: 1,
    });
    const old = (await claimNextJob(db, { now: 1 }))!;
    await restart(db, verifying, { reason: "findings", body: "fix", now: 2 });
    expect(await jobVersionCurrent(db, old)).toBe(false);
    const before = {
      events: await listWorkItemEventRows(db, item.id),
      outbox: await listOutbox(db),
      jobs: await listJobs(db),
    };
    expect(
      await acceptCloseout(db, {
        itemId: item.id,
        expected: { version: verifying.version, runId: verifying.currentRunId },
        base: "base",
        head: "head",
        summary: "stale",
        now: 3,
      }),
    ).toBeNull();
    await expect(
      db.transaction((q) =>
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
      events: await listWorkItemEventRows(db, item.id),
      outbox: await listOutbox(db),
      jobs: await listJobs(db),
    }).toEqual(before);
    // Even a replay of the persisted old job is ignored at the orchestrator boundary.
    await setJob(db, oldId, { status: "pending", runAt: 0 });
    const clock = new FakeClock(3);
    const jobs = new JobLoop(db, clock);
    attachOrchestrator({
      store: db,
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: tempHome(),
      admission: workspaceAdmission(db),
    });
    await jobs.tick([JOB_KIND.reverify]);
    expect((await getWorkItem(db, item.id))?.state).toBe("queued");
    expect(await findOpenQuestion(db, "session")).toBeNull();
    expect(await listOutbox(db)).toEqual(before.outbox);
  });

  test("questions queue once, record their reason, and their answer restarts the same run", async () => {
    const { db, item } = await fixture();
    await db.transaction((q) =>
      askSteps(
        q,
        { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
        "agent",
        "Which direction?",
        { now: 2 },
      ),
    );
    const next = await db.transaction((q) =>
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
      (await listWorkItemEventRows(db, item.id))
        .filter((event) => event.kind === "ask")
        .map((event) => event.reason),
    ).toEqual(["agent", "agent"]);
    await answerPg(
      db,
      { sessionId: "session", deliveryId: "one", body: "Use A", answeredBy: "lead", now: 4 },
      questionEffects(db, { now: 4 }),
    );
    expect((await getWorkItem(db, item.id))?.state).toBe("awaiting_input");
    await answerPg(
      db,
      { sessionId: "session", deliveryId: "two", body: "Continue", answeredBy: "lead", now: 5 },
      questionEffects(db, { now: 5 }),
    );
    expect(await getWorkItem(db, item.id)).toMatchObject({
      state: "queued",
      currentRunId: item.currentRunId,
      sessionKey: "session",
    });
    const resumes = (await listJobs(db)).filter((job) => job.queue === JOB_KIND.resume);
    expect(resumes).toHaveLength(1);
    expect((resumes[0]!.payload as { handoff: string }).handoff).toContain("Answer: Use A");
    expect((resumes[0]!.payload as { handoff: string }).handoff).toContain("Answer: Continue");
  });

  test("a repeated-recovery question queues behind the existing question instead of failing", async () => {
    const { db, item } = await fixture();
    await db.transaction((q) =>
      askSteps(
        q,
        { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
        "agent",
        "Which direction?",
        { now: 2 },
      ),
    );
    await applyDecision(db, (await getWorkItem(db, item.id))!, { type: "ask_restart" }, 3);
    const clock = new FakeClock(4);
    const jobs = new JobLoop(db, clock);
    attachOrchestrator({
      store: db,
      jobs,
      outbox: new OutboxDispatcher(db, clock),
      pawsRoot: tempHome(),
      admission: workspaceAdmission(db),
    });
    await jobs.tick(["item.ask"]);
    expect((await getWorkItem(db, item.id))?.state).toBe("awaiting_input");
    expect((await findOpenQuestion(db, "session"))?.body).toBe("Which direction?");
    expect(
      (await questions(db)).filter((row) => row.status === "queued").map((row) => row.reason),
    ).toEqual(["restart"]);
  });

  test("startup keeps awaiting-input items and schedules a catch-up read", async () => {
    const { db, item } = await fixture();
    await db.transaction((q) =>
      askSteps(
        q,
        { itemId: item.id, runId: item.currentRunId, sessionId: "session" },
        "agent",
        "Continue?",
        { now: 2 },
      ),
    );
    await recoverOnStartup(db, 3);
    expect((await getWorkItem(db, item.id))?.state).toBe("awaiting_input");
    expect((await findOpenQuestion(db, "session"))?.body).toBe("Continue?");
    expect((await listJobs(db)).filter((job) => job.queue === JOB_KIND.catchup)).toHaveLength(1);
  });
});
