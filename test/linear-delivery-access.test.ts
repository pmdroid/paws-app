import { expect, test } from "bun:test";
import { join } from "node:path";
import { systemClock } from "../src/core";
import {
  advanceLinearSessionGeneration,
  applyWorkItemEvent,
  bindLinearSessionTask,
  enqueueOutboxOnce,
  ensureLinearSession,
  getLinearSessionGeneration,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  OutboxDispatcher,
  recordLinearInstallation,
  requireLinearTaskDelegation,
  revokeLinearInstallation,
} from "../src/db";
import {
  createFakeLinearAccessReads,
  createFakeLinearIssueLifecycle,
  createFakeTracker,
  createLinearClient,
  createLinearTracker,
} from "../src/linear";
import { attachOrchestrator, LinearTaskAccess } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

function fixture() {
  const db = tempDb();
  const item = insertQueuedItem(db);
  const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
  ensureLinearSession(db, { sessionId: "session", issueId: item.linearIssueId });
  bindLinearSessionTask(db, "session", item.delegationId, { actorId: "human" });
  recordLinearInstallation(db, {
    ...scope,
    sessionId: "session",
    teamId: "team",
    observedAtMs: 1,
  });
  const access = createFakeLinearAccessReads({
    installation: scope,
    sessions: [{ ...scope, sessionId: "session", issueId: item.linearIssueId, teamId: "team" }],
    teams: ["team"],
  });
  const lifecycle = createFakeLinearIssueLifecycle({
    id: item.linearIssueId,
    teamId: "team",
    assigneeId: "human",
    delegateId: "app",
    stateType: "completed",
  });
  requireLinearTaskDelegation(db, {
    itemId: item.id,
    issueId: item.linearIssueId,
    teamId: "team",
    appUserId: "app",
    humanActorId: "human",
  });
  const tracker = createFakeTracker([]);
  const outbox = new OutboxDispatcher(db, systemClock);
  const gate = new LinearTaskAccess(db, {
    access: access.adapter,
    lifecycle,
    oauthClientId: "client",
    appUserId: "app",
    stopSession: () => {},
  });
  const orchestrator = attachOrchestrator({
    db,
    jobs: new JobLoop(db, systemClock),
    outbox,
    tracker,
    pawsRoot: join(tempHome(), "paws"),
    linearTaskModes: true,
    linearAccess: gate,
  });
  const enqueue = (op: "activity" | "status", stop = false) =>
    enqueueOutboxOnce(db, {
      target: "linear",
      op,
      orderingKey: "session",
      delivery: stop ? "stop" : "terminal",
      idempotencyKey: "delivery",
      generation: getLinearSessionGeneration(db, "session"),
      payload: {
        sessionId: "session",
        itemId: item.id,
        linearIssueId: item.linearIssueId,
        stateType: "completed",
        kind: "response",
        body: "Confirmed result.",
      },
    });
  return { db, item, scope, access, lifecycle, tracker, outbox, enqueue, orchestrator };
}

test.each(["workflow states", "credential acquisition"])(
  "Stop while awaiting %s prevents the actual Linear mutation before any dispatcher tick",
  async (boundary) => {
    const f = fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const queries: string[] = [];
    f.orchestrator.setTracker(
      createLinearTracker(
        createLinearClient({
          auth: {
            hasToken: () => true,
            async ensureFresh() {
              if (boundary === "credential acquisition") {
                started.resolve();
                await release.promise;
              }
              return "synthetic-token";
            },
            forceRefresh: async () => "synthetic-token",
          },
          async fetch(_url, request) {
            const { query } = JSON.parse(String(request?.body)) as { query: string };
            queries.push(query);
            if (query.includes("IssueStates")) {
              started.resolve();
              await release.promise;
              return Response.json({
                data: {
                  issue: {
                    team: { states: { nodes: [{ id: "done", name: "Done", type: "completed" }] } },
                  },
                },
              });
            }
            return Response.json({ data: { issueUpdate: { success: true } } });
          },
        }),
      ),
    );
    try {
      f.enqueue("status");
      f.outbox.tick();
      await started.promise;
      advanceLinearSessionGeneration(f.db, "session", { stop: true, now: 10 });
      release.resolve();
      await f.outbox.idle();
      expect(queries.some((query) => query.includes("mutation"))).toBe(false);
      expect(queries).toHaveLength(boundary === "workflow states" ? 1 : 0);
      expect(f.db.query<{ status: string }, []>("SELECT status FROM outbox").get()?.status).toBe(
        "dropped",
      );
    } finally {
      release.resolve();
      f.db.close();
    }
  },
);

test("a queued final response verifies live access and survives the task's own completed issue", async () => {
  const f = fixture();
  try {
    for (const event of [
      "dispatched",
      "turn_ended",
      "closeout_accepted",
      "merge_accepted",
    ] as const)
      applyWorkItemEvent(f.db, f.item.id, event);
    f.enqueue("activity");
    f.outbox.tick();
    await f.outbox.idle();
    expect(f.tracker.progress.map((update) => update.body)).toEqual(["Confirmed result."]);
    expect(f.access.calls.map((call) => call.method)).toEqual(["session", "team"]);
    expect(getWorkItem(f.db, f.item.id)?.state).toBe("merged");
    expect(f.lifecycle.started).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("access removed during a fresh publication read prevents the queued mutation", async () => {
  const f = fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = f.access.adapter.session;
  f.access.adapter.session = async (id, options) => {
    started.resolve();
    await release.promise;
    return original(id, options);
  };
  try {
    f.enqueue("status");
    f.outbox.tick();
    await started.promise;
    revokeLinearInstallation(f.db, {
      ...f.scope,
      eventKey: "removed",
      createdAtMs: 10,
    });
    advanceLinearSessionGeneration(f.db, "session", { stop: true, now: 10 });
    release.resolve();
    await f.outbox.idle();
    expect(f.tracker.statuses).toEqual([]);
    expect(f.tracker.progress).toEqual([]);
    expect(f.access.calls.map((call) => call.method)).toEqual(["session"]);
    expect(f.lifecycle.started).toEqual([]);
  } finally {
    release.resolve();
    f.db.close();
  }
});

test("a stopped task can acknowledge removal of delegation while installation access remains valid", async () => {
  const f = fixture();
  try {
    applyWorkItemEvent(f.db, f.item.id, "cancel");
    advanceLinearSessionGeneration(f.db, "session", { stop: true, now: 10 });
    f.lifecycle.issue.delegateId = "different-app";
    f.enqueue("activity", true);
    f.outbox.tick();
    await f.outbox.idle();
    expect(f.tracker.progress.map((update) => update.body)).toEqual(["Confirmed result."]);
    expect(getWorkItem(f.db, f.item.id)?.state).toBe("cancelled");
    expect(f.access.calls).toEqual([]);
    expect(f.lifecycle.started).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("fresh delegation removal prevents a final response without workflow mutation", async () => {
  const f = fixture();
  try {
    f.enqueue("activity");
    f.lifecycle.issue.delegateId = null;
    f.outbox.tick();
    await f.outbox.idle();
    expect(f.tracker.progress).toEqual([]);
    expect(f.tracker.statuses).toEqual([]);
    expect(f.lifecycle.started).toEqual([]);
    expect(f.db.query<{ status: string }, []>("SELECT status FROM outbox").get()?.status).toBe(
      "pending",
    );
  } finally {
    f.db.close();
  }
});
