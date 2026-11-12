import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { parsePullRequest } from "../src/acp";
import { systemClock } from "../src/core";
import {
  advanceLinearSessionGeneration,
  applyWorkItemEvent,
  beginImplementRun,
  bindLinearSessionTask,
  completeMergedItem,
  enterMergeQueue,
  enqueueOutboxOnce,
  ensureLinearSession,
  getLinearSessionGeneration,
  getWorkItem,
  insertQueuedItem,
  JobLoop,
  listOutbox,
  OutboxDispatcher,
  recordConfirmedRemoteMerge,
  recordLinearInstallation,
  requireLinearTaskDelegation,
  revokeLinearInstallation,
  savePullRequestDraft,
  syncSteps,
  type Db,
} from "../src/db";
import {
  createFakeLinearAccessReads,
  createFakeLinearIssueLifecycle,
  createFakeTracker,
  createLinearClient,
  createLinearTracker,
} from "../src/linear";
import { attachOrchestrator, LinearTaskAccess } from "../src/loop";
import { tempHome } from "./helpers";
import { tempStore } from "./pglite";

async function fixture() {
  const { db, close } = await tempStore();
  const item = await insertQueuedItem(db);
  const scope = { organizationId: "org", oauthClientId: "client", appUserId: "app" };
  await ensureLinearSession(db, { sessionId: "session", issueId: item.linearIssueId });
  await bindLinearSessionTask(db, "session", item.delegationId, { actorId: "human" });
  await recordLinearInstallation(db, {
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
  await requireLinearTaskDelegation(db, {
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
    stopSession: () => syncSteps(() => {}),
  });
  const orchestrator = attachOrchestrator({
    store: db,
    jobs: new JobLoop(db, systemClock),
    outbox,
    tracker,
    pawsRoot: join(tempHome(), "paws"),
    linearTaskModes: true,
    linearAccess: gate,
  });
  const enqueue = async (op: "activity" | "status", stop = false) =>
    await enqueueOutboxOnce(db, {
      target: "linear",
      op,
      orderingKey: "session",
      delivery: stop ? "stop" : "terminal",
      idempotencyKey: "delivery",
      generation: await getLinearSessionGeneration(db, "session"),
      payload: {
        sessionId: "session",
        itemId: item.id,
        linearIssueId: item.linearIssueId,
        stateType: "completed",
        kind: "response",
        body: "Confirmed result.",
      },
    });
  return { db, close, item, scope, access, lifecycle, tracker, outbox, enqueue, orchestrator };
}

async function outboxStatuses(db: Db): Promise<string[]> {
  const rows = await db.run((q) =>
    q.all(q.orm.select({ status: q.t.outbox.status }).from(q.t.outbox)),
  );
  return rows.map((row) => row.status);
}

test.each(["workflow states", "credential acquisition"])(
  "Stop while awaiting %s prevents the actual Linear mutation before any dispatcher tick",
  async (boundary) => {
    const f = await fixture();
    const started = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const queries: string[] = [];
    f.orchestrator.setTracker(
      createLinearTracker(
        createLinearClient({
          auth: {
            hasToken: async () => true,
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
      await f.enqueue("status");
      await f.outbox.tick();
      await started.promise;
      await advanceLinearSessionGeneration(f.db, "session", { stop: true, now: 10 });
      release.resolve();
      await f.outbox.idle();
      expect(queries.some((query) => query.includes("mutation"))).toBe(false);
      expect(queries).toHaveLength(boundary === "workflow states" ? 1 : 0);
      expect(await outboxStatuses(f.db)).toEqual(["dropped"]);
    } finally {
      release.resolve();
      await f.close();
    }
  },
);

test("a queued final response verifies live access and survives the task's own completed issue", async () => {
  const f = await fixture();
  try {
    for (const event of [
      "dispatched",
      "turn_ended",
      "closeout_accepted",
      "merge_accepted",
    ] as const)
      await applyWorkItemEvent(f.db, f.item.id, event);
    await f.enqueue("activity");
    await f.outbox.tick();
    await f.outbox.idle();
    expect(f.tracker.progress.map((update) => update.body)).toEqual(["Confirmed result."]);
    expect(f.access.calls.map((call) => call.method)).toEqual(["session", "team"]);
    expect((await getWorkItem(f.db, f.item.id))?.state).toBe("merged");
    expect(f.lifecycle.started).toEqual([]);
  } finally {
    await f.close();
  }
});

test("access removed during a fresh publication read prevents the queued mutation", async () => {
  const f = await fixture();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = f.access.adapter.session;
  f.access.adapter.session = async (id, options) => {
    started.resolve();
    await release.promise;
    return original(id, options);
  };
  try {
    await f.enqueue("status");
    await f.outbox.tick();
    await started.promise;
    await revokeLinearInstallation(f.db, {
      ...f.scope,
      eventKey: "removed",
      createdAtMs: 10,
    });
    await advanceLinearSessionGeneration(f.db, "session", { stop: true, now: 10 });
    release.resolve();
    await f.outbox.idle();
    expect(f.tracker.statuses).toEqual([]);
    expect(f.tracker.progress).toEqual([]);
    expect(f.access.calls.map((call) => call.method)).toEqual(["session"]);
    expect(f.lifecycle.started).toEqual([]);
  } finally {
    release.resolve();
    await f.close();
  }
});

test("a stopped task can acknowledge removal of delegation while installation access remains valid", async () => {
  const f = await fixture();
  try {
    await applyWorkItemEvent(f.db, f.item.id, "cancel");
    await advanceLinearSessionGeneration(f.db, "session", { stop: true, now: 10 });
    f.lifecycle.issue.delegateId = "different-app";
    await f.enqueue("activity", true);
    await f.outbox.tick();
    await f.outbox.idle();
    expect(f.tracker.progress.map((update) => update.body)).toEqual(["Confirmed result."]);
    expect((await getWorkItem(f.db, f.item.id))?.state).toBe("cancelled");
    expect(f.access.calls).toEqual([]);
    expect(f.lifecycle.started).toEqual([]);
  } finally {
    await f.close();
  }
});

test("fresh delegation removal prevents a final response without workflow mutation", async () => {
  const f = await fixture();
  try {
    await f.enqueue("activity");
    f.lifecycle.issue.delegateId = null;
    await f.outbox.tick();
    await f.outbox.idle();
    expect(f.tracker.progress).toEqual([]);
    expect(f.tracker.statuses).toEqual([]);
    expect(f.lifecycle.started).toEqual([]);
    expect(await outboxStatuses(f.db)).toEqual(["pending"]);
  } finally {
    await f.close();
  }
});

async function mergeWithRemaining(f: Awaited<ReturnType<typeof fixture>>) {
  await beginImplementRun(f.db, f.item.id, 1);
  await enterMergeQueue(f.db, f.item.id, { phase: "merge_queue" });
  const part = (n: number) => ({ title: `Part ${n}`, scope: `\`src/part-${n}.ts\`` });
  await savePullRequestDraft(
    f.db,
    f.item.id,
    parsePullRequest({ title: "Part 1", body: "Body", remaining: [part(2), part(3)] }),
    2,
  );
  await recordConfirmedRemoteMerge(f.db, {
    itemId: f.item.id,
    repositoryOwner: "acme",
    repositoryName: "app",
    pullNumber: 7,
    pullUrl: "https://github.com/acme/app/pull/7",
    mergeSha: "abc",
    confirmedAt: 3,
  });
  expect((await completeMergedItem(f.db, { itemId: f.item.id, now: 4 }))?.state).toBe("merged");
}

async function keyRemainingByIssue(f: Awaited<ReturnType<typeof fixture>>) {
  await f.db.run((q) =>
    q.exec(
      q.orm
        .update(q.t.outbox)
        .set({ orderingKey: f.item.linearIssueId })
        .where(eq(q.t.outbox.op, "linear.remaining_issues")),
    ),
  );
}

async function remainingRows(db: Db) {
  return await db.run((q) =>
    q.all(
      q.orm
        .select({ id: q.t.outbox.id, op: q.t.outbox.op, orderingKey: q.t.outbox.orderingKey })
        .from(q.t.outbox),
    ),
  );
}

test("a merge with two remaining parts files both sub-issues after the Merged activity", async () => {
  const f = await fixture();
  const postedBeforeFiling: string[] = [];
  const createSubIssues = f.tracker.createSubIssues.bind(f.tracker);
  f.tracker.createSubIssues = async (request, options) => {
    postedBeforeFiling.push(...f.tracker.progress.map((update) => update.body));
    return await createSubIssues(request, options);
  };
  try {
    await mergeWithRemaining(f);
    expect((await remainingRows(f.db)).map((row) => [row.op, row.orderingKey])).toEqual([
      ["activity", "session"],
      ["linear.remaining_issues", "session"],
    ]);
    await f.outbox.tick();
    await f.outbox.idle();
    await f.outbox.tick();
    await f.outbox.idle();
    expect(postedBeforeFiling).toHaveLength(1);
    expect(postedBeforeFiling[0]).toStartWith("Merged #7");
    expect((f.tracker.subIssues.get(f.item.linearIssueId) ?? []).length).toBe(2);
    expect(await outboxStatuses(f.db)).toEqual(["sent", "sent"]);
  } finally {
    await f.close();
  }
});

test("a remaining-issues row keyed by the issue id resolves its session from the item", async () => {
  const f = await fixture();
  try {
    await mergeWithRemaining(f);
    await keyRemainingByIssue(f);
    await f.outbox.tick();
    await f.outbox.idle();
    await f.outbox.tick();
    await f.outbox.idle();
    expect((f.tracker.subIssues.get(f.item.linearIssueId) ?? []).length).toBe(2);
  } finally {
    await f.close();
  }
});

test("remaining issues are not filed once a person stopped Paws and removed its access", async () => {
  const f = await fixture();
  try {
    await mergeWithRemaining(f);
    await keyRemainingByIssue(f);
    await revokeLinearInstallation(f.db, { ...f.scope, eventKey: "removed", createdAtMs: 10 });
    await advanceLinearSessionGeneration(f.db, "session", { stop: true, now: 10 });
    await f.outbox.tick();
    await f.outbox.idle();
    const row = (await listOutbox(f.db)).find((r) => r.op === "linear.remaining_issues")!;
    expect(row.status).not.toBe("sent");
    expect(row.error).toBe("Linear delivery access was stopped or superseded.");
    expect(f.tracker.subIssueRequests).toEqual([]);
  } finally {
    await f.close();
  }
});
