import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { JOB_KIND, type Checkpoint } from "../src/core";
import {
  agentTurnStageSteps,
  cancelAdvancingJobsSteps,
  configureWorkItemSteps,
  getWorkItemSteps,
  heldHandoffsSteps,
  itemDelegationIdSteps,
  itemLinearIdentifierSteps,
  lastItemEventSteps,
  listLastWorkItemEventTimesSteps,
  listWorkItemEventRowsSteps,
  listWorkItemsByStatesSteps,
  listWorkItemsSteps,
  markCloseoutAcceptedSteps,
  markHandoffsCarriedSteps,
  markResumedSteps,
  releaseReviewerFaultHoldsSteps,
  resetAwakeTimeSteps,
  resetStageTimeSteps,
  reviewerAlertedSinceSteps,
  reviewerFaultHoldsSteps,
  saveCheckpointSteps,
  setCurrentRunSteps,
  setRecoveryAttemptsSteps,
  syncClockSteps,
  type Db,
  type Q,
} from "../src/db";
import { forEachDialect, insertWorkItem, insertWorkItemSteps } from "./dialects";

function json(q: Q, value: unknown): unknown {
  return q.dialect === "sqlite" ? JSON.stringify(value) : value;
}

function parsed(value: unknown): unknown {
  return typeof value === "string" ? JSON.parse(value) : value;
}

function insertJob(
  db: Db,
  job: { queue: string; payload: unknown; status?: string; lastError?: string },
): Promise<number> {
  return db.run(function* (q) {
    const row = yield* q.one(
      q.orm
        .insert(q.t.job)
        .values({
          queue: job.queue,
          payload: json(q, job.payload),
          status: job.status ?? "pending",
          lastError: job.lastError ?? null,
          runAt: 0,
          createdAt: 0,
        })
        .returning({ id: q.t.job.id }),
    );
    return row!.id;
  });
}

function jobRow(db: Db, id: number) {
  return db.run(function* (q) {
    const row = yield* q.one(q.orm.select().from(q.t.job).where(eq(q.t.job.id, id)));
    return { ...row!, payload: parsed(row!.payload) };
  });
}

function insertEvents(db: Db, itemId: string, events: { kind: string; reason: string | null }[]) {
  return db.run(function* (q) {
    for (const [index, event] of events.entries())
      yield* q.exec(
        q.orm.insert(q.t.workItemEvent).values({
          itemId,
          version: index + 1,
          at: (index + 1) * 10,
          fromState: "queued",
          toState: "running",
          event: "started",
          kind: event.kind,
          reason: event.reason,
        }),
      );
  });
}

