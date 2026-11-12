import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../../src/core";
import {
  OutboxDispatcher,
  beginImplementRun,
  claimOutboxHeads,
  completeOutbox,
  enqueueOutbox,
  getOutboxSteps,
  insertQueuedItem,
  insertRun,
  openPawsStore,
  setCurrentRun,
} from "../../src/db";
import { createLinearClient, createLinearLedger, createLinearTracker } from "../../src/linear";
import { createAcpActivityReporter, deliverLinearOutbox } from "../../src/loop";
import { pgliteServer } from "../pglite";

export async function probeLinearActivityBudget(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
  eventCount = 3_000,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const postgres = await pgliteServer();
  const connect = () => openPawsStore({ url: postgres.url, pgliteDir: "" });
  let open = await connect();
  let db = open.store;
  async function reopen() {
    await open.close();
    open = await connect();
    db = open.store;
  }
  const clock = new FakeClock(Date.now());
  let limited = false;
  let requests = 0;
  const activities = new Map<string, Record<string, unknown>>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      requests++;
      const { query, variables } = (await request.json()) as {
        query: string;
        variables: Record<string, unknown>;
      };
      if (limited)
        return Response.json(
          { errors: [{ message: "RATELIMITED", extensions: { code: "RATELIMITED" } }] },
          { status: 429, headers: { "retry-after": "120" } },
        );
      if (query.includes("AgentActivityByCallerId")) {
        const found = activities.get(String(variables["id"]));
        return Response.json({
          data: {
            agentActivities: {
              nodes: found ? [found] : [],
              pageInfo: { hasNextPage: false },
            },
          },
        });
      }
      assert.match(query, /AgentActivityCreate/);
      const input = variables["input"] as Record<string, unknown>;
      const id = String(input["id"]);
      assert(!activities.has(id));
      activities.set(id, {
        id,
        agentSession: { id: input["agentSessionId"] },
        content: input["content"],
        ephemeral: input["ephemeral"] ?? false,
        signal: input["signal"] ?? null,
        signalMetadata:
          input["signalMetadata"] === undefined ? null : JSON.stringify(input["signalMetadata"]),
      });
      return Response.json({
        data: { agentActivityCreate: { success: true, agentActivity: { id } } },
      });
    },
  });
  const tracker = createLinearTracker(
    createLinearClient({
      auth: {
        hasToken: async () => true,
        ensureFresh: async () => "fixture",
        forceRefresh: async () => "fixture",
      },
      fetch: (_input, init) => fetch(`http://127.0.0.1:${server.port}/graphql`, init),
      ledger: createLinearLedger({ now: () => clock.now(), random: () => 0, log: () => {} }),
    }),
  );
  function dispatcher() {
    const result = new OutboxDispatcher(db, clock);
    result.setHandler((row, context) =>
      row.target === "linear"
        ? deliverLinearOutbox(row, tracker, async () => {}, context, db)
        : undefined,
    );
    return result;
  }
  let outbox = dispatcher();
  let sequence = 0;
  async function activity(sessionId: string, kind: string, itemId?: string) {
    return await enqueueOutbox(db, {
      target: "linear",
      op: kind === "elicitation" ? "elicitation" : "activity",
      orderingKey: sessionId,
      idempotencyKey: `budget:${sequence++}`,
      now: clock.now(),
      payload: { sessionId, kind, itemId, body: `Useful update ${sequence}` },
    });
  }
  try {
    const item = await insertQueuedItem(db, { id: "chatty", sessionKey: "chatty" });
    const original = await beginImplementRun(db, item.id, clock.now());
    const reported: Record<string, unknown>[] = [];
    const reporter = createAcpActivityReporter((payload) => reported.push(payload));
    for (let n = 0; n < eventCount; n++)
      reporter.onEvent({ type: "progress", text: `Checked ${n}.` });
    for (const payload of reported)
      await enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "chatty",
        idempotencyKey: `chatty:${sequence++}`,
        payload: { ...payload, sessionId: "chatty", itemId: item.id },
        now: clock.now(),
      });
    const final = await activity("chatty", "response", item.id);
    for (let n = 0; n < 61; n++) {
      await outbox.tick();
      await outbox.idle();
    }
    assert.equal(activities.size, 61);
    assert.equal((await db.run((q) => getOutboxSteps(q, final)))?.status, "pending");
    observe("Public history passes the former hourly cap before the final response", true, {
      events: eventCount,
      published: activities.size,
      finalWaitsForHistory: true,
    });
    await reopen();
    outbox = dispatcher();
    for (let n = 61; n < eventCount + 1; n++) {
      await outbox.tick();
      await outbox.idle();
    }
    assert.equal(activities.size, eventCount + 1);
    const delivered = [...activities.values()];
    for (let n = 0; n < eventCount; n++) {
      const output = delivered[n]!["content"] as Record<string, unknown>;
      assert.equal(output["type"], "thought");
      assert.equal(output["body"], `Checked ${n}.`);
      assert.equal(delivered[n]!["ephemeral"], false);
    }
    assert.equal((await db.run((q) => getOutboxSteps(q, final)))?.status, "sent");
    observe("Every public update survives a store reopen and precedes the final response", true, {
      published: activities.size,
      orderedTools: eventCount,
      noClockAdvance: true,
    });
    clock.advance(600_000);
    const keepalive = await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "chatty-keepalive",
      delivery: "critical",
      idempotencyKey: "chatty-keepalive",
      now: clock.now(),
      payload: {
        sessionId: "chatty-keepalive",
        kind: "thought",
        body: "Still working.",
        ephemeral: true,
      },
    });
    await outbox.tick();
    await outbox.idle();
    assert.equal((await db.run((q) => getOutboxSteps(q, keepalive)))?.status, "sent");
    observe("Keepalives remain deliverable alongside complete public history", true, {
      keepaliveSent: true,
    });
    const nextRun = await insertRun(db, {
      itemId: item.id,
      status: "active",
      kind: "implement",
      agent: "cursor",
      now: clock.now(),
    });
    await setCurrentRun(db, item.id, nextRun.id);
    const nextId = await activity("next-run-session", "thought", item.id);
    await outbox.tick();
    await outbox.idle();
    assert.equal((await db.run((q) => getOutboxSteps(q, nextId)))?.status, "sent");
    assert.notEqual(original.run.id, nextRun.id);
    observe("A new canonical run gets its first update without replaying stale progress", true, {
      runChanged: true,
    });
    const question = await activity("question-session", "elicitation", item.id);
    await outbox.tick();
    await outbox.idle();
    assert.equal((await db.run((q) => getOutboxSteps(q, question)))?.status, "sent");
    const questionFinal = await activity("question-session", "response", item.id);
    await outbox.tick();
    await outbox.idle();
    assert.equal((await db.run((q) => getOutboxSteps(q, questionFinal)))?.status, "sent");
    observe(
      "Questions and the final response are delivered exactly once after queued history",
      true,
      {
        questionSent: true,
        responseSent: true,
      },
    );
    limited = true;
    const critical = await activity("rate-limited", "thought");
    for (let n = 0; n < 7; n++) {
      await outbox.tick();
      await outbox.idle();
      assert.equal((await db.run((q) => getOutboxSteps(q, critical)))?.status, "pending");
      const before = requests;
      await activity(`other-${n}`, "thought");
      const slack = await enqueueOutbox(db, {
        target: "slack",
        op: "message",
        idempotencyKey: `slack:${n}`,
      });
      await outbox.tick();
      await outbox.idle();
      assert.equal(requests, before);
      assert.equal((await db.run((q) => getOutboxSteps(q, slack)))?.status, "sent");
      if (n === 0) {
        await reopen();
        outbox = dispatcher();
        assert.equal((await outbox.tick()).length, 0);
      }
      clock.advance(120_000);
    }
    limited = false;
    await outbox.tick();
    await outbox.idle();
    assert.equal((await db.run((q) => getOutboxSteps(q, critical)))?.status, "sent");
    assert.equal((await db.run((q) => getOutboxSteps(q, critical)))?.attempts, 8);
    observe(
      "Actual HTTP429 Retry-After persists across restart and preserves normal history through seven limits",
      true,
      {
        attempts: (await db.run((q) => getOutboxSteps(q, critical)))?.attempts,
        delivered: true,
        otherTargetsUnaffected: true,
      },
    );
    const reserve = await insertQueuedItem(db, { id: "reservation" });
    await beginImplementRun(db, reserve.id, clock.now());
    for (let n = 0; n < 80; n++) await activity(`parallel-${n}`, "thought", reserve.id);
    const second = await connect();
    try {
      const first = await claimOutboxHeads(db, {
        now: clock.now(),
        limit: 59,
        workerId: "one",
      });
      const rest = await claimOutboxHeads(second.store, {
        now: clock.now(),
        limit: 80,
        workerId: "two",
      });
      assert.equal(first.length, 59);
      assert.equal(rest.length, 21);
      for (const row of first) await completeOutbox(db, row, clock.now());
      for (const row of rest) await completeOutbox(second.store, row, clock.now());
      assert.equal((await claimOutboxHeads(db, { now: clock.now() })).length, 0);
      observe(
        "Two store connections claim all eighty independent sessions without duplicate delivery",
        true,
        {
          first: first.length,
          second: rest.length,
        },
      );
    } finally {
      await second.close();
    }
  } finally {
    await open.close();
    await postgres.close();
    await server.stop(true);
  }
}

if (import.meta.main) {
  const root = process.argv[2];
  if (!root) throw new Error("Provide a disposable evidence directory");
  const observations: unknown[] = [];
  try {
    await probeLinearActivityBudget(root, (name, passed, observed) =>
      observations.push({ name, passed, observed }),
    );
  } finally {
    mkdirSync(root, { recursive: true, mode: 0o700 });
    writeFileSync(join(root, "observations.json"), JSON.stringify(observations, null, 2));
  }
}
