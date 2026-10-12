import { expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import {
  advanceOutboxSession,
  enqueueOutbox,
  getOutbox,
  listOutbox,
  OutboxDispatcher,
  stopOutboxSession,
} from "../src/db";
import {
  createFakeTracker,
  createLinearClient,
  createLinearTracker,
  type SessionUpdate,
} from "../src/linear";
import {
  createAcpActivityReporter,
  createLinearSessionProgress,
  deliverLinearOutbox,
  routeBySource,
} from "../src/loop";
import { tempDb } from "./helpers";

async function flush(dispatcher: OutboxDispatcher) {
  while (dispatcher.tick().length > 0) await dispatcher.idle();
}

test("ACP plans preserve status and append host verification and publication steps", async () => {
  const db = tempDb();
  const progress = createLinearSessionProgress(db, "session", "ENG-1");
  const reporter = createAcpActivityReporter(() => {}, progress.plan);
  reporter.onEvent({
    type: "session_update",
    sessionId: "acp",
    update: {
      sessionUpdate: "plan",
      entries: [
        { content: "Read export code", status: "completed", priority: "medium" },
        { content: "Implement CSV", status: "in_progress", priority: "high" },
        { content: "Add coverage", status: "pending", priority: "medium" },
      ],
    },
  });
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, new FakeClock(1));
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  await flush(dispatcher);
  expect(tracker.sessionUpdates[0]?.plan).toEqual([
    { content: "Read export code", status: "completed" },
    { content: "Implement CSV", status: "inProgress" },
    { content: "Add coverage", status: "pending" },
    { content: "Verify changes", status: "pending" },
    { content: "Open pull request", status: "pending" },
    { content: "Merge verified changes", status: "pending" },
  ]);
  const recovered = createLinearSessionProgress(db, "session", "ENG-1");
  recovered.phase("verifying");
  await flush(dispatcher);
  expect(tracker.sessionUpdates.findLast((update) => update.plan)?.plan?.[3]).toEqual({
    content: "Verify changes",
    status: "inProgress",
  });
  recovered.phase("completed");
  await flush(dispatcher);
  expect(
    tracker.sessionUpdates
      .findLast((update) => update.plan)
      ?.plan?.every((step) => step.status === "completed"),
  ).toBe(true);
  db.close();
});

test("plan replacements retain only the newest durable version across delivery retries", async () => {
  const db = tempDb();
  const progress = createLinearSessionProgress(db, "session", "ENG-1");
  progress.plan([{ content: "Old", status: "pending" }]);
  progress.plan([{ content: "Current", status: "inProgress" }]);
  const rows = listOutbox(db, "session");
  expect(rows[0]?.status).toBe("dropped");
  expect(rows[1]?.status).toBe("pending");
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, new FakeClock(1));
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  await flush(dispatcher);
  expect(tracker.sessionUpdates).toHaveLength(1);
  expect(tracker.sessionUpdates[0]?.plan?.[0]?.content).toBe("Current");
  db.close();
});

test.each(["elicitation", "activity"])(
  "a failed optional update leaves %s deliverable",
  async (op) => {
    const db = tempDb();
    createLinearSessionProgress(db, "session", "ENG-1").phase("verifying");
    const clock = new FakeClock(1);
    const dispatcher = new OutboxDispatcher(db, clock);
    dispatcher.setHandler((row) => {
      if (row.op.startsWith("linear.session.")) throw new Error("metadata unavailable");
    });
    await flush(dispatcher);
    const critical = enqueueOutbox(db, {
      target: "linear",
      op,
      orderingKey: "session",
      idempotencyKey: "critical",
      payload:
        op === "activity"
          ? { kind: "response", body: "Done" }
          : { sessionId: "session", body: "Which?" },
    });
    await flush(dispatcher);
    expect(getOutbox(db, critical)?.status).toBe("sent");
    db.close();
  },
);

test("Stop and newer turns fence captured metadata callbacks", async () => {
  const db = tempDb();
  const old = createLinearSessionProgress(db, "session", "ENG-1");
  old.phase("implementing");
  stopOutboxSession(db, "linear", "session");
  old.plan([{ content: "After Stop", status: "completed" }]);
  expect(listOutbox(db).every((row) => row.status === "dropped")).toBe(true);
  advanceOutboxSession(db, "linear", "session");
  const fresh = createLinearSessionProgress(db, "session", "ENG-1");
  fresh.plan([{ content: "New turn", status: "inProgress" }]);
  old.phase("completed");
  const dispatcher = new OutboxDispatcher(db, new FakeClock(1));
  const tracker = createFakeTracker();
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  await flush(dispatcher);
  expect(tracker.sessionUpdates).toHaveLength(1);
  expect(tracker.sessionUpdates[0]?.plan?.[0]?.content).toBe("New turn");
  db.close();
});

