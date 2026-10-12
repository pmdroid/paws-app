import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../core";
import {
  advanceOutboxSession,
  claimOutboxHeads,
  enqueueOutbox,
  enqueueOutboxOnce,
  getOutbox,
  immediate,
  listOutbox,
  migrate,
  openDatabase,
  OutboxDispatcher,
  stopOutboxSession,
  type NewOutbox,
} from "./index";

function setup(path = ":memory:") {
  const db = openDatabase(path);
  migrate(db);
  const clock = new FakeClock(5000);
  const dispatcher = new OutboxDispatcher(db, clock);
  function enqueue(key: string, options: Partial<NewOutbox> = {}) {
    return enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: key,
      payload: { sessionId: "A", kind: "thought", body: key },
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
  while (dispatcher.tick().length > 0) await dispatcher.idle();
}

describe("critical Linear delivery", () => {
  test.each([1, 3])(
    "a final reply supersedes a failed progress head with maxAttempts=%s",
    async (maxAttempts) => {
      const { db, dispatcher, enqueue } = setup();
      const progress = enqueue("legacy", {
        maxAttempts,
        payload: { text: "untyped legacy progress" },
      });
      const delivered: string[] = [];
      dispatcher.setHandler((row) => {
        if (row.idempotencyKey === "legacy") throw new Error("Invalid legacy kind");
        delivered.push(row.idempotencyKey);
      });
      await flush(dispatcher);
      expect(getOutbox(db, progress)?.status).toBe(maxAttempts === 1 ? "dead" : "pending");
      enqueue("other", { orderingKey: "B" });
      const final = enqueue("final", {
        payload: { sessionId: "A", kind: "response", body: "Done" },
      });
      await flush(dispatcher);
      expect(getOutbox(db, progress)?.status).toBe("dropped");
      expect(getOutbox(db, final)?.status).toBe("sent");
      expect(delivered).toContain("final");
      expect(delivered).toContain("other");
      const stale = enqueue("late-progress");
      await flush(dispatcher);
      expect(getOutbox(db, stale)?.status).toBe("dropped");
      expect(delivered).not.toContain("late-progress");
      const lateCritical = enqueue("late-ack", { delivery: "critical" });
      expect(getOutbox(db, lateCritical)?.status).toBe("dropped");
      db.close();
    },
  );

  test("an elicitation replaces retrying progress and terminal output replaces the obsolete question", async () => {
    const { db, dispatcher, enqueue } = setup();
    const progress = enqueue("progress");
    const question = enqueue("question", {
      op: "elicitation",
      payload: { sessionId: "A", body: "Which?" },
    });
    expect(getOutbox(db, progress)?.status).toBe("dropped");
    const final = enqueue("final", { payload: { sessionId: "A", kind: "error", body: "Halted" } });
    dispatcher.setHandler(() => {});
    await flush(dispatcher);
    expect(getOutbox(db, question)?.status).toBe("dropped");
    expect(getOutbox(db, final)?.status).toBe("sent");
    db.close();
  });

  test("supersession rolls back with its critical enqueue", () => {
    const { db, enqueue } = setup();
    const progress = enqueue("progress");
    expect(() =>
      immediate(db, () => {
        enqueue("final", { payload: { kind: "response", body: "Done" } });
        throw new Error("rollback");
      }),
    ).toThrow("rollback");
    expect(getOutbox(db, progress)?.status).toBe("pending");
    expect(listOutbox(db)).toHaveLength(1);
    db.close();
  });

  test("a failed meaningful final stays visible until an explicit newer generation supersedes it", async () => {
    const { db, dispatcher, enqueue } = setup();
    const failed = enqueue("failed-final", {
      payload: { kind: "response", body: "Previous result" },
      maxAttempts: 1,
    });
    dispatcher.setHandler(() => {
      throw new Error("transport failed");
    });
    await flush(dispatcher);
    const later = enqueue("later-final", { payload: { kind: "response", body: "Another result" } });
    dispatcher.setHandler(() => {});
    expect(dispatcher.tick()).toHaveLength(0);
    expect(getOutbox(db, failed)?.status).toBe("dead");
    advanceOutboxSession(db, "linear", "A");
    expect(getOutbox(db, failed)?.error).toContain("accepted newer session generation");
    expect(getOutbox(db, failed)?.payload).toEqual({ kind: "response", body: "Previous result" });
    expect(getOutbox(db, later)?.status).toBe("dropped");
    const next = enqueue("next-final", { payload: { kind: "response", body: "Next turn" } });
    await flush(dispatcher);
    expect(getOutbox(db, next)?.status).toBe("sent");
    db.close();
  });

  test("superseded in-flight progress aborts before the final and other sessions keep moving", async () => {
    const { db, dispatcher, enqueue } = setup();
    let concurrent = 0;
    let maximum = 0;
    const events: string[] = [];
    const progress = enqueue("progress");
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
    dispatcher.tick();
    enqueue("final", { payload: { kind: "response", body: "Done" } });
    enqueue("other", { orderingKey: "B" });
    dispatcher.tick();
    await dispatcher.idle();
    await flush(dispatcher);
    expect(events.indexOf("aborted")).toBeLessThan(events.indexOf("final"));
    expect(events).toContain("other");
    expect(maximum).toBe(1);
    expect(getOutbox(db, progress)?.error).toContain("external effect may have occurred");
    db.close();
  });

  test("a transport ignoring abort remains serialized beyond the lease and records uncertainty", async () => {
    const { db, clock, dispatcher, enqueue } = setup();
    const gate = deferred();
    const delivered: string[] = [];
    const progress = enqueue("progress");
    dispatcher.setHandler(async (row) => {
      delivered.push(row.idempotencyKey);
      if (row.idempotencyKey === "progress") await gate.promise;
    });
    dispatcher.tick();
    enqueue("final", { payload: { kind: "response", body: "Done" } });
    clock.advance(120000);
    expect(dispatcher.tick()).toHaveLength(0);
    expect(delivered).toEqual(["progress"]);
    gate.resolve();
    await dispatcher.idle();
    await flush(dispatcher);
    expect(delivered).toEqual(["progress", "final"]);
    expect(getOutbox(db, progress)).toMatchObject({ status: "dropped", sentAt: clock.now() });
    expect(getOutbox(db, progress)?.error).toContain("external effect may have occurred");
    db.close();
  });
});

describe("ephemeral progress coalescing", () => {
  test("reconnect sends only the latest unsent transient update and keeps durable milestones", async () => {
    const { db, dispatcher, enqueue } = setup();
    const first = enqueue("first", {
      payload: { kind: "thought", body: "Starting", ephemeral: true },
    });
    const milestone = enqueue("milestone", {
      payload: { kind: "thought", body: "Implemented export" },
    });
    const other = enqueue("other", {
      orderingKey: "B",
      payload: { kind: "thought", body: "Other", ephemeral: true },
    });
    const latest = enqueue("latest", {
      payload: { kind: "action", body: "Testing", ephemeral: true },
    });
    const delivered: string[] = [];
    dispatcher.setHandler((row) => {
      delivered.push(row.idempotencyKey);
    });
    await flush(dispatcher);
    expect(getOutbox(db, first)?.status).toBe("dropped");
    expect(getOutbox(db, milestone)?.status).toBe("sent");
    expect(getOutbox(db, other)?.status).toBe("sent");
    expect(getOutbox(db, latest)?.status).toBe("sent");
    expect(delivered).toEqual(["milestone", "other", "latest"]);
    db.close();
  });

  test("a claimed update remains serialized and questions and results retain their fences", async () => {
    const { db, dispatcher, enqueue } = setup();
    const first = enqueue("first", {
      payload: { kind: "thought", body: "Starting", ephemeral: true },
    });
    const claimed = claimOutboxHeads(db, { now: 5000 });
    expect(claimed[0]?.id).toBe(first);
    const later = enqueue("later", {
      payload: { kind: "action", body: "Testing", ephemeral: true },
    });
    expect(getOutbox(db, first)?.status).toBe("pending");
    const question = enqueue("question", {
      op: "elicitation",
      payload: { sessionId: "A", body: "Which?" },
    });
    expect(getOutbox(db, later)?.status).toBe("dropped");
    expect(getOutbox(db, question)?.status).toBe("pending");
    const final = enqueue("final", { payload: { kind: "response", body: "Done" } });
    expect(getOutbox(db, question)?.status).toBe("dropped");
    const stale = enqueue("stale", { payload: { kind: "thought", body: "Late", ephemeral: true } });
    expect(getOutbox(db, stale)?.status).toBe("dropped");
    dispatcher.setHandler(() => {});
    expect(getOutbox(db, final)?.status).toBe("pending");
    db.close();
  });

  test("duplicate insertion cannot supersede a newer transient update", () => {
    const { db, enqueue } = setup();
    enqueue("first", { payload: { kind: "thought", body: "Starting", ephemeral: true } });
    const latest = enqueue("latest", {
      payload: { kind: "thought", body: "Latest", ephemeral: true },
    });
    enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "first",
      payload: { kind: "thought", body: "Starting", ephemeral: true },
    });
    expect(getOutbox(db, latest)?.status).toBe("pending");
    db.close();
  });
});

