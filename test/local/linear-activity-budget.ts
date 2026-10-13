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
  getOutbox,
  insertQueuedItem,
  insertRun,
  immediate,
  migrate,
  openDatabase,
  setCurrentRun,
} from "../../src/db";
import { createLinearClient, createLinearTracker } from "../../src/linear";
import { createAcpActivityReporter, deliverLinearOutbox } from "../../src/loop";

export async function probeLinearActivityBudget(
  root: string,
  observe: (name: string, passed: boolean, observed: unknown) => void,
  eventCount = 3_000,
) {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const path = join(root, "activities.sqlite");
  let db = openDatabase(path);
  migrate(db);
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
        hasToken: () => true,
        ensureFresh: async () => "fixture",
        forceRefresh: async () => "fixture",
      },
      fetch: (_input, init) => fetch(`http://127.0.0.1:${server.port}/graphql`, init),
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
  function activity(sessionId: string, kind: string, itemId?: string) {
    return enqueueOutbox(db, {
      target: "linear",
      op: kind === "elicitation" ? "elicitation" : "activity",
      orderingKey: sessionId,
      idempotencyKey: `budget:${sequence++}`,
      now: clock.now(),
      payload: { sessionId, kind, itemId, body: `Useful update ${sequence}` },
    });
  }
  try {
    const item = insertQueuedItem(db, { id: "chatty", sessionKey: "chatty" });
    const original = beginImplementRun(db, item.id, clock.now());
    const reporter = createAcpActivityReporter((payload) =>
      enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "chatty",
        idempotencyKey: `chatty:${sequence++}`,
        payload: { ...payload, sessionId: "chatty", itemId: item.id },
        now: clock.now(),
      }),
    );
    immediate(db, () => {
      for (let n = 0; n < eventCount; n++) {
        reporter.onEvent({
          type: "session_update",
          sessionId: "scripted-chatty-agent",
          update: {
            sessionUpdate: "tool_call",
            toolCallId: String(n),
            title: "Run a useful check",
            status: "completed",
            kind: "execute",
            rawOutput: `Result ${n}`,
          },
        });
      }
    });
    for (let n = 0; n < 61; n++) {
      outbox.tick();
      await outbox.idle();
    }
    assert.equal(activities.size, 60);
    observe(
      "Three thousand actual ACP tool events publish sixty normal activities per run-hour",
      true,
      {
        events: 3_000,
        published: activities.size,
      },
    );
    clock.advance(600_000);
    const keepalive = enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "chatty",
      delivery: "critical",
      idempotencyKey: "chatty-keepalive",
      now: clock.now(),
      payload: {
        sessionId: "chatty",
        itemId: item.id,
        kind: "thought",
        body: "Still working.",
        ephemeral: true,
      },
    });
    outbox.tick();
    await outbox.idle();
    assert.equal(getOutbox(db, keepalive)?.status, "sent");
    assert.equal(activities.size, 61);
    observe(
      "Ten-minute keepalives remain deliverable after the normal run budget is exhausted",
      true,
      { keepaliveSent: true },
    );
    activity("chatty", "thought", item.id);
    db.close();
    db = openDatabase(path);
    migrate(db);
    outbox = dispatcher();
    assert.equal(outbox.tick().length, 0);
    clock.advance(3_000_000);
    outbox.tick();
    await outbox.idle();
    assert.equal(activities.size, 62);
    observe(
      "The hourly limit survives a real database reopen and releases at the window boundary",
      true,
      {
        published: activities.size,
      },
    );
    const nextRun = insertRun(db, {
      itemId: item.id,
      status: "active",
      kind: "implement",
      agent: "cursor",
      now: clock.now(),
    });
    setCurrentRun(db, item.id, nextRun.id);
    const nextId = activity("chatty", "thought", item.id);
    outbox.tick();
    await outbox.idle();
    assert.equal(getOutbox(db, nextId)?.status, "sent");
    assert.notEqual(original.run.id, nextRun.id);
    observe("A new canonical run gets its first update without replaying stale progress", true, {
      runChanged: true,
    });
    const question = activity("chatty", "elicitation", item.id);
    outbox.tick();
    await outbox.idle();
    const final = activity("chatty", "response", item.id);
    outbox.tick();
    await outbox.idle();
    assert.equal(getOutbox(db, question)?.status, "sent");
    assert.equal(getOutbox(db, final)?.status, "sent");
    observe("Questions and the final response bypass normal progress limits exactly once", true, {
      questionSent: true,
      responseSent: true,
    });
    limited = true;
    const critical = activity("rate-limited", "elicitation");
    for (let n = 0; n < 7; n++) {
      outbox.tick();
      await outbox.idle();
      assert.equal(getOutbox(db, critical)?.status, "pending");
      const before = requests;
      activity(`other-${n}`, "thought");
      const slack = enqueueOutbox(db, {
        target: "slack",
        op: "message",
        idempotencyKey: `slack:${n}`,
      });
      outbox.tick();
      await outbox.idle();
      assert.equal(requests, before);
      assert.equal(getOutbox(db, slack)?.status, "sent");
      if (n === 0) {
        db.close();
        db = openDatabase(path);
        migrate(db);
        outbox = dispatcher();
        assert.equal(outbox.tick().length, 0);
      }
      clock.advance(120_000);
    }
    limited = false;
    outbox.tick();
    await outbox.idle();
    assert.equal(getOutbox(db, critical)?.status, "sent");
    assert.equal(getOutbox(db, critical)?.attempts, 8);
    observe(
      "Actual HTTP429 Retry-After persists across restart and preserves critical replies through seven limits",
      true,
      {
        attempts: getOutbox(db, critical)?.attempts,
        delivered: true,
        otherTargetsUnaffected: true,
      },
    );
    const reserve = insertQueuedItem(db, { id: "reservation" });
    beginImplementRun(db, reserve.id, clock.now());
    for (let n = 0; n < 80; n++) activity(`parallel-${n}`, "thought", reserve.id);
    const second = openDatabase(path);
    try {
      const first = claimOutboxHeads(db, { now: clock.now(), limit: 59, workerId: "one" });
      const rest = claimOutboxHeads(second, { now: clock.now(), limit: 80, workerId: "two" });
      assert.equal(first.length, 59);
      assert.equal(rest.length, 1);
      for (const row of first) completeOutbox(db, row, clock.now());
      for (const row of rest) completeOutbox(second, row, clock.now());
      assert.equal(claimOutboxHeads(db, { now: clock.now() }).length, 0);
      observe(
        "Two actual SQLite connections reserve at most sixty concurrent progress deliveries for the same run",
        true,
        {
          first: first.length,
          second: rest.length,
        },
      );
    } finally {
      second.close();
    }
  } finally {
    db.close();
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