test("PR links use incremental session updates through the routed GraphQL adapter", async () => {
  const db = tempDb();
  const sent: unknown[] = [];
  const linear = createLinearTracker({
    async query(_query, variables) {
      sent.push(variables);
      return { agentSessionUpdate: { success: true, agentSession: { id: "session" } } };
    },
  });
  const tracker = routeBySource({ linear, github: createFakeTracker() });
  const progress = createLinearSessionProgress(db, "session", "ENG-1");
  progress.link("Pull request", "https://github.com/pmdroid/paws-app/pull/1");
  const dispatcher = new OutboxDispatcher(db, new FakeClock(1));
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  await flush(dispatcher);
  expect(sent).toEqual([
    {
      id: "session",
      input: {
        addedExternalUrls: [
          { label: "Pull request", url: "https://github.com/pmdroid/paws-app/pull/1" },
        ],
      },
    },
  ]);
  expect(listOutbox(db).every((row) => !(row.payload as SessionUpdate).externalUrls)).toBe(true);
  db.close();
});

test("a new epic child starts its own plan without requiring an ACP plan event", () => {
  const db = tempDb();
  const first = createLinearSessionProgress(db, "session", "ENG-1");
  first.plan([{ content: "Build first child", status: "completed" }]);
  first.phase("completed");
  const second = createLinearSessionProgress(db, "session", "ENG-2");
  second.phase("implementing");
  const row = listOutbox(db, "session").findLast(
    (candidate) => candidate.op === "linear.session.plan",
  );
  expect(row?.payload).toMatchObject({
    identifier: "ENG-2",
    plan: [
      { content: "Implement ENG-2", status: "inProgress" },
      { content: "Verify changes", status: "pending" },
      { content: "Open pull request", status: "pending" },
      { content: "Merge verified changes", status: "pending" },
    ],
  });
  db.close();
});

test("response plans recover their ACP steps without code milestones and reset for a changed mode", () => {
  const db = tempDb();
  const answer = createLinearSessionProgress(db, "session", "ENG-1", Date.now, "answer");
  answer.plan([{ content: "Explain the API", status: "inProgress" }]);
  const recovered = createLinearSessionProgress(db, "session", "ENG-1", Date.now, "answer");
  recovered.phase("working");
  expect(
    listOutbox(db, "session").findLast((row) => row.op === "linear.session.plan")?.payload,
  ).toMatchObject({
    mode: "answer",
    plan: [{ content: "Explain the API", status: "inProgress" }],
  });
  const artifact = createLinearSessionProgress(db, "session", "ENG-1", Date.now, "artifact");
  artifact.phase("working");
  expect(
    listOutbox(db, "session").findLast((row) => row.op === "linear.session.plan")?.payload,
  ).toMatchObject({
    mode: "artifact",
    plan: [{ content: "Create files for ENG-1", status: "inProgress" }],
  });
  expect(
    listOutbox(db, "session").findLast((row) => row.op === "linear.session.summary")?.payload,
  ).toMatchObject({ summary: "ENG-1: creating files" });
  db.close();
});

test("a generation change during actual session-update authentication prevents transport without another tick", async () => {
  const db = tempDb();
  const started = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const queries: string[] = [];
  try {
    const tracker = createLinearTracker(
      createLinearClient({
        auth: {
          hasToken: () => true,
          async ensureFresh() {
            started.resolve();
            await release.promise;
            return "fixture-token";
          },
          forceRefresh: async () => "fixture-token",
        },
        async fetch(_url, request) {
          queries.push(String(request?.body));
          throw new Error("Superseded session update reached transport");
        },
      }),
    );
    createLinearSessionProgress(db, "session", "ENG-1").phase("verifying");
    const outbox = new OutboxDispatcher(db, new FakeClock(1000));
    outbox.setHandler((row, context) =>
      deliverLinearOutbox(row, tracker, async () => {}, context, db),
    );
    outbox.tick();
    await started.promise;
    advanceOutboxSession(db, "linear", "session");
    release.resolve();
    await outbox.idle();
    expect(queries).toEqual([]);
    expect(listOutbox(db).every((row) => row.status === "dropped")).toBe(true);
  } finally {
    release.resolve();
    db.close();
  }
});

test.each(["code", "answer", "artifact"] as const)(
  "%s plan advancement preserves canceled steps across reporter reconstruction",
  async (mode) => {
    const db = tempDb();
    try {
      createLinearSessionProgress(db, "session", "ENG-1", Date.now, mode).plan([
        { content: "Discarded approach", status: "canceled" },
        { content: "Chosen approach", status: "pending" },
      ]);
      const recovered = createLinearSessionProgress(db, "session", "ENG-1", Date.now, mode);
      recovered.phase(mode === "code" ? "verifying" : "completed");
      const tracker = createFakeTracker();
      const dispatcher = new OutboxDispatcher(db, new FakeClock(1));
      dispatcher.setHandler((row, context) =>
        deliverLinearOutbox(row, tracker, async () => {}, context),
      );
      await flush(dispatcher);
      expect(tracker.sessionUpdates.findLast((update) => update.plan)?.plan?.slice(0, 2)).toEqual([
        { content: "Discarded approach", status: "canceled" },
        { content: "Chosen approach", status: "completed" },
      ]);
    } finally {
      db.close();
    }
  },
);
