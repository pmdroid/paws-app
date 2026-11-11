import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND, type Checkpoint } from "../src/core";
import {
  accrueAtJobBoundarySteps,
  accrueAwake,
  accrueAwakeSteps,
  applyWorkItemEventSteps,
  completeMergedItemSteps,
  deferWorkItem,
  deferWorkItemSteps,
  endAgentWaitSteps,
  enqueueOutboxOnceSteps,
  failWorkItemSteps,
  getRunSteps,
  getWorkItem,
  getWorkItemSteps,
  listWorkItemEventRowsSteps,
  markJobAwakeWaitSteps,
  onJobReady,
  recordConfirmedRemoteMergeSteps,
  savePullRequestDraftSteps,
  startAgentWaitSteps,
  TransitionRejectedError,
  withOpenFindingsSteps,
  type Db,
  type Job,
  type WorkItemRecord,
  sqliteDb,
  syncSteps,
} from "../src/db";
import { forEachDialect, insertWorkItem, json, withoutForeignKeys } from "./dialects";
import { tempDb } from "./helpers";

function parsed(value: unknown): Record<string, unknown> {
  return (typeof value === "string" ? JSON.parse(value) : value) as Record<string, unknown>;
}

type ItemValues = {
  state?: string;
  sessionKey?: string | null;
  acceptedHead?: string | null;
  lastMonoMs?: number | null;
  maxAwakeMs?: number;
  implementMs?: number;
  agentMs?: number;
  awakeMs?: number;
  waitingMs?: number;
  currentRunId?: string | null;
  checkpoint?: Checkpoint;
};

/** A work item in the given state. Runs and sessions are seeded without their parents. */
async function item(db: Db, id: string, values: ItemValues = {}): Promise<WorkItemRecord> {
  await withoutForeignKeys(db);
  await insertWorkItem(db, id);
  const { checkpoint, ...columns } = { state: "running", ...values };
  await db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.workItem)
        .set({
          ...columns,
          ...(checkpoint === undefined ? {} : { checkpoint: json(db, checkpoint) }),
        })
        .where(eq(q.t.workItem.id, id)),
    ),
  );
  return (await db.run((q) => getWorkItemSteps(q, id)))!;
}

function read(db: Db, id: string): Promise<WorkItemRecord> {
  return db.run(function* (q) {
    return (yield* getWorkItemSteps(q, id))!;
  });
}

function insertJob(
  db: Db,
  values: {
    queue: string;
    payload: unknown;
    status?: string;
    lockedBy?: string;
    lockedUntil?: number;
    attempts?: number;
  },
): Promise<number> {
  return db.run(function* (q) {
    const row = yield* q.one(
      q.orm
        .insert(q.t.job)
        .values({
          status: "pending",
          runAt: 0,
          createdAt: 0,
          ...values,
          payload: json(db, values.payload),
        })
        .returning({ id: q.t.job.id }),
    );
    return row!.id;
  });
}

function jobs(db: Db) {
  return db.run(function* (q) {
    const rows = yield* q.all(q.orm.select().from(q.t.job).orderBy(q.t.job.id));
    return rows.map((row) => ({ ...row, payload: parsed(row.payload) }));
  });
}

function outbox(db: Db) {
  return db.run(function* (q) {
    const rows = yield* q.all(q.orm.select().from(q.t.outbox).orderBy(q.t.outbox.id));
    return rows.map((row) => ({ ...row, payload: parsed(row.payload) }));
  });
}

function insertRun(db: Db, id: string, itemId: string, status = "active"): Promise<void> {
  return db.run((q) =>
    q.exec(
      q.orm.insert(q.t.run).values({
        id,
        itemId,
        status,
        kind: "implement",
        agent: "cursor",
        freshSession: 0,
        createdAt: 0,
        updatedAt: 0,
      }),
    ),
  );
}

function asJob(id: number, payload: unknown, lockedBy: string, attempts: number): Job {
  return { id, payload, lockedBy, attempts } as Job;
}

