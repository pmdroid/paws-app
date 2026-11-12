import { afterEach, describe, expect, test } from "bun:test";
import { FakeClock } from "../core";
import {
  advanceOutboxSession,
  claimOutboxHeads,
  enqueueOutbox,
  enqueueOutboxOnce,
  getOutboxSteps,
  enqueueOutboxSteps,
  listOutbox,
  OutboxDispatcher,
  stopOutboxSession,
  type Db,
  type NewOutbox,
} from "./index";
import { tempStore } from "../../test/pglite";

const open: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function opened(): Promise<Db> {
  const { db, close } = await tempStore();
  open.push(close);
  return db;
}

async function setup(store?: Db) {
  const db = store ?? (await opened());
  const clock = new FakeClock(5000);
  const dispatcher = new OutboxDispatcher(db, clock);
  async function enqueue(key: string, options: Partial<NewOutbox> = {}) {
    return await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: key,
      payload: { sessionId: "A", kind: "thought", body: key, ephemeral: true },
      now: clock.now(),
      ...options,
    });
  }
  return { db, clock, dispatcher, enqueue };
}

function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function flush(dispatcher: OutboxDispatcher) {
  while ((await dispatcher.tick()).length > 0) await dispatcher.idle();
}

describe("critical Linear delivery", () => {
  test.each([1, 3])(
    "a final reply supersedes a failed progress head with maxAttempts=%s",
    async (maxAttempts) => {
      const { db, dispatcher, enqueue } = await setup();
      const progress = await enqueue("legacy", {
        maxAttempts,
        payload: { text: "untyped legacy progress" },
      });
      const delivered: string[] = [];
      dispatcher.setHandler((row) => {
        if (row.idempotencyKey === "legacy") throw new Error("Invalid legacy kind");
        delivered.push(row.idempotencyKey);
      });
      await flush(dispatcher);
      expect((await db.run((q) => getOutboxSteps(q, progress)))?.status).toBe(
        maxAttempts === 1 ? "dead" : "pending",
      );
      await enqueue("other", { orderingKey: "B" });
      const final = await enqueue("final", {
        payload: { sessionId: "A", kind: "response", body: "Done" },
      });
      await flush(dispatcher);
      expect((await db.run((q) => getOutboxSteps(q, progress)))?.status).toBe("dropped");
      expect((await db.run((q) => getOutboxSteps(q, final)))?.status).toBe("sent");
      expect(delivered).toContain("final");
      expect(delivered).toContain("other");
      const stale = await enqueue("late-progress");
      await flush(dispatcher);
      expect((await db.run((q) => getOutboxSteps(q, stale)))?.status).toBe("dropped");
      expect(delivered).not.toContain("late-progress");
      const lateCritical = await enqueue("late-ack", { delivery: "critical" });
      expect((await db.run((q) => getOutboxSteps(q, lateCritical)))?.status).toBe("dropped");
    },
  );

  test("an elicitation replaces retrying progress and terminal output replaces the obsolete question", async () => {
    const { db, dispatcher, enqueue } = await setup();
    const progress = await enqueue("progress");
    const question = await enqueue("question", {
      op: "elicitation",
      payload: { sessionId: "A", body: "Which?" },
    });
    expect((await db.run((q) => getOutboxSteps(q, progress)))?.status).toBe("dropped");
    const final = await enqueue("final", {
      payload: { sessionId: "A", kind: "error", body: "Halted" },
    });
    dispatcher.setHandler(() => {});
    await flush(dispatcher);
    expect((await db.run((q) => getOutboxSteps(q, question)))?.status).toBe("dropped");
    expect((await db.run((q) => getOutboxSteps(q, final)))?.status).toBe("sent");
  });

  test("supersession rolls back with its critical enqueue", async () => {
    const { db, enqueue } = await setup();
    const progress = await enqueue("progress");
    await expect(
      db.transaction(function* (q) {
        yield* enqueueOutboxSteps(q, {
          target: "linear",
          op: "activity",
          orderingKey: "A",
          idempotencyKey: "final",
          payload: { kind: "response", body: "Done" },
          now: 5000,
        });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect((await db.run((q) => getOutboxSteps(q, progress)))?.status).toBe("pending");
    expect(await listOutbox(db)).toHaveLength(1);
  });

  test("a failed meaningful final stays visible until an explicit newer generation supersedes it", async () => {
    const { db, dispatcher, enqueue } = await setup();
    const failed = await enqueue("failed-final", {
      payload: { kind: "response", body: "Previous result" },
      maxAttempts: 1,
    });
    dispatcher.setHandler(() => {
      throw new Error("transport failed");
    });
    await flush(dispatcher);
    const later = await enqueue("later-final", {
      payload: { kind: "response", body: "Another result" },
    });
    dispatcher.setHandler(() => {});
    expect(await dispatcher.tick()).toHaveLength(0);
    expect((await db.run((q) => getOutboxSteps(q, failed)))?.status).toBe("dead");
    await advanceOutboxSession(db, "linear", "A");
    expect((await db.run((q) => getOutboxSteps(q, failed)))?.error).toContain(
      "accepted newer session generation",
    );
    expect((await db.run((q) => getOutboxSteps(q, failed)))?.payload).toEqual({
      kind: "response",
      body: "Previous result",
    });
    expect((await db.run((q) => getOutboxSteps(q, later)))?.status).toBe("dropped");
    const next = await enqueue("next-final", { payload: { kind: "response", body: "Next turn" } });
    await flush(dispatcher);
    expect((await db.run((q) => getOutboxSteps(q, next)))?.status).toBe("sent");
  });

  test("superseded in-flight progress aborts before the final and other sessions keep moving", async () => {
    const { db, dispatcher, enqueue } = await setup();
    let concurrent = 0;
    let maximum = 0;
    const events: string[] = [];
    const progress = await enqueue("progress");
    dispatcher.setHandler(async (row, context) => {
      if (row.orderingKey !== "A") {
        events.push(row.idempotencyKey);
        return;
      }
      concurrent += 1;
      maximum = Math.max(maximum, concurrent);
      try {
        events.push(row.idempotencyKey);
        if (row.idempotencyKey === "progress")
          await new Promise<void>((_resolve, reject) => {
            context.signal.addEventListener(
              "abort",
              () => {
                events.push("aborted");
                reject(context.signal.reason);
              },
              { once: true },
            );
          });
      } finally {
        concurrent -= 1;
      }
    });
    await dispatcher.tick();
    await enqueue("final", { payload: { kind: "response", body: "Done" } });
    await enqueue("other", { orderingKey: "B" });
    await dispatcher.tick();
    await dispatcher.idle();
    await flush(dispatcher);
    expect(events.indexOf("aborted")).toBeLessThan(events.indexOf("final"));
    expect(events).toContain("other");
    expect(maximum).toBe(1);
    expect((await db.run((q) => getOutboxSteps(q, progress)))?.error).toContain(
      "external effect may have occurred",
    );
  });

  test("a transport ignoring abort remains serialized beyond the lease and records uncertainty", async () => {
    const { db, clock, dispatcher, enqueue } = await setup();
    const gate = deferred();
    const delivered: string[] = [];
    const progress = await enqueue("progress");
    dispatcher.setHandler(async (row) => {
      delivered.push(row.idempotencyKey);
      if (row.idempotencyKey === "progress") await gate.promise;
    });
    await dispatcher.tick();
    await enqueue("final", { payload: { kind: "response", body: "Done" } });
    clock.advance(120000);
    expect(await dispatcher.tick()).toHaveLength(0);
    expect(delivered).toEqual(["progress"]);
    gate.resolve();
    await dispatcher.idle();
    await flush(dispatcher);
    expect(delivered).toEqual(["progress", "final"]);
    expect(await db.run((q) => getOutboxSteps(q, progress))).toMatchObject({
      status: "dropped",
      sentAt: clock.now(),
    });
    expect((await db.run((q) => getOutboxSteps(q, progress)))?.error).toContain(
      "external effect may have occurred",
    );
  });
});

describe("ephemeral progress coalescing", () => {
  test("reconnect sends only the latest unsent transient update and keeps durable milestones", async () => {
    const { db, dispatcher, enqueue } = await setup();
    const first = await enqueue("first", {
      payload: { kind: "thought", body: "Starting", ephemeral: true },
    });
    const milestone = await enqueue("milestone", {
      payload: { kind: "thought", body: "Implemented export" },
    });
    const other = await enqueue("other", {
      orderingKey: "B",
      payload: { kind: "thought", body: "Other", ephemeral: true },
    });
    const latest = await enqueue("latest", {
      payload: { kind: "action", body: "Testing", ephemeral: true },
    });
    const delivered: string[] = [];
    dispatcher.setHandler((row) => {
      delivered.push(row.idempotencyKey);
    });
    await flush(dispatcher);
    expect((await db.run((q) => getOutboxSteps(q, first)))?.status).toBe("dropped");
    expect((await db.run((q) => getOutboxSteps(q, milestone)))?.status).toBe("sent");
    expect((await db.run((q) => getOutboxSteps(q, other)))?.status).toBe("sent");
    expect((await db.run((q) => getOutboxSteps(q, latest)))?.status).toBe("sent");
    expect(delivered).toEqual(["milestone", "other", "latest"]);
  });

  test("a claimed update remains serialized and questions and results retain their fences", async () => {
    const { db, dispatcher, enqueue } = await setup();
    const first = await enqueue("first", {
      payload: { kind: "thought", body: "Starting", ephemeral: true },
    });
    const claimed = await claimOutboxHeads(db, { now: 5000 });
    expect(claimed[0]?.id).toBe(first);
    const later = await enqueue("later", {
      payload: { kind: "action", body: "Testing", ephemeral: true },
    });
    expect((await db.run((q) => getOutboxSteps(q, first)))?.status).toBe("pending");
    const question = await enqueue("question", {
      op: "elicitation",
      payload: { sessionId: "A", body: "Which?" },
    });
    expect((await db.run((q) => getOutboxSteps(q, later)))?.status).toBe("dropped");
    expect((await db.run((q) => getOutboxSteps(q, question)))?.status).toBe("pending");
    const final = await enqueue("final", { payload: { kind: "response", body: "Done" } });
    expect((await db.run((q) => getOutboxSteps(q, question)))?.status).toBe("dropped");
    const stale = await enqueue("stale", {
      payload: { kind: "thought", body: "Late", ephemeral: true },
    });
    expect((await db.run((q) => getOutboxSteps(q, stale)))?.status).toBe("dropped");
    dispatcher.setHandler(() => {});
    expect((await db.run((q) => getOutboxSteps(q, final)))?.status).toBe("pending");
  });

  test("duplicate insertion cannot supersede a newer transient update", async () => {
    const { db, enqueue } = await setup();
    await enqueue("first", { payload: { kind: "thought", body: "Starting", ephemeral: true } });
    const latest = await enqueue("latest", {
      payload: { kind: "thought", body: "Latest", ephemeral: true },
    });
    await enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "first",
      payload: { kind: "thought", body: "Starting", ephemeral: true },
    });
    expect((await db.run((q) => getOutboxSteps(q, latest)))?.status).toBe("pending");
  });
});

describe("persisted Stop fences", () => {
  test("a claimed row cannot start a call after Stop and exactly one acknowledgement survives", async () => {
    const { db, clock, dispatcher, enqueue } = await setup();
    const gate = deferred();
    const calls: string[] = [];
    await enqueue("progress");
    dispatcher.setHandler(async (row, context) => {
      if (row.idempotencyKey === "progress") await gate.promise;
      if (await context.isCurrent()) calls.push(row.idempotencyKey);
    });
    await dispatcher.tick();
    const completed = await enqueue("completed-status", {
      op: "status",
      payload: { linearIssueId: "done", stateType: "completed" },
    });
    await enqueue("question", { op: "elicitation" });
    const generation = await stopOutboxSession(db, "linear", "A", clock.now());
    expect(await stopOutboxSession(db, "linear", "A", clock.now() + 1)).toBe(generation);
    for (let attempt = 0; attempt < 2; attempt += 1)
      await enqueueOutboxOnce(db, {
        target: "linear",
        op: "activity",
        orderingKey: "A",
        generation,
        delivery: "stop",
        idempotencyKey: `stop:A:${generation}`,
        payload: { kind: "response", body: "Stopped" },
      });
    const stale = await enqueue("stale-after-stop", { generation: generation - 1 });
    await enqueue("other", { orderingKey: "B" });
    await dispatcher.tick();
    gate.resolve();
    await dispatcher.idle();
    await flush(dispatcher);
    expect(calls).toEqual(["other", `stop:A:${generation}`]);
    expect((await db.run((q) => getOutboxSteps(q, stale)))?.status).toBe("dropped");
    expect((await db.run((q) => getOutboxSteps(q, completed)))?.payload).toEqual({
      linearIssueId: "done",
      stateType: "completed",
    });
    expect((await db.run((q) => getOutboxSteps(q, completed)))?.status).toBe("dropped");
  });

  test("restart retains Stop and an accepted new generation fences old callbacks", async () => {
    const first = await setup();
    const generation = await stopOutboxSession(first.db, "linear", "A");
    await first.enqueue("stop", {
      delivery: "stop",
      generation,
      payload: { kind: "response", body: "Stopped" },
    });
    const second = await setup(first.db);
    const calls: string[] = [];
    second.dispatcher.setHandler((row) => {
      calls.push(row.idempotencyKey);
    });
    const late = await second.enqueue("late");
    await flush(second.dispatcher);
    expect((await second.db.run((q) => getOutboxSteps(q, late)))?.status).toBe("dropped");
    expect(calls).toEqual(["stop"]);
    const next = await advanceOutboxSession(second.db, "linear", "A");
    const old = await second.enqueue("old-callback", { generation });
    const current = await second.enqueue("current", { generation: next });
    await flush(second.dispatcher);
    expect((await second.db.run((q) => getOutboxSteps(q, old)))?.status).toBe("dropped");
    expect((await second.db.run((q) => getOutboxSteps(q, current)))?.status).toBe("sent");
    expect(calls).toEqual(["stop", "current"]);
  });
});
