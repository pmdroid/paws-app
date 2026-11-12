import { expect, test } from "bun:test";
import {
  OutboxDispatcher,
  advanceOutboxSession,
  enqueueOutbox,
  getOutboxSteps,
  listOutbox,
  stopOutboxSession,
  type Db,
} from "../src/db";
import { FakeClock } from "../src/core";
import { createLinearClient, createLinearTracker, type LinearClient } from "../src/linear";
import { deliverLinearOutbox } from "../src/loop";
import { tempHome, withHomeStore } from "./helpers";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

function remote() {
  const activities = new Map<string, Record<string, unknown>>();
  const created: Record<string, unknown>[] = [];
  let loseResponse = true;
  let lookup: (() => Promise<unknown>) | undefined;
  const client: LinearClient = {
    async query(query, variables, options) {
      options?.signal?.throwIfAborted();
      if (query.includes("AgentActivityByCallerId")) {
        expect(query).toContain("$id: ID!");
        expect(query).toContain("includeArchived: true");
        if (lookup) return lookup();
        const activity = activities.get(String(variables?.["id"]));
        return {
          agentActivities: {
            nodes: activity ? [activity] : [],
            pageInfo: { hasNextPage: false },
          },
        };
      }
      if (!query.includes("AgentActivityCreate")) throw new Error("Unexpected query");
      const input = variables?.["input"] as Record<string, unknown>;
      const id = String(input["id"]);
      if (activities.has(id)) throw new Error("Duplicate UUIDs are rejected by this server");
      created.push(input);
      activities.set(id, {
        id,
        agentSession: { id: input["agentSessionId"] },
        content: input["content"],
        ephemeral: input["ephemeral"] ?? false,
        signal: input["signal"] ?? null,
        signalMetadata:
          input["signalMetadata"] === undefined ? null : JSON.stringify(input["signalMetadata"]),
      });
      if (loseResponse) {
        loseResponse = false;
        throw new Error("Lost the response after remote acceptance");
      }
      return { agentActivityCreate: { success: true, agentActivity: { id } } };
    },
  };
  const tracker = createLinearTracker(client);
  return {
    tracker,
    activities,
    created,
    setLookup: (read: typeof lookup) => {
      lookup = read;
    },
  };
}

function dispatcher(db: Db, clock: FakeClock, tracker: ReturnType<typeof remote>["tracker"]) {
  const outbox = new OutboxDispatcher(db, clock);
  outbox.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context, db),
  );
  return outbox;
}

test.each(["response", "select", "auth"])(
  "lost %s acceptance reconciles the persisted UUID after a real database reopen",
  async (kind) => {
    const home = tempHome();
    const clock = new FakeClock(1_000);
    const api = remote();
    const body = "Full useful response. ".repeat(1_000);
    const { id, callerId } = await withHomeStore(home, async (db) => {
      const queued = await enqueueOutbox(db, {
        target: "linear",
        op: kind === "response" ? "activity" : "elicitation",
        orderingKey: "session",
        idempotencyKey: "final",
        payload: {
          sessionId: "session",
          kind: "response",
          body,
          ...(kind === "select" ? { options: ["yes", "no"] } : {}),
          ...(kind === "auth"
            ? {
                auth: {
                  url: "https://github.com/login/device",
                  userId: "human",
                  providerName: "GitHub",
                },
              }
            : {}),
        },
      });
      const first = dispatcher(db, clock, api.tracker);
      await first.tick();
      await first.idle();
      const prepared = (await db.run((q) => getOutboxSteps(q, queued)))!;
      expect(prepared.status).toBe("pending");
      return { id: queued, callerId: (prepared.payload as { id: string }).id };
    });
    expect(callerId).toMatch(/^[\da-f-]{36}$/);
    expect(api.created).toHaveLength(1);
    expect(api.created[0]?.["id"]).toBe(callerId);
    await withHomeStore(home, async (reopened) => {
      clock.advance(2_000);
      const recovered = dispatcher(reopened, clock, api.tracker);
      await recovered.tick();
      await recovered.idle();
      const row = (await reopened.run((q) => getOutboxSteps(q, id)))!;
      expect(row.status).toBe("sent");
      expect((row.payload as { id: string }).id).toBe(callerId);
      expect(api.created).toHaveLength(1);
      expect(api.activities.get(callerId)?.["content"]).toMatchObject({ body });
    });
  },
);