forEachDialect((open) => {
  test("a transition moves state, records its event and drops the idle clock", async () => {
    const { db, close } = await open();
    try {
      await item(db, "a", { state: "merge_queue", lastMonoMs: 5 });
      const next = await db.transaction((q) =>
        applyWorkItemEventSteps(q, "a", "pause", { now: 42, actor: "ann", reason: "because" }),
      );
      expect(next).toMatchObject({ state: "paused", version: 1 });
      const [event] = await db.run((q) => listWorkItemEventRowsSteps(q, "a"));
      expect(event).toMatchObject({
        version: 1,
        at: 42,
        fromState: "merge_queue",
        toState: "paused",
        event: "pause",
        kind: "transition",
        reason: "because",
        actor: "ann",
      });

      await item(db, "q", { state: "merge_queue", lastMonoMs: 5 });
      await db.transaction((q) => applyWorkItemEventSteps(q, "q", "work_failed"));
      expect((await read(db, "q")).state).toBe("failed");

      await expect(
        db.transaction((q) => applyWorkItemEventSteps(q, "a", "merge_accepted")),
      ).rejects.toBeInstanceOf(TransitionRejectedError);
      await expect(
        db.transaction((q) => applyWorkItemEventSteps(q, "missing", "pause")),
      ).rejects.toThrow("work item missing not found");
    } finally {
      await close();
    }
  });

  test("accrual counts live agent time, and idle time as waiting", async () => {
    const { db, close } = await open();
    try {
      await item(db, "live", { lastMonoMs: 1000 });
      const live = await db.transaction((q) =>
        accrueAwakeSteps(q, "live", 1500, 5000, undefined, true),
      );
      expect(live).toEqual({
        outcome: { capped: false, item: expect.anything() },
        jobReady: false,
      });
      expect(live.outcome.item).toMatchObject({
        awakeMs: 500,
        agentMs: 500,
        implementMs: 500,
        lastMonoMs: 1500,
      });

      await item(db, "idle", { lastMonoMs: 1000 });
      const idle = await db.transaction((q) => accrueAwakeSteps(q, "idle", 1300, 5000));
      expect(idle.outcome.item).toMatchObject({ awakeMs: 0, agentMs: 0, waitingMs: 300 });
    } finally {
      await close();
    }
  });

  test("at the cap without a session an item fails with the failure's outbox row", async () => {
    const { db, close } = await open();
    try {
      await item(db, "cap", { lastMonoMs: 1000, maxAwakeMs: 100, sessionKey: null });
      await insertRun(db, "cap-run", "cap");
      await db.run((q) =>
        q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ currentRunId: "cap-run" })
            .where(eq(q.t.workItem.id, "cap")),
        ),
      );
      const { outcome, jobReady } = await db.transaction((q) =>
        accrueAwakeSteps(q, "cap", 1500, 5000, undefined, true),
      );
      expect(outcome).toMatchObject({
        capped: true,
        item: { state: "failed", cancelRequested: true },
      });
      expect(jobReady).toBe(false);
      expect((await db.run((q) => getRunSteps(q, "cap-run")))?.status).toBe("lost");
      const [row] = await outbox(db);
      expect(row).toMatchObject({ idempotencyKey: "cap:cap:1:time" });
      expect(row!.payload).toMatchObject({ sessionId: "cap", kind: "error" });
    } finally {
      await close();
    }
  });

  test("at the cap a session asks once and cancels the agent's jobs", async () => {
    const { db, close } = await open();
    try {
      await item(db, "ask", { lastMonoMs: 1000, maxAwakeMs: 100, sessionKey: "s" });
      await insertJob(db, { queue: JOB_KIND.resume, payload: { itemId: "ask" } });
      const first = await db.transaction((q) =>
        accrueAwakeSteps(q, "ask", 1500, 5000, undefined, true),
      );
      expect(first.outcome).toMatchObject({ capped: false, asked: true, stopAgent: true });
      expect(first.jobReady).toBe(true);
      const rows = await jobs(db);
      expect(rows[0]).toMatchObject({ status: "cancelled", lastError: "time_limit" });
      expect(rows[1]).toMatchObject({ queue: "item.ask", status: "pending" });
      expect(rows[1]!.payload).toMatchObject({ itemId: "ask", kind: "time-limit" });

      const second = await db.transaction((q) =>
        accrueAwakeSteps(q, "ask", 1600, 5000, undefined, true),
      );
      expect(second.outcome.asked).toBeUndefined();
      expect(second.jobReady).toBe(false);
      expect(await jobs(db)).toHaveLength(2);
    } finally {
      await close();
    }
  });

  test("accepted work with no session pauses at the cap and gets more time", async () => {
    const { db, close } = await open();
    try {
      await item(db, "ok", {
        lastMonoMs: 1000,
        maxAwakeMs: 100,
        sessionKey: null,
        acceptedHead: "abc",
      });
      await insertRun(db, "ok-run", "ok");
      await db.run((q) =>
        q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ currentRunId: "ok-run" })
            .where(eq(q.t.workItem.id, "ok")),
        ),
      );
      const { outcome, jobReady } = await db.transaction((q) =>
        accrueAwakeSteps(q, "ok", 1500, 5000, undefined, true),
      );
      expect(outcome).toMatchObject({ capped: false, stopAgent: true, item: { state: "paused" } });
      expect(outcome.asked).toBeUndefined();
      expect(jobReady).toBe(false);
      expect(outcome.item.maxAwakeMs).toBe(500 + 3_600_000);
      expect((await db.run((q) => getRunSteps(q, "ok-run")))?.status).toBe("ended");
      const [row] = await outbox(db);
      expect(row).toMatchObject({ idempotencyKey: "time-limit-pause:ok:0" });
    } finally {
      await close();
    }
  });

  test("a claim that ends a slot wait counts the wait, and jobs without an item do nothing", async () => {
    const { db, close } = await open();
    try {
      await item(db, "slot", { lastMonoMs: 1000 });
      const payload = { itemId: "slot", capacityWait: { since: 0, attempt: 1, runnerIds: ["r"] } };
      expect(
        await db.transaction((q) =>
          accrueAtJobBoundarySteps(q, { id: 7, payload }, "claimed", 1400, 5000),
        ),
      ).toBe(false);
      expect(await read(db, "slot")).toMatchObject({
        waitingMs: 400,
        agentMs: 0,
        lastMonoMs: 1400,
      });

      await item(db, "end", { lastMonoMs: 1000 });
      const end = await insertJob(db, {
        queue: JOB_KIND.resume,
        payload: { itemId: "end" },
        status: "running",
        lockedBy: "w",
        lockedUntil: 9000,
      });
      await db.transaction((q) =>
        accrueAtJobBoundarySteps(q, { id: end, payload: { itemId: "end" } }, "ending", 1200, 5000),
      );
      expect(await read(db, "end")).toMatchObject({ agentMs: 200, awakeMs: 200 });

      expect(
        await db.transaction((q) =>
          accrueAtJobBoundarySteps(q, { id: 9, payload: {} }, "claimed", 1400, 5000),
        ),
      ).toBe(false);
    } finally {
      await close();
    }
  });

  test("a wait mark is set by its claim and cleared only by that claim", async () => {
    const { db, close } = await open();
    try {
      await item(db, "wait", { lastMonoMs: 1000 });
      const id = await insertJob(db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: "wait", keep: 1 },
        status: "running",
        lockedBy: "worker",
        lockedUntil: 9000,
        attempts: 2,
      });
      const claim = asJob(id, { itemId: "wait" }, "worker", 2);
      await db.transaction((q) => markJobAwakeWaitSteps(q, claim, true, 1000, 5000, "runner"));
      expect((await jobs(db))[0]!.payload).toEqual({
        itemId: "wait",
        keep: 1,
        awakeWait: { kind: "runner", worker: "worker", attempt: 2 },
      });

      await db.transaction((q) =>
        markJobAwakeWaitSteps(q, asJob(id, { itemId: "wait" }, "other", 2), false, 1000, 5000),
      );
      expect((await jobs(db))[0]!.payload.awakeWait).toBeDefined();

      await db.transaction((q) =>
        markJobAwakeWaitSteps(q, asJob(id, { itemId: "wait" }, "worker", 3), false, 1000, 5000),
      );
      expect((await jobs(db))[0]!.payload.awakeWait).toBeDefined();

      await db.transaction((q) => markJobAwakeWaitSteps(q, claim, false, 1000, 5000));
      expect((await jobs(db))[0]!.payload).toEqual({ itemId: "wait", keep: 1 });

      const expired = asJob(id, { itemId: "wait" }, "worker", 2);
      await db.transaction((q) => markJobAwakeWaitSteps(q, expired, true, 1000, 10_000));
      expect((await jobs(db))[0]!.payload.awakeWait).toBeUndefined();
    } finally {
      await close();
    }
  });

  test("an agent wait moves reported waiting out of the agent's time", async () => {
    const { db, close } = await open();
    try {
      await item(db, "w", { lastMonoMs: 1000, agentMs: 900, implementMs: 900, awakeMs: 900 });
      await insertRun(db, "run", "w");
      const run = { itemId: "w", runId: "run", generation: 2 };

      await db.transaction((q) => startAgentWaitSteps(q, run, 1000, 5000));
      await db.transaction((q) => startAgentWaitSteps(q, { ...run, generation: 3 }, 1000, 5001));
      const open3 = await db.run((q) =>
        q.all(q.orm.select().from(q.t.agentWait).where(eq(q.t.agentWait.runId, "run"))),
      );
      expect(open3).toEqual([{ runId: "run", generation: 3, startedAt: 5001, waitingMs: 0 }]);

      await db.transaction((q) => endAgentWaitSteps(q, { ...run, generation: 1 }, 1000, 6000, 200));
      expect(await read(db, "w")).toMatchObject({ agentMs: 900, waitingMs: 0 });

      await db.transaction((q) => endAgentWaitSteps(q, { ...run, generation: 3 }, 1000, 6000, 200));
      expect(await read(db, "w")).toMatchObject({
        agentMs: 700,
        implementMs: 700,
        awakeMs: 700,
        waitingMs: 200,
      });
      expect(
        await db.run((q) =>
          q.all(q.orm.select().from(q.t.agentWait).where(eq(q.t.agentWait.runId, "run"))),
        ),
      ).toEqual([]);

      await db.transaction((q) => startAgentWaitSteps(q, { ...run, itemId: "gone" }, 1000, 5000));
      expect(await db.run((q) => q.all(q.orm.select().from(q.t.agentWait)))).toEqual([]);
    } finally {
      await close();
    }
  });

  test("a failure stops the run and jobs, and a stale record changes nothing", async () => {
    const { db, close } = await open();
    try {
      const failing = await item(db, "f", { sessionKey: "sess", currentRunId: "f-run" });
      await insertRun(db, "f-run", "f");
      await insertJob(db, { queue: JOB_KIND.resume, payload: { itemId: "f" } });
      expect(
        await db.transaction((q) => failWorkItemSteps(q, failing, "boom", "it broke", 10)),
      ).toBe(true);
      expect(await read(db, "f")).toMatchObject({ state: "failed", cancelRequested: true });
      expect((await db.run((q) => getRunSteps(q, "f-run")))?.status).toBe("lost");
      expect((await jobs(db))[0]).toMatchObject({ status: "cancelled", lastError: "boom" });
      const [row] = await outbox(db);
      expect(row).toMatchObject({ orderingKey: "sess", idempotencyKey: "fail:f:1:boom" });
      expect(row!.payload).toMatchObject({ kind: "error", body: "it broke" });

      expect(await db.transaction((q) => failWorkItemSteps(q, failing, "boom", "x", 11))).toBe(
        false,
      );
    } finally {
      await close();
    }
  });

  test("a failure after the pull request closes the session and uses an answer's Stop edge", async () => {
    const { db, close } = await open();
    try {
      const open0 = await item(db, "pr", { sessionKey: "pr-s", state: "awaiting_input" });
      await db.run((q) =>
        enqueueOutboxOnceSteps(q, {
          target: "linear",
          op: "activity",
          orderingKey: "pr-s",
          generation: 0,
          delivery: "ordered",
          idempotencyKey: "pull-request-ready:pr",
          payload: {},
          now: 1,
        }),
      );
      await db.run((q) =>
        q.exec(
          q.orm
            .insert(q.t.openFindings)
            .values({ itemId: "pr", headSha: "h", line: "Open: one", recordedAt: 1 }),
        ),
      );
      expect(
        await db.transaction((q) =>
          failWorkItemSteps(q, open0, "stop", "stopped", 10, { stoppedByAnswer: true }),
        ),
      ).toBe(true);
      expect((await db.run((q) => listWorkItemEventRowsSteps(q, "pr")))[0]?.event).toBe(
        "answer_stopped",
      );
      const closed = (await outbox(db))[1];
      expect(closed).toMatchObject({ idempotencyKey: "closed:pr:0" });
      expect(closed!.payload).toMatchObject({
        kind: "response",
        body: "Closed: stopped\n\nOpen: one",
      });
      expect(await db.run((q) => withOpenFindingsSteps(q, "pr", "Body"))).toBe("Body\n\nOpen: one");
      expect(await db.run((q) => withOpenFindingsSteps(q, "none", "Body"))).toBe("Body");
    } finally {
      await close();
    }
  });

  test("a confirmed merge completes once and announces before the merged edge", async () => {
    const { db, close } = await open();
    try {
      await item(db, "m", { state: "merge_queue", currentRunId: "m-run" });
      await insertRun(db, "m-run", "m");
      await db.run((q) =>
        recordConfirmedRemoteMergeSteps(q, {
          itemId: "m",
          repositoryOwner: "o",
          repositoryName: "r",
          pullNumber: 5,
          pullUrl: null,
          mergeSha: "sha",
          confirmedAt: 3,
        }),
      );
      await db.run((q) =>
        savePullRequestDraftSteps(
          q,
          "m",
          { title: "t", body: "b", remaining: [{ title: "rest", scope: "s" }] },
          1,
        ),
      );
      await insertJob(db, { queue: JOB_KIND.merge, payload: { itemId: "m" } });

      const seen: string[] = [];
      const merged = await db.transaction((q) =>
        completeMergedItemSteps(q, {
          itemId: "m",
          now: 9,
          announce: (_q, current) =>
            syncSteps(() => {
              seen.push(current.state);
            }),
        }),
      );
      expect(merged).toMatchObject({ state: "merged" });
      expect(seen).toEqual(["merge_queue"]);
      expect((await db.run((q) => getRunSteps(q, "m-run")))?.status).toBe("ended");
      expect((await jobs(db))[0]).toMatchObject({ status: "cancelled", lastError: "merged" });
      const rows = await outbox(db);
      expect(rows.map((row) => row.idempotencyKey)).toEqual(["merged:m:0", "remaining:m"]);
      expect(rows[0]!.payload.body).toBe("Merged #5 into main at sha. m is Done.");
      expect(rows[1]!.payload).toMatchObject({
        repository: "o/r",
        pullUrl: "https://github.com/o/r/pull/5",
      });

      expect(
        await db.transaction((q) => completeMergedItemSteps(q, { itemId: "m", now: 9 })),
      ).toBeNull();
      await item(db, "unconfirmed", { state: "merge_queue" });
      expect(
        await db.transaction((q) => completeMergedItemSteps(q, { itemId: "unconfirmed", now: 9 })),
      ).toBeNull();
    } finally {
      await close();
    }
  });

  test("deferring queues a resume and loses the run", async () => {
    const { db, close } = await open();
    try {
      const running = await item(db, "d", { sessionKey: "ds", currentRunId: "d-run" });
      await insertRun(db, "d-run", "d");
      const input = { retry: 2, delayMs: 50, handoff: "next", message: "wait", now: 100 };
      expect(await db.transaction((q) => deferWorkItemSteps(q, running, input))).toBe(true);
      expect((await read(db, "d")).state).toBe("recovering");
      expect((await db.run((q) => getRunSteps(q, "d-run")))?.status).toBe("lost");
      const [job] = await jobs(db);
      expect(job).toMatchObject({ queue: JOB_KIND.resume, jobKey: "resume:d:1", runAt: 150 });
      expect(job!.payload).toMatchObject({
        itemId: "d",
        runId: "d-run",
        reason: "transient_failure",
        retry: 2,
        handoff: "next",
      });
      const [row] = await outbox(db);
      expect(row).toMatchObject({ idempotencyKey: "retry:d:1", orderingKey: "ds" });

      const recovering = await read(db, "d");
      expect(await db.transaction((q) => deferWorkItemSteps(q, recovering, input))).toBe(false);
    } finally {
      await close();
    }
  });

  test("deferring verification with a candidate re-verifies in place", async () => {
    const { db, close } = await open();
    try {
      const checkpoint = { phase: "verifying", wipCommit: "abc" } as unknown as Checkpoint;
      const verifying = await item(db, "v", { state: "verifying", checkpoint, sessionKey: "vs" });
      const input = { retry: 1, delayMs: 10, handoff: null, message: null, now: 100 };
      expect(await db.transaction((q) => deferWorkItemSteps(q, verifying, input))).toBe(true);
      expect((await read(db, "v")).state).toBe("verifying");

      const fault = { jobId: 8, head: "abc", reasons: ["r"], reviewer: "rev" };
      await db.transaction((q) =>
        deferWorkItemSteps(q, verifying, { ...input, message: "held", closeoutFault: fault }),
      );
      const [retry, held] = await jobs(db);
      expect(retry).toMatchObject({
        queue: JOB_KIND.reverify,
        jobKey: "reverify:retry:v:0:1",
      });
      expect(held).toMatchObject({ jobKey: "reverify:closeout-fault:v:8" });
      expect(held!.payload).toMatchObject({
        reviewerFault: "rev",
        closeoutFaults: { head: "abc" },
      });
      expect((await outbox(db))[0]).toMatchObject({ idempotencyKey: "reviewer-fault:rev:v:8" });
    } finally {
      await close();
    }
  });

  test("async siblings announce a job only when the transaction inserted one", async () => {
    const { db, close } = await open();
    const ready: unknown[] = [];
    const stop = onJobReady((source) => ready.push(source));
    try {
      await item(db, "cap", { lastMonoMs: 1000, maxAwakeMs: 100, sessionKey: "s" });
      await accrueAwake(db, "cap", 1500, 5000, undefined, true);
      expect(ready).toEqual([db]);
      await accrueAwake(db, "cap", 1600, 5000, undefined, true);
      expect(ready).toHaveLength(1);

      const running = await item(db, "d");
      const input = { retry: 1, delayMs: 1, handoff: null, message: null, now: 1 };
      await deferWorkItem(db, running, input);
      expect(ready).toHaveLength(2);
    } finally {
      stop();
      await close();
    }
  });
});

test("the sync wrapper announces a new job after its transaction commits", async () => {
  const database = tempDb();
  try {
    database.run(
      `INSERT INTO work_item (id, delegation_id, linear_issue_id, linear_identifier, title, state, branch_name, position, created_at)
       VALUES ('i','d','l','PAS-1','t','running','paws/i',0,0)`,
    );
    const during: boolean[] = [];
    const stop = onJobReady(() => during.push(database.inTransaction));
    try {
      await deferWorkItem(sqliteDb(database), (await getWorkItem(sqliteDb(database), "i"))!, {
        retry: 1,
        delayMs: 1,
        handoff: null,
        message: null,
        now: 1,
      });
      expect(during).toEqual([false]);
    } finally {
      stop();
    }
  } finally {
    database.close();
  }
});
