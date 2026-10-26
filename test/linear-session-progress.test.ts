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
} from "../src/loop";
import { tempDb } from "./helpers";

async function flush(dispatcher: OutboxDispatcher) {
  while (dispatcher.tick().length > 0) await dispatcher.idle();
}

test("ACP plans preserve status and append host verification and publication steps", async () => {
  const db = tempDb();
  const clock = new FakeClock(1);
  const progress = createLinearSessionProgress(db, "session", "ENG-1", () => clock.now());
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
  const dispatcher = new OutboxDispatcher(db, clock);
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
  const recovered = createLinearSessionProgress(db, "session", "ENG-1", () => clock.now());
  recovered.phase("verifying");
  clock.advance(120_000);
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
  expect(rows).toHaveLength(1);
  expect(rows[0]?.status).toBe("pending");
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

test("ten plan updates in ten seconds send one request carrying the last plan", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const progress = createLinearSessionProgress(db, "session", "ENG-1", () => clock.now());
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  progress.phase("implementing");
  await flush(dispatcher);
  expect(tracker.sessionUpdates.filter((update) => update.plan)).toHaveLength(1);
  for (let step = 1; step <= 10; step++) {
    clock.advance(1_000);
    progress.plan([{ content: `Step ${step}`, status: "inProgress" }]);
    await flush(dispatcher);
  }
  expect(listOutbox(db, "session").filter((row) => row.status === "pending")).toHaveLength(1);
  expect(tracker.sessionUpdates.filter((update) => update.plan)).toHaveLength(1);
  clock.advance(109_999);
  await flush(dispatcher);
  expect(tracker.sessionUpdates.filter((update) => update.plan)).toHaveLength(1);
  clock.advance(1);
  await flush(dispatcher);
  const plans = tracker.sessionUpdates.filter((update) => update.plan);
  expect(plans).toHaveLength(2);
  expect(plans[1]?.plan?.[0]).toEqual({ content: "Step 10", status: "inProgress" });
  db.close();
});

test("a session flapping between phases sends one plan and summary every two minutes", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const progress = createLinearSessionProgress(db, "session", "ENG-1", () => clock.now());
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  const phases = ["verifying", "publishing", "merging"] as const;
  for (let tick = 0; tick < 40; tick++) {
    progress.phase(phases[tick % phases.length]!);
    await flush(dispatcher);
    clock.advance(30_000);
  }
  await flush(dispatcher);
  expect(tracker.sessionUpdates).toHaveLength(10);
  expect(tracker.sessionUpdates.every((update) => update.summary)).toBe(true);
  const plans = tracker.sessionUpdates.flatMap((update) => (update.plan ? [update.plan] : []));
  expect(
    plans.every(
      (plan, index) =>
        index === 0 ||
        plans[index - 1]!.every(
          (step, i) => step.status !== "completed" || plan[i]?.status === "completed",
        ),
    ),
  ).toBe(true);
  db.close();
});

test("a summary equal to the last one sent is not sent again", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const progress = createLinearSessionProgress(db, "session", "ENG-1", () => clock.now());
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  progress.phase("merging");
  await flush(dispatcher);
  clock.advance(1_000);
  progress.phase("publishing");
  progress.phase("merging");
  clock.advance(120_000);
  await flush(dispatcher);
  progress.phase("merging");
  clock.advance(120_000);
  await flush(dispatcher);
  expect(tracker.sessionUpdates.filter((update) => update.summary)).toHaveLength(1);
  expect(tracker.sessionUpdates.filter((update) => update.plan)).toHaveLength(1);
  db.close();
});

test("a summary waiting on the interval takes the newest text in place", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const progress = createLinearSessionProgress(db, "session", "ENG-1", () => clock.now());
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  progress.phase("implementing");
  await flush(dispatcher);
  progress.phase("verifying");
  progress.phase("fixing");
  progress.phase("verifying");
  progress.phase("publishing");
  const summaries = () =>
    listOutbox(db, "session").filter((row) => row.op === "linear.session.summary");
  expect(summaries()).toHaveLength(2);
  expect(summaries()[1]?.payload).toMatchObject({ summary: "ENG-1: publishing" });
  clock.advance(120_000);
  await flush(dispatcher);
  expect(tracker.sessionUpdates.filter((update) => update.summary).map((u) => u.summary)).toEqual([
    "ENG-1: implementing",
    "ENG-1: publishing",
  ]);
  db.close();
});

