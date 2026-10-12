import { expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import {
  enqueueOutbox,
  getOutbox,
  migrate,
  openDatabase,
  OutboxDispatcher,
  stopOutboxSession,
} from "../src/db";
import { createLinearClient, createLinearTracker } from "../src/linear";
import { deliverLinearOutbox } from "../src/loop";

test("Stop aborts active Linear HTTP delivery before its final acknowledgement starts", async () => {
  const db = openDatabase(":memory:");
  migrate(db);
  const dispatcher = new OutboxDispatcher(db, new FakeClock(5000));
  const calls: string[] = [];
  let started = () => {};
  const active = new Promise<void>((resolve) => (started = resolve));
  const tracker = createLinearTracker(
    createLinearClient({
      auth: {
        ensureFresh: async () => "fixture-token",
        forceRefresh: async () => "fixture-token",
        hasToken: () => true,
      },
      fetch: async (_url, init) => {
        const input = JSON.parse(String(init?.body)).variables.input;
        const body = input.content.body;
        calls.push(body);
        if (body === "Working") {
          started();
          return new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener(
              "abort",
              () => {
                calls.push("aborted");
                reject(init.signal?.reason);
              },
              { once: true },
            );
          });
        }
        return Response.json({
          data: { agentActivityCreate: { success: true, agentActivity: { id: "ack" } } },
        });
      },
    }),
  );
  dispatcher.setHandler((message, context) =>
    deliverLinearOutbox(message, tracker, async () => {}, context),
  );
  const progress = enqueueOutbox(db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    idempotencyKey: "progress",
    payload: { sessionId: "session", kind: "thought", body: "Working" },
  });
  try {
    dispatcher.tick();
    await active;
    const generation = stopOutboxSession(db, "linear", "session");
    const ack = enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      idempotencyKey: `stop:${generation}`,
      delivery: "stop",
      generation,
      payload: { sessionId: "session", kind: "response", body: "Stopped" },
    });
    expect(dispatcher.tick()).toEqual([]);
    await dispatcher.idle();
    expect(calls).toEqual(["Working", "aborted"]);
    dispatcher.tick();
    await dispatcher.idle();
    expect(calls).toEqual(["Working", "aborted", "Stopped"]);
    expect(getOutbox(db, progress)?.status).toBe("dropped");
    expect(getOutbox(db, ack)?.status).toBe("sent");
  } finally {
    db.close();
  }
});