test.each(["mismatch", "incomplete", "unavailable", "malformed metadata", "nonobject metadata"])(
  "a %s reconciliation cannot resend or confirm a terminal reply",
  async (failure) => {
    const { db, close } = await tempStore();
    try {
      const clock = new FakeClock(1_000);
      const api = remote();
      await enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "session",
        idempotencyKey: "final",
        payload: { sessionId: "session", kind: "error", body: "Execution halted" },
      });
      const outbox = dispatcher(db, clock, api.tracker);
      await outbox.tick();
      await outbox.idle();
      if (failure === "mismatch")
        api.activities.values().next().value!["content"] = {
          type: "error",
          body: "Another message",
        };
      else if (failure.endsWith("metadata"))
        api.activities.values().next().value!["signalMetadata"] =
          failure === "malformed metadata" ? "invalid" : "[]";
      else
        api.setLookup(async () => {
          if (failure === "unavailable") throw new Error("Linear temporarily unavailable");
          return { agentActivities: { nodes: [] } };
        });
      clock.advance(2_000);
      await outbox.tick();
      await outbox.idle();
      expect((await listOutbox(db))[0]?.status).toBe("pending");
      expect(api.created).toHaveLength(1);
    } finally {
      await close();
    }
  },
);

test("Stop during an empty reconciliation fences the subsequent mutation before the next dispatcher tick", async () => {
  const { db, close } = await tempStore();
  try {
    const clock = new FakeClock(1_000);
    const api = remote();
    await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      idempotencyKey: "final",
      payload: { sessionId: "session", kind: "response", body: "Prepared answer" },
    });
    const outbox = dispatcher(db, clock, api.tracker);
    await outbox.tick();
    await outbox.idle();
    const pending = Promise.withResolvers<unknown>();
    const reading = Promise.withResolvers<void>();
    api.activities.clear();
    api.setLookup(async () => {
      reading.resolve();
      return pending.promise;
    });
    clock.advance(2_000);
    await outbox.tick();
    await reading.promise;
    await stopOutboxSession(db, "linear", "session", clock.now());
    pending.resolve({ agentActivities: { nodes: [], pageInfo: { hasNextPage: false } } });
    await outbox.idle();
    expect(api.created).toHaveLength(1);
    expect((await listOutbox(db))[0]?.status).toBe("dropped");
  } finally {
    await close();
  }
});

test.each(["credentials", "reconciliation"])(
  "a generation change during actual client %s prevents activity publication without another tick",
  async (boundary) => {
    const { db, close } = await tempStore();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const queries: string[] = [];
    try {
      const tracker = createLinearTracker(
        createLinearClient({
          auth: {
            hasToken: async () => true,
            async ensureFresh() {
              if (boundary === "credentials") {
                started.resolve();
                await release.promise;
              }
              return "fixture-token";
            },
            forceRefresh: async () => "fixture-token",
          },
          async fetch(_url, request) {
            const { query } = JSON.parse(String(request?.body)) as { query: string };
            queries.push(query);
            if (query.includes("AgentActivityByCallerId")) {
              started.resolve();
              await release.promise;
              return Response.json({
                data: { agentActivities: { nodes: [], pageInfo: { hasNextPage: false } } },
              });
            }
            throw new Error("Superseded activity reached transport");
          },
        }),
      );
      await enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "session",
        idempotencyKey: "fenced-activity",
        payload: {
          id: crypto.randomUUID(),
          sessionId: "session",
          kind: "thought",
          body: "Working",
        },
      });
      if (boundary === "reconciliation")
        await seed(db, (q) => q.orm.update(q.t.outbox).set({ attempts: 1 }));
      const outbox = new OutboxDispatcher(db, new FakeClock(1000));
      outbox.setHandler((row, context) =>
        deliverLinearOutbox(row, tracker, async () => {}, context, db),
      );
      await outbox.tick();
      await started.promise;
      await advanceOutboxSession(db, "linear", "session");
      release.resolve();
      await outbox.idle();
      expect(queries.some((query) => query.includes("mutation"))).toBe(false);
      expect(queries).toHaveLength(boundary === "credentials" ? 0 : 1);
      expect((await listOutbox(db))[0]?.status).toBe("dropped");
    } finally {
      release.resolve();
      await close();
    }
  },
);