test("the final plan and summary go out right away and links are not held behind them", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const progress = createLinearSessionProgress(db, "session", "ENG-1", () => clock.now());
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  progress.phase("implementing");
  await flush(dispatcher);
  clock.advance(1_000);
  progress.phase("merging");
  progress.link("Pull request", "https://github.com/pmdroid/paws-app/pull/1");
  await flush(dispatcher);
  expect(tracker.sessionUpdates).toHaveLength(2);
  expect(tracker.sessionUpdates.at(-1)?.addedExternalUrls).toHaveLength(1);
  expect(tracker.sessionUpdates.at(-1)?.summary).toBe("ENG-1: merging");
  clock.advance(1_000);
  progress.phase("completed");
  await flush(dispatcher);
  const plan = tracker.sessionUpdates.findLast((update) => update.plan)?.plan;
  expect(plan?.every((step) => step.status === "completed")).toBe(true);
  expect(tracker.sessionUpdates.findLast((update) => update.summary)?.summary).toBe(
    "ENG-1: completed",
  );
  expect(listOutbox(db, "session").every((row) => row.status === "sent")).toBe(true);
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

test("PR links use incremental session updates through the GraphQL adapter", async () => {
  const db = tempDb();
  const sent: unknown[] = [];
  const linear = createLinearTracker({
    async query(_query, variables) {
      sent.push(variables);
      return { agentSessionUpdate: { success: true, agentSession: { id: "session" } } };
    },
  });
  const tracker = linear;
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

test("a new delegation child starts its own plan without requiring an ACP plan event", () => {
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
    plan: [],
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

function markPr(db: ReturnType<typeof tempDb>) {
  enqueueOutbox(db, {
    target: "linear",
    op: "activity",
    orderingKey: "session",
    delivery: "ordered",
    idempotencyKey: "pull-request-ready:item:0",
    payload: { sessionId: "session", kind: "response", body: "Opened PR #1" },
  });
}

test("post-PR reconstruction refuses backwards phases and appends rebase verification", () => {
  const db = tempDb();
  try {
    const progress = createLinearSessionProgress(db, "session", "ENG-1");
    progress.phase("merging");
    markPr(db);
    const recovered = createLinearSessionProgress(db, "session", "ENG-1");
    recovered.phase("implementing");
    recovered.phase("fixing");
    expect(
      listOutbox(db).findLast((row) => row.op === "linear.session.summary")?.payload,
    ).toMatchObject({ summary: "ENG-1: merging" });
    recovered.phase("verifying");
    const plan = listOutbox(db).findLast((row) => row.op === "linear.session.plan")
      ?.payload as SessionUpdate;
    expect(plan.plan).toEqual([
      { content: "Verify changes", status: "completed" },
      { content: "Open pull request", status: "completed" },
      { content: "Merge verified changes", status: "inProgress" },
      { content: "Re-verify after rebase", status: "inProgress" },
    ]);
    expect(
      listOutbox(db).findLast((row) => row.op === "linear.session.summary")?.payload,
    ).toMatchObject({ summary: "ENG-1: rebased onto main, re-verifying" });
    recovered.status("ENG-1: second in queue behind ENG-2");
    createLinearSessionProgress(db, "session", "ENG-1").phase("implementing");
    expect(
      listOutbox(db).findLast((row) => row.op === "linear.session.summary")?.payload,
    ).toMatchObject({ summary: "ENG-1: second in queue behind ENG-2" });
  } finally {
    db.close();
  }
});

test.each([
  ["findings", "Fix Closeout findings (2 of 3)"],
  ["ci", "Fix CI"],
  ["review", "Fix review findings"],
  ["conflict", "Resolve merge conflict"],
])("%s restarts append one durable reason-named step", (reason, content) => {
  const db = tempDb();
  try {
    createLinearSessionProgress(db, "session", "ENG-1").phase("merging");
    markPr(db);
    createLinearSessionProgress(db, "session", "ENG-1").restart(reason!, 2, 10);
    createLinearSessionProgress(db, "session", "ENG-1").restart(reason!, 2, 10);
    const plan = listOutbox(db).findLast((row) => row.op === "linear.session.plan")
      ?.payload as SessionUpdate;
    expect(plan.plan?.filter((step) => step.content === content)).toEqual([
      { content, status: "inProgress" },
    ]);
    expect(plan.plan?.[0]?.status).toBe("completed");
    expect(plan.plan?.[1]?.status).toBe("completed");
  } finally {
    db.close();
  }
});

test("a captured plan callback preserves milestones completed by a newer reporter", () => {
  const db = tempDb();
  try {
    const captured = createLinearSessionProgress(db, "session", "ENG-1");
    captured.phase("implementing");
    createLinearSessionProgress(db, "session", "ENG-1").phase("merging");
    markPr(db);
    captured.plan([{ content: "Repair CI", status: "inProgress" }]);
    const plan = listOutbox(db).findLast((row) => row.op === "linear.session.plan")
      ?.payload as SessionUpdate;
    expect(plan.plan?.find((step) => step.content === "Verify changes")?.status).toBe("completed");
    expect(plan.plan?.find((step) => step.content === "Open pull request")?.status).toBe(
      "completed",
    );
    createLinearSessionProgress(db, "session", "ENG-1").restart("ci", 1, 10);
    captured.plan([{ content: "Repair CI", status: "completed" }]);
    createLinearSessionProgress(db, "session", "ENG-1").restart("ci", 1, 10);
    const current = listOutbox(db).findLast((row) => row.op === "linear.session.plan")
      ?.payload as SessionUpdate;
    expect(current.plan?.filter((step) => step.content === "Fix CI")).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("successive restart rounds preserve their newest identity across captured callbacks", () => {
  const db = tempDb();
  try {
    const captured = createLinearSessionProgress(db, "session", "ENG-1");
    captured.phase("merging");
    markPr(db);
    createLinearSessionProgress(db, "session", "ENG-1").restart("ci", 1, 10);
    createLinearSessionProgress(db, "session", "ENG-1").restart("ci", 2, 20);
    captured.plan([]);
    createLinearSessionProgress(db, "session", "ENG-1").restart("ci", 2, 20);
    const plan = listOutbox(db).findLast((row) => row.op === "linear.session.plan")
      ?.payload as SessionUpdate;
    expect(plan.plan?.filter((step) => step.content === "Fix CI")).toEqual([
      { content: "Fix CI", status: "completed" },
      { content: "Fix CI", status: "inProgress" },
    ]);
  } finally {
    db.close();
  }
});
