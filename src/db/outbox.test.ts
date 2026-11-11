import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { FakeClock, OUTBOX_ACTIVITY } from "../core";
import {
  OutboxDispatcher,
  applyWorkItemEventSteps,
  enqueueOutbox,
  enqueueOutboxOnce,
  enqueueOutboxSteps,
  insertQueuedItem,
  listOutbox,
  migrate,
  openDatabase,
  setJournalSink,
  sqliteDb,
} from "./index";

function harness(batchSize = 32) {
  const clock = new FakeClock(5_000);
  const db = openDatabase(":memory:");
  migrate(db);
  const dispatcher = new OutboxDispatcher(db, clock, { batchSize, backoffBaseMs: 1_000 });
  return { clock, db, dispatcher };
}

describe("transactional outbox", () => {
  test("a state change and its activity commit or roll back together", async () => {
    const { db } = harness();
    const item = insertQueuedItem(db, { sessionKey: "ses" });
    await expect(
      sqliteDb(db).transaction(function* (q) {
        yield* applyWorkItemEventSteps(q, item.id, "dispatched");
        yield* enqueueOutboxSteps(q, {
          target: OUTBOX_ACTIVITY.target,
          op: OUTBOX_ACTIVITY.op,
          orderingKey: "ses",
          payload: { text: "Started." },
          idempotencyKey: "start",
        });
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    const rolled = db
      .query<{ state: string }, [string]>("SELECT state FROM work_item WHERE id = ?")
      .get(item.id);
    expect(rolled?.state).toBe("queued");
    expect(await listOutbox(sqliteDb(db))).toHaveLength(0);

    await sqliteDb(db).transaction(function* (q) {
      yield* applyWorkItemEventSteps(q, item.id, "dispatched");
      yield* enqueueOutboxSteps(q, {
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
    expect((await listOutbox(sqliteDb(db), "ses")).map((message) => message.payload)).toEqual([
      { text: "Started." },
    ]);
  });

  test("the same idempotency key is stored once", async () => {
    const { db } = harness();
    const first = await enqueueOutboxOnce(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "ses",
      idempotencyKey: "wake:1",
      payload: { text: "a" },
    });
    const second = await enqueueOutboxOnce(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "ses",
      idempotencyKey: "wake:1",
      payload: { text: "b" },
    });
    expect(second).toBe(first);
    expect(await listOutbox(sqliteDb(db))).toHaveLength(1);
  });

  test("sessions stay ordered, and a stuck session does not block the others", async () => {
    const { clock, db, dispatcher } = harness(1);
    await enqueueOutbox(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A1",
      payload: { n: "A1" },
      now: clock.now(),
    });
    await enqueueOutbox(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A2",
      payload: { n: "A2" },
      now: clock.now(),
    });
    clock.advance(1);
    await enqueueOutbox(sqliteDb(db), {
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

    // Delivery awaits the database before the handler, so let each claimed head reach it.
    await dispatcher.tick();
    await Bun.sleep(0);
    expect(seen).toEqual(["A1"]);
    await dispatcher.tick();
    await Bun.sleep(0);
    expect(seen).toEqual(["A1", "B1"]);
    expect(
      (await listOutbox(sqliteDb(db), "A")).find(
        (message) => (message.payload as { n: string }).n === "A2",
      )?.status,
    ).toBe("pending");
    expect((await listOutbox(sqliteDb(db), "B"))[0]?.status).toBe("sent");

    releaseA();
    await dispatcher.idle();
    await dispatcher.tick();
    await dispatcher.idle();
    expect(seen).toEqual(["A1", "B1", "A2"]);
    expect(
      (await listOutbox(sqliteDb(db), "A")).every((message) => message.status === "sent"),
    ).toBe(true);
  });

  test("a failed head holds only its own session", async () => {
    const { db, dispatcher } = harness();
    await enqueueOutbox(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A1",
      payload: { n: "A1" },
      maxAttempts: 1,
    });
    await enqueueOutbox(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A2",
      payload: { n: "A2" },
    });
    await enqueueOutbox(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "B",
      idempotencyKey: "B1",
      payload: { n: "B1" },
    });
    await enqueueOutbox(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "B",
      idempotencyKey: "B2",
      payload: { n: "B2" },
    });
    dispatcher.setHandler((message) => {
      if (message.orderingKey === "A") throw new Error("nope");
    });

    await dispatcher.tick();
    await dispatcher.idle();
    expect((await listOutbox(sqliteDb(db), "A"))[0]?.status).toBe("dead");
    expect((await listOutbox(sqliteDb(db), "A"))[1]?.status).toBe("pending");
    expect((await listOutbox(sqliteDb(db), "B"))[0]?.status).toBe("sent");
    expect((await listOutbox(sqliteDb(db), "B"))[1]?.status).toBe("pending");

    await dispatcher.tick();
    await dispatcher.idle();
    expect((await listOutbox(sqliteDb(db), "A"))[1]?.status).toBe("pending");
    expect((await listOutbox(sqliteDb(db), "B"))[1]?.status).toBe("sent");
  });

  test("a retry waits out its backoff and then keeps session order", async () => {
    const { clock, db, dispatcher } = harness();
    await enqueueOutbox(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A1",
      payload: { n: "A1" },
      now: clock.now(),
    });
    await enqueueOutbox(sqliteDb(db), {
      target: "linear",
      op: "activity",
      orderingKey: "A",
      idempotencyKey: "A2",
      payload: { n: "A2" },
      now: clock.now(),
    });
    await enqueueOutbox(sqliteDb(db), {
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

    await dispatcher.tick();
    await dispatcher.idle();
    expect((await listOutbox(sqliteDb(db), "B"))[0]?.status).toBe("sent");
    expect((await listOutbox(sqliteDb(db), "A"))[0]?.status).toBe("pending");
    expect((await listOutbox(sqliteDb(db), "A"))[1]?.status).toBe("pending");

    await dispatcher.tick();
    await dispatcher.idle();
    expect((await listOutbox(sqliteDb(db), "A"))[0]?.status).toBe("pending");

    clock.advance(1_000);
    await dispatcher.tick();
    await dispatcher.idle();
    expect((await listOutbox(sqliteDb(db), "A"))[0]?.status).toBe("sent");
    expect((await listOutbox(sqliteDb(db), "A"))[1]?.status).toBe("pending");
    await dispatcher.tick();
    await dispatcher.idle();
    expect((await listOutbox(sqliteDb(db), "A"))[1]?.status).toBe("sent");
  });

  test("a claim error does not stop later delivery", async () => {
    const clock = new FakeClock(5_000);
    const real = openDatabase(":memory:");
    migrate(real);
    let fail = true;
    const db = new Proxy(real, {
      get(target, property) {
        if (property === "prepare") {
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!fail || !sql.includes('update "outbox" set "attempts" = "outbox"."attempts" + 1'))
              return statement;
            return new Proxy(statement, {
              get(statementTarget, statementProperty, statementReceiver) {
                if (statementProperty === "all" || statementProperty === "values") {
                  return () => {
                    fail = false;
                    throw new Error("SQLITE_BUSY: database is locked");
                  };
                }
                const value = Reflect.get(statementTarget, statementProperty, statementReceiver);
                return typeof value === "function" ? value.bind(statementTarget) : value;
              },
            });
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Database;
    const lines: string[] = [];
    const restore = setJournalSink((line) => lines.push(line));
    const dispatcher = new OutboxDispatcher(db, clock);
    await enqueueOutbox(sqliteDb(real), {
      target: "linear",
      op: "activity",
      orderingKey: "ses",
      idempotencyKey: "once",
      payload: { text: "hi" },
      now: clock.now(),
    });
    const seen: number[] = [];
    dispatcher.setHandler((message) => {
      seen.push(message.id);
    });
    const controller = new AbortController();
    let steps = 0;
    try {
      await dispatcher.run(controller.signal, async () => {
        steps += 1;
        if (seen.length > 0 || steps > 3) controller.abort();
      });
      expect(seen).toHaveLength(1);
      expect((await listOutbox(sqliteDb(real)))[0]?.status).toBe("sent");
      expect(
        lines.some((line) => line.includes("dispatcher.run.tick") && line.includes("SQLITE_BUSY")),
      ).toBe(true);
    } finally {
      restore();
      real.close();
    }
  });
});