describe("persisted Stop fences", () => {
  test("a claimed row cannot start a call after Stop and exactly one acknowledgement survives", async () => {
    const { db, clock, dispatcher, enqueue } = setup();
    const gate = deferred();
    const calls: string[] = [];
    enqueue("progress");
    dispatcher.setHandler(async (row, context) => {
      if (row.idempotencyKey === "progress") await gate.promise;
      if (context.isCurrent()) calls.push(row.idempotencyKey);
    });
    dispatcher.tick();
    const completed = enqueue("completed-status", {
      op: "status",
      payload: { linearIssueId: "done", stateType: "completed" },
    });
    enqueue("question", { op: "elicitation" });
    const generation = stopOutboxSession(db, "linear", "A", clock.now());
    expect(stopOutboxSession(db, "linear", "A", clock.now() + 1)).toBe(generation);
    for (let attempt = 0; attempt < 2; attempt += 1)
      enqueueOutboxOnce(db, {
        target: "linear",
        op: "activity",
        orderingKey: "A",
        generation,
        delivery: "stop",
        idempotencyKey: `stop:A:${generation}`,
        payload: { kind: "response", body: "Stopped" },
      });
    const stale = enqueue("stale-after-stop", { generation: generation - 1 });
    enqueue("other", { orderingKey: "B" });
    dispatcher.tick();
    gate.resolve();
    await dispatcher.idle();
    await flush(dispatcher);
    expect(calls).toEqual(["other", `stop:A:${generation}`]);
    expect(getOutbox(db, stale)?.status).toBe("dropped");
    expect(getOutbox(db, completed)?.payload).toEqual({
      linearIssueId: "done",
      stateType: "completed",
    });
    expect(getOutbox(db, completed)?.status).toBe("dropped");
    db.close();
  });

  test("restart retains Stop and an accepted new generation fences old callbacks", async () => {
    const directory = mkdtempSync(join(tmpdir(), "paws-delivery-"));
    const path = join(directory, "paws.db");
    const first = setup(path);
    const generation = stopOutboxSession(first.db, "linear", "A");
    first.enqueue("stop", {
      delivery: "stop",
      generation,
      payload: { kind: "response", body: "Stopped" },
    });
    first.db.close();
    const second = setup(path);
    try {
      const calls: string[] = [];
      second.dispatcher.setHandler((row) => {
        calls.push(row.idempotencyKey);
      });
      const late = second.enqueue("late");
      await flush(second.dispatcher);
      expect(getOutbox(second.db, late)?.status).toBe("dropped");
      expect(calls).toEqual(["stop"]);
      const next = advanceOutboxSession(second.db, "linear", "A");
      const old = second.enqueue("old-callback", { generation });
      const current = second.enqueue("current", { generation: next });
      await flush(second.dispatcher);
      expect(getOutbox(second.db, old)?.status).toBe("dropped");
      expect(getOutbox(second.db, current)?.status).toBe("sent");
      expect(calls).toEqual(["stop", "current"]);
    } finally {
      second.db.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