forEachDialect((open) => {
  test("work items read back with their continuation, checkpoint and order", async () => {
    const { db, close } = await open();
    try {
      await db.transaction(function* (q) {
        yield* insertWorkItemSteps(q, "b", 2);
        yield* insertWorkItemSteps(q, "a", 1);
        yield* q.exec(
          q.orm
            .insert(q.t.itemContinuation)
            .values({ itemId: "b", previousItemId: "a", branch: "paws/a" }),
        );
      });
      const checkpoint = { phase: "implementing", head: "abc" } as unknown as Checkpoint;
      await db.run((q) => saveCheckpointSteps(q, "a", checkpoint));
      const a = await db.run((q) => getWorkItemSteps(q, "a"));
      expect(a).toMatchObject({
        id: "a",
        state: "queued",
        checkpoint,
        continuesItemId: null,
        cancelRequested: false,
        brief: null,
        resumedAt: null,
      });
      expect(await db.run((q) => getWorkItemSteps(q, "b"))).toMatchObject({
        continuesItemId: "a",
        continuesBranch: "paws/a",
        checkpoint: null,
      });
      expect(await db.run((q) => getWorkItemSteps(q, "missing"))).toBeNull();
      expect((await db.run(listWorkItemsSteps)).map((item) => item.id)).toEqual(["a", "b"]);
      expect(await db.run((q) => listWorkItemsByStatesSteps(q, []))).toEqual([]);
      expect(
        (await db.run((q) => listWorkItemsByStatesSteps(q, ["queued"]))).map((item) => item.id),
      ).toEqual(["a", "b"]);
      expect(await db.run((q) => listWorkItemsByStatesSteps(q, ["running"]))).toEqual([]);
      await db.run((q) => saveCheckpointSteps(q, "a", null));
      expect((await db.run((q) => getWorkItemSteps(q, "a")))!.checkpoint).toBeNull();
      expect(await db.run((q) => itemDelegationIdSteps(q, "a"))).toBe("delegation-a");
      expect(await db.run((q) => itemLinearIdentifierSteps(q, "a"))).toBe("a");
      expect(await db.run((q) => itemDelegationIdSteps(q, "missing"))).toBeNull();
      expect(await db.run((q) => itemLinearIdentifierSteps(q, "missing"))).toBeNull();
    } finally {
      await close();
    }
  });

  test("column setters, limits and the awake clock", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      await db.run((q) =>
        configureWorkItemSteps(q, "a", {
          sessionKey: "session",
          maxAwakeMs: 100,
          limits: { fixes: 200, closeout: 300 },
        }),
      );
      await db.run((q) => setRecoveryAttemptsSteps(q, "a", 3));
      await db.run((q) => setCurrentRunSteps(q, "a", "run-1"));
      await db.run((q) => syncClockSteps(q, "a", 42));
      await db.run((q) => markCloseoutAcceptedSteps(q, "a", "head"));
      expect(await db.run((q) => getWorkItemSteps(q, "a"))).toMatchObject({
        sessionKey: "session",
        maxAwakeMs: 100,
        maxFixMs: 200,
        maxCloseoutMs: 300,
        recoveryAttempts: 3,
        currentRunId: "run-1",
        lastMonoMs: 42,
        acceptedHead: "head",
      });
      await db.run((q) => markResumedSteps(q, "a", 7));
      expect(await db.run((q) => getWorkItemSteps(q, "a"))).toMatchObject({
        recoveryAttempts: 1,
        resumedAt: 7,
      });
      await db.run(function* (q) {
        yield* q.exec(
          q.orm
            .update(q.t.workItem)
            .set({ awakeMs: 5, agentMs: 4, implementMs: 3, fixMs: 2, closeoutMs: 1, waitingMs: 6 })
            .where(eq(q.t.workItem.id, "a")),
        );
      });
      await db.run((q) => resetStageTimeSteps(q, "a", "fixes"));
      expect(await db.run((q) => getWorkItemSteps(q, "a"))).toMatchObject({
        fixMs: 0,
        implementMs: 3,
      });
      await db.run((q) => resetAwakeTimeSteps(q, "a"));
      expect(await db.run((q) => getWorkItemSteps(q, "a"))).toMatchObject({
        awakeMs: 0,
        agentMs: 0,
        implementMs: 0,
        closeoutMs: 0,
        waitingMs: 0,
        lastMonoMs: null,
      });
      await db.run((q) => setCurrentRunSteps(q, "a", null));
      expect((await db.run((q) => getWorkItemSteps(q, "a")))!.currentRunId).toBeNull();
    } finally {
      await close();
    }
  });

  test("an item's history, its last event and its agent stage", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      await insertWorkItem(db, "b");
      expect(await db.run((q) => agentTurnStageSteps(q, "a"))).toBe("implementation");
      expect(await db.run((q) => lastItemEventSteps(q, "a"))).toBeNull();
      await insertEvents(db, "a", [
        { kind: "transition", reason: null },
        { kind: "restart", reason: "review" },
        { kind: "ask", reason: "time_limit" },
      ]);
      await insertEvents(db, "b", [{ kind: "transition", reason: null }]);
      const rows = await db.run((q) => listWorkItemEventRowsSteps(q, "a", 2));
      expect(rows.map((row) => row.version)).toEqual([2, 3]);
      expect(rows[0]).toMatchObject({
        itemId: "a",
        at: 20,
        fromState: "queued",
        toState: "running",
        event: "started",
        kind: "restart",
        reason: "review",
        payloadDigest: null,
        actor: null,
      });
      expect(typeof rows[0]!.id).toBe("number");
      expect((await db.run((q) => listWorkItemEventRowsSteps(q, "a"))).length).toBe(3);
      expect(await db.run(listLastWorkItemEventTimesSteps)).toEqual(
        new Map([
          ["a", 30],
          ["b", 10],
        ]),
      );
      expect(await db.run((q) => agentTurnStageSteps(q, "a"))).toBe("fixes");
      expect(await db.run((q) => lastItemEventSteps(q, "a"))).toEqual({
        kind: "ask",
        reason: "time_limit",
      });
    } finally {
      await close();
    }
  });

  test("held handoffs are listed oldest first and marked carried", async () => {
    const { db, close } = await open();
    try {
      const held = { queue: JOB_KIND.resume, status: "cancelled", lastError: "time_limit" };
      const first = await insertJob(db, { ...held, payload: { itemId: "a", handoff: "first" } });
      await insertJob(db, { ...held, payload: { itemId: "a", handoff: "  " } });
      await insertJob(db, { ...held, payload: { itemId: "a" } });
      await insertJob(db, { ...held, payload: { itemId: "b", handoff: "other" } });
      const second = await insertJob(db, { ...held, payload: { itemId: "a", handoff: "second" } });
      const handoffs = await db.run((q) => heldHandoffsSteps(q, "a"));
      expect(handoffs).toEqual([
        { jobId: first, handoff: "first" },
        { jobId: second, handoff: "second" },
      ]);
      await db.run((q) => markHandoffsCarriedSteps(q, handoffs));
      expect(await db.run((q) => heldHandoffsSteps(q, "a"))).toEqual([]);
      expect((await jobRow(db, first)).lastError).toBe("time_limit_carried");
    } finally {
      await close();
    }
  });

  test("cancelling an item's advancing jobs leaves other queues and items", async () => {
    const { db, close } = await open();
    try {
      const start = await insertJob(db, { queue: JOB_KIND.start, payload: { itemId: "a" } });
      const merge = await insertJob(db, {
        queue: `${JOB_KIND.merge}.ci`,
        payload: { itemId: "a" },
      });
      const ask = await insertJob(db, { queue: "item.ask", payload: { itemId: "a" } });
      const other = await insertJob(db, { queue: JOB_KIND.start, payload: { itemId: "b" } });
      await db.run((q) => cancelAdvancingJobsSteps(q, "a", "merged", 9));
      expect(await jobRow(db, start)).toMatchObject({
        status: "cancelled",
        lastError: "merged",
        finishedAt: 9,
      });
      expect((await jobRow(db, merge)).status).toBe("cancelled");
      expect((await jobRow(db, ask)).status).toBe("pending");
      expect((await jobRow(db, other)).status).toBe("pending");
    } finally {
      await close();
    }
  });

  test("reviewer fault holds are listed, alerted and released", async () => {
    const { db, close } = await open();
    try {
      await insertWorkItem(db, "a");
      await insertWorkItem(db, "b");
      const fault = { closeoutFaults: { head: "h", reasons: ["r"] }, reviewerFault: "codex" };
      const held = await insertJob(db, {
        queue: JOB_KIND.reverify,
        payload: { itemId: "b", ...fault, keep: 1 },
      });
      await insertJob(db, { queue: JOB_KIND.reverify, payload: { itemId: "a", ...fault } });
      await insertJob(db, { queue: JOB_KIND.reverify, payload: { itemId: "b", ...fault } });
      await insertJob(db, { queue: JOB_KIND.reverify, payload: { itemId: "missing", ...fault } });
      await insertJob(db, { queue: JOB_KIND.reverify, payload: { itemId: "a" } });
      const holds = await db.run((q) => reviewerFaultHoldsSteps(q, "codex"));
      expect(holds.map((item) => item.id)).toEqual(["b", "a"]);
      expect(await db.run((q) => reviewerFaultHoldsSteps(q, "claude"))).toEqual([]);

      expect(await db.run((q) => releaseReviewerFaultHoldsSteps(q, "b", 50))).toBe(2);
      expect(await jobRow(db, held)).toMatchObject({
        runAt: 50,
        payload: { itemId: "b", keep: 1 },
      });
      expect(await db.run((q) => releaseReviewerFaultHoldsSteps(q, "b", 60))).toBe(0);

      expect(await db.run((q) => reviewerAlertedSinceSteps(q, "codex", 0))).toBe(false);
      await db.run(function* (q) {
        yield* q.exec(
          q.orm.insert(q.t.outbox).values({
            target: "linear",
            op: "activity",
            idempotencyKey: "reviewer-fault:codex:a:1",
            payload: json(q, {}),
            createdAt: 100,
          }),
        );
      });
      expect(await db.run((q) => reviewerAlertedSinceSteps(q, "codex", 100))).toBe(true);
      expect(await db.run((q) => reviewerAlertedSinceSteps(q, "codex", 101))).toBe(false);
      expect(await db.run((q) => reviewerAlertedSinceSteps(q, "claude", 0))).toBe(false);
    } finally {
      await close();
    }
  });
});
