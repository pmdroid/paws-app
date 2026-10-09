import { describe, expect, test } from "bun:test";
import { FakeClock, OUTBOX_ACTIVITY } from "../core";
import {
  OutboxDispatcher,
  applyWorkItemEvent,
  enqueueOutbox,
  enqueueOutboxOnce,
  immediate,
  insertQueuedItem,
  listOutbox,
  migrate,
  openDatabase,
} from "./index";

function harness(batchSize = 32) {
  const clock = new FakeClock(5_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const dispatcher = new OutboxDispatcher(db, clock, { batchSize, backoffBaseMs: 1_000 });
  return { clock, db, dispatcher };
}

describe("transactional outbox", () => {
  test("a state change and its activity commit or roll back together", () => {
    const { db } = harness();
    const item = insertQueuedItem(db, { sessionKey: "ses" });
    expect(() =>
      immediate(db, () => {
        applyWorkItemEvent(db, item.id, "dispatched");
        enqueueOutbox(db, {
          target: OUTBOX_ACTIVITY.target,
          op: OUTBOX_ACTIVITY.op,
          orderingKey: "ses",
          payload: { text: "Started." },
          idempotencyKey: "start",
        });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    const rolled = db
      .query<{ state: string }, [string]>("SELECT state FROM work_item WHERE id = ?")
      .get(item.id);
    expect(rolled?.state).toBe("queued");
    expect(listOutbox(db)).toHaveLength(0);

    immediate(db, () => {
      applyWorkItemEvent(db, item.id, "dispatched");
      enqueueOutbox(db, {
        target: OUTBOX_ACTIVITY.target,
        op: OUTBOX_ACTIVITY.op,
        orderingKey: "ses",
        payload: { text: "Started." },
        idempotencyKey: "start",
      });
    });
    const kept = db
      .query<{ state: string }, [string]>("SELECT state FROM work_item WHERE id = ?")
      .get(item.id);
    expect(kept?.state).toBe("running");
    expect(listOutbox(db, "ses").map((message) => message.payload)).toEqual([{ text: "Started." }]);
  });

  test("the same idempotency key is stored once", () => {
    const { db } = harness();
    const first = enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses",
      idempotencyKey: "wake:1",
      payload: { text: "a" },
    });
    const second = enqueueOutboxOnce(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses",
      idempotencyKey: "wake:1",
      payload: { text: "b" },
    });
    expect(second).toBe(first);
    expect(listOutbox(db)).toHaveLength(1);
  });

  test("sessions stay ordered, and a stuck session does not block the others", async () => {
    const { clock, db, dispatcher } = harness(1);
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A1",
      payload: { n: "A1" },
      now: clock.now(),
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A2",
      payload: { n: "A2" },
      now: clock.now(),
    });
    clock.advance(1);
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "B",
      idempotencyKey: "B1",
      payload: { n: "B1" },
      now: clock.now(),
    });
    let releaseA = (): void => {};
    const seen: string[] = [];
    dispatcher.setHandler(async (message) => {
      const payload = message.payload as { n: string };
      seen.push(payload.n);
      if (payload.n === "A1") {
        await new Promise<void>((resolve) => {
          releaseA = () => resolve();
        });
      }
    });

    dispatcher.tick();
    expect(seen).toEqual(["A1"]);
    dispatcher.tick();
    expect(seen).toEqual(["A1", "B1"]);
    expect(
      listOutbox(db, "A").find((message) => (message.payload as { n: string }).n === "A2")?.status,
    ).toBe("pending");
    await Promise.resolve();
    expect(listOutbox(db, "B")[0]?.status).toBe("sent");

    releaseA();
    await dispatcher.idle();
    dispatcher.tick();
    await dispatcher.idle();
    expect(seen).toEqual(["A1", "B1", "A2"]);
    expect(listOutbox(db, "A").every((message) => message.status === "sent")).toBe(true);
  });

  test("a failed head holds only its own session", async () => {
    const { db, dispatcher } = harness();
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A1",
      payload: { n: "A1" },
      maxAttempts: 1,
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A2",
      payload: { n: "A2" },
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "B",
      idempotencyKey: "B1",
      payload: { n: "B1" },
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "B",
      idempotencyKey: "B2",
      payload: { n: "B2" },
    });
    dispatcher.setHandler((message) => {
      if (message.orderingKey === "A") throw new Error("nope");
    });

    dispatcher.tick();
    await dispatcher.idle();
    expect(listOutbox(db, "A")[0]?.status).toBe("dead");
    expect(listOutbox(db, "A")[1]?.status).toBe("pending");
    expect(listOutbox(db, "B")[0]?.status).toBe("sent");
    expect(listOutbox(db, "B")[1]?.status).toBe("pending");

    dispatcher.tick();
    await dispatcher.idle();
    expect(listOutbox(db, "A")[1]?.status).toBe("pending");
    expect(listOutbox(db, "B")[1]?.status).toBe("sent");
  });

  test("a retry waits out its backoff and then keeps session order", async () => {
    const { clock, db, dispatcher } = harness();
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A1",
      payload: { n: "A1" },
      now: clock.now(),
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A2",
      payload: { n: "A2" },
      now: clock.now(),
    });
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "B",
      idempotencyKey: "B1",
      payload: { n: "B1" },
      now: clock.now(),
    });
    let aFailures = 0;
    dispatcher.setHandler((message) => {
      if (message.orderingKey !== "A") return;
      aFailures += 1;
      if (aFailures === 1) throw new Error("blip");
    });

    dispatcher.tick();
    await dispatcher.idle();
    expect(listOutbox(db, "B")[0]?.status).toBe("sent");
    expect(listOutbox(db, "A")[0]?.status).toBe("pending");
    expect(listOutbox(db, "A")[1]?.status).toBe("pending");

    dispatcher.tick();
    await dispatcher.idle();
    expect(listOutbox(db, "A")[0]?.status).toBe("pending");

    clock.advance(1_000);
    dispatcher.tick();
    await dispatcher.idle();
    expect(listOutbox(db, "A")[0]?.status).toBe("sent");
    expect(listOutbox(db, "A")[1]?.status).toBe("pending");
    dispatcher.tick();
    await dispatcher.idle();
    expect(listOutbox(db, "A")[1]?.status).toBe("sent");
  });
});
