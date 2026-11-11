import { expect, test } from "bun:test";
import { FakeClock } from "../src/core";
import {
  advanceOutboxSession,
  enqueueOutbox,
  getOutboxSteps,
  listOutbox,
  OutboxDispatcher,
  stopOutboxSession,
  sqliteDb,
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
  while ((await dispatcher.tick()).length > 0) await dispatcher.idle();
}

test("ACP plans preserve status and append host verification and publication steps", async () => {
  const db = tempDb();
  const clock = new FakeClock(1);
  const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () =>
    clock.now(),
  );
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
  const recovered = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () =>
    clock.now(),
  );
  await recovered.phase("verifying");
  clock.advance(120_000);
  await flush(dispatcher);
  expect(tracker.sessionUpdates.findLast((update) => update.plan)?.plan?.[3]).toEqual({
    content: "Verify changes",
    status: "inProgress",
  });
  await recovered.phase("completed");
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
  const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
  await progress.plan([{ content: "Old", status: "pending" }]);
  await progress.plan([{ content: "Current", status: "inProgress" }]);
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
  const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () =>
    clock.now(),
  );
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  await progress.phase("implementing");
  await flush(dispatcher);
  expect(tracker.sessionUpdates.filter((update) => update.plan)).toHaveLength(1);
  for (let step = 1; step <= 10; step++) {
    clock.advance(1_000);
    await progress.plan([{ content: `Step ${step}`, status: "inProgress" }]);
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
  const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () =>
    clock.now(),
  );
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  const phases = ["verifying", "publishing", "merging"] as const;
  for (let tick = 0; tick < 40; tick++) {
    await progress.phase(phases[tick % phases.length]!);
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
  const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () =>
    clock.now(),
  );
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  await progress.phase("merging");
  await flush(dispatcher);
  clock.advance(1_000);
  await progress.phase("publishing");
  await progress.phase("merging");
  clock.advance(120_000);
  await flush(dispatcher);
  await progress.phase("merging");
  clock.advance(120_000);
  await flush(dispatcher);
  expect(tracker.sessionUpdates.filter((update) => update.summary)).toHaveLength(1);
  expect(tracker.sessionUpdates.filter((update) => update.plan)).toHaveLength(1);
  db.close();
});

test("a summary waiting on the interval takes the newest text in place", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () =>
    clock.now(),
  );
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  await progress.phase("implementing");
  await flush(dispatcher);
  await progress.phase("verifying");
  await progress.phase("fixing");
  await progress.phase("verifying");
  await progress.phase("publishing");
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
  const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () =>
    clock.now(),
  );
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  await progress.phase("implementing");
  await flush(dispatcher);
  clock.advance(1_000);
  await progress.phase("merging");
  await progress.link("Pull request", "https://github.com/pmdroid/paws-app/pull/1");
  await flush(dispatcher);
  expect(tracker.sessionUpdates).toHaveLength(2);
  expect(tracker.sessionUpdates.at(-1)?.addedExternalUrls).toHaveLength(1);
  expect(tracker.sessionUpdates.at(-1)?.summary).toBe("ENG-1: merging");
  clock.advance(1_000);
  await progress.phase("completed");
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
    await (await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")).phase("verifying");
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
    expect((await sqliteDb(db).run((q) => getOutboxSteps(q, critical)))?.status).toBe("sent");
    db.close();
  },
);

test("Stop and newer turns fence captured metadata callbacks", async () => {
  const db = tempDb();
  const old = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
  await old.phase("implementing");
  await stopOutboxSession(sqliteDb(db), "linear", "session");
  await old.plan([{ content: "After Stop", status: "completed" }]);
  expect(listOutbox(db).every((row) => row.status === "dropped")).toBe(true);
  await advanceOutboxSession(sqliteDb(db), "linear", "session");
  const fresh = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
  await fresh.plan([{ content: "New turn", status: "inProgress" }]);
  await old.phase("completed");
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
  const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
  await progress.link("Pull request", "https://github.com/pmdroid/paws-app/pull/1");
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

test("a new delegation child starts its own plan without requiring an ACP plan event", async () => {
  const db = tempDb();
  const first = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
  await first.plan([{ content: "Build first child", status: "completed" }]);
  await first.phase("completed");
  const second = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-2");
  await second.phase("implementing");
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

test("response plans recover their ACP steps without code milestones and reset for a changed mode", async () => {
  const db = tempDb();
  const answer = await createLinearSessionProgress(
    sqliteDb(db),
    "session",
    "ENG-1",
    Date.now,
    "answer",
  );
  await answer.plan([{ content: "Explain the API", status: "inProgress" }]);
  const recovered = await createLinearSessionProgress(
    sqliteDb(db),
    "session",
    "ENG-1",
    Date.now,
    "answer",
  );
  await recovered.phase("working");
  expect(
    listOutbox(db, "session").findLast((row) => row.op === "linear.session.plan")?.payload,
  ).toMatchObject({
    mode: "answer",
    plan: [{ content: "Explain the API", status: "inProgress" }],
  });
  const artifact = await createLinearSessionProgress(
    sqliteDb(db),
    "session",
    "ENG-1",
    Date.now,
    "artifact",
  );
  await artifact.phase("working");
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
    await (await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")).phase("verifying");
    const outbox = new OutboxDispatcher(db, new FakeClock(1000));
    outbox.setHandler((row, context) =>
      deliverLinearOutbox(row, tracker, async () => {}, context, db),
    );
    await outbox.tick();
    await started.promise;
    await advanceOutboxSession(sqliteDb(db), "linear", "session");
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
      await (
        await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", Date.now, mode)
      ).plan([
        { content: "Discarded approach", status: "canceled" },
        { content: "Chosen approach", status: "pending" },
      ]);
      const recovered = await createLinearSessionProgress(
        sqliteDb(db),
        "session",
        "ENG-1",
        Date.now,
        mode,
      );
      await recovered.phase(mode === "code" ? "verifying" : "completed");
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

test("post-PR reconstruction refuses backwards phases and appends rebase verification", async () => {
  const db = tempDb();
  try {
    const progress = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
    await progress.phase("merging");
    markPr(db);
    const recovered = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
    await recovered.phase("implementing");
    await recovered.phase("fixing");
    expect(
      listOutbox(db).findLast((row) => row.op === "linear.session.summary")?.payload,
    ).toMatchObject({ summary: "ENG-1: merging" });
    await recovered.phase("verifying");
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
    ).toMatchObject({ summary: "ENG-1: merging" });
    await recovered.status("ENG-1: second in queue behind ENG-2");
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")
    ).phase("implementing");
    expect(
      listOutbox(db).findLast((row) => row.op === "linear.session.summary")?.payload,
    ).toMatchObject({ summary: "ENG-1: second in queue behind ENG-2" });
  } finally {
    db.close();
  }
});

test.each([
  ["findings", "Fix Closeout findings (2 of 3)", 3],
  ["findings", "Fix Closeout findings (2 of 5)", 5],
  ["ci", "Fix CI", 3],
  ["review", "Fix review findings", 3],
  ["conflict", "Fix merge conflicts", 3],
])("%s restarts append one durable reason-named step", async (reason, content, limit) => {
  const db = tempDb();
  try {
    await (await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")).phase("merging");
    markPr(db);
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")
    ).restart(String(reason), 2, 10, typeof limit === "number" ? limit : 3);
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")
    ).restart(String(reason), 2, 10, typeof limit === "number" ? limit : 3);
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

test("a restart's plan step goes out with the turn, not after the metadata interval", async () => {
  const db = tempDb();
  try {
    await (await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")).phase("merging");
    markPr(db);
    db.run("UPDATE outbox SET status='sent', sent_at=? WHERE op LIKE 'linear.session.%'", [
      Date.now(),
    ]);
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")
    ).restart("conflict", 1, 10);
    expect(listOutbox(db).findLast((row) => row.op === "linear.session.plan")).toMatchObject({
      status: "pending",
      notBefore: 0,
    });
  } finally {
    db.close();
  }
});

test("a captured plan callback preserves milestones completed by a newer reporter", async () => {
  const db = tempDb();
  try {
    const captured = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
    await captured.phase("implementing");
    await (await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")).phase("merging");
    markPr(db);
    await captured.plan([{ content: "Repair CI", status: "inProgress" }]);
    const plan = listOutbox(db).findLast((row) => row.op === "linear.session.plan")
      ?.payload as SessionUpdate;
    expect(plan.plan?.find((step) => step.content === "Verify changes")?.status).toBe("completed");
    expect(plan.plan?.find((step) => step.content === "Open pull request")?.status).toBe(
      "completed",
    );
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")
    ).restart("ci", 1, 10);
    await captured.plan([{ content: "Repair CI", status: "completed" }]);
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")
    ).restart("ci", 1, 10);
    const current = listOutbox(db).findLast((row) => row.op === "linear.session.plan")
      ?.payload as SessionUpdate;
    expect(current.plan?.filter((step) => step.content === "Fix CI")).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("successive restart rounds preserve their newest identity across captured callbacks", async () => {
  const db = tempDb();
  try {
    const captured = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
    await captured.phase("merging");
    markPr(db);
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")
    ).restart("ci", 1, 10);
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")
    ).restart("ci", 2, 20);
    await captured.plan([]);
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")
    ).restart("ci", 2, 20);
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

function latest(db: ReturnType<typeof tempDb>, op: string) {
  return listOutbox(db).findLast((row) => row.op === op)?.payload as SessionUpdate;
}

test("a waiting item leads its plan with a Wait step that completes when it starts", async () => {
  const db = tempDb();
  try {
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "PAS-619")
    ).wait("Wait for PAS-618", "PAS-619: waiting for PAS-618");
    expect(latest(db, "linear.session.summary").summary).toBe("PAS-619: waiting for PAS-618");
    expect(latest(db, "linear.session.plan").plan).toEqual([
      { content: "Wait for PAS-618", status: "inProgress" },
      { content: "Verify changes", status: "pending" },
      { content: "Open pull request", status: "pending" },
      { content: "Merge verified changes", status: "pending" },
    ]);
    // Another tick with the same wait changes nothing; a new wait completes the previous one.
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "PAS-619")
    ).wait("Wait for PAS-618", "PAS-619: waiting for PAS-618");
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "PAS-619")
    ).wait("Wait for a runner", "PAS-619: 2nd in line for a runner");
    expect(latest(db, "linear.session.plan").plan?.slice(0, 2)).toEqual([
      { content: "Wait for PAS-618", status: "completed" },
      { content: "Wait for a runner", status: "inProgress" },
    ]);
    // A run reporter created before the wait ended still completes it on start.
    const run = await createLinearSessionProgress(sqliteDb(db), "session", "PAS-619");
    await run.phase("implementing");
    await run.plan([{ content: "Rank runners", status: "inProgress" }]);
    expect(latest(db, "linear.session.plan").plan).toEqual([
      { content: "Wait for PAS-618", status: "completed" },
      { content: "Wait for a runner", status: "completed" },
      { content: "Rank runners", status: "inProgress" },
      { content: "Verify changes", status: "pending" },
      { content: "Open pull request", status: "pending" },
      { content: "Merge verified changes", status: "pending" },
    ]);
    expect(latest(db, "linear.session.summary").summary).toBe("PAS-619: implementing");
  } finally {
    db.close();
  }
});

test("a restarted item waiting for a runner shows its appended step, once, not a Wait step", async () => {
  const db = tempDb();
  try {
    await (await createLinearSessionProgress(sqliteDb(db), "session", "PAS-7")).phase("verifying");
    const waiting = await createLinearSessionProgress(sqliteDb(db), "session", "PAS-7");
    await waiting.restart("findings", 1, 12, 3);
    await waiting.status("PAS-7: waiting for a runner to fix Closeout findings (1 of 3)");
    expect(latest(db, "linear.session.summary").summary).toBe(
      "PAS-7: waiting for a runner to fix Closeout findings (1 of 3)",
    );
    // The run starts with the same restart.
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "PAS-7")
    ).restart("findings", 1, 12, 3);
    const plan = latest(db, "linear.session.plan").plan ?? [];
    expect(plan.filter((step) => step.content.startsWith("Fix Closeout findings"))).toEqual([
      { content: "Fix Closeout findings (1 of 3)", status: "inProgress" },
    ]);
    expect(plan.some((step) => step.content.startsWith("Wait"))).toBe(false);
  } finally {
    db.close();
  }
});

test("repeated phases, plans and status lines enqueue no duplicate title or plan rows", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  const plan = [
    { content: "Read the scheduler", status: "completed" as const },
    { content: "Rank runners by load share", status: "inProgress" as const },
  ];
  try {
    for (let round = 0; round < 3; round++) {
      // A fresh reporter per round, as each job and callback builds its own.
      const progress = await createLinearSessionProgress(sqliteDb(db), "session", "PAS-1", () =>
        clock.now(),
      );
      await progress.phase("implementing");
      await progress.plan(plan);
      await progress.plan(plan.map((step) => ({ ...step })));
      await progress.phase("implementing");
      await flush(dispatcher);
      clock.advance(150_000);
      await flush(dispatcher);
    }
    const voice = await createLinearSessionProgress(sqliteDb(db), "session", "PAS-1", () =>
      clock.now(),
    );
    await voice.status("PAS-1: CI running");
    await flush(dispatcher);
    await voice.status("PAS-1: CI running");
    await (
      await createLinearSessionProgress(sqliteDb(db), "session", "PAS-1", () => clock.now())
    ).status("PAS-1: CI running");
    clock.advance(150_000);
    await flush(dispatcher);

    const rows = (op: string) =>
      listOutbox(db, "session").filter((row) => row.op === op && row.status !== "dropped");
    expect(
      rows("linear.session.summary").map((row) => (row.payload as SessionUpdate).summary),
    ).toEqual(["PAS-1: implementing", "PAS-1: CI running"]);
    expect(rows("linear.session.plan")).toHaveLength(1);
    expect(tracker.sessionUpdates.filter((update) => update.summary)).toHaveLength(2);
    expect(tracker.sessionUpdates.filter((update) => update.plan)).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("a plan step status change replaces the plan and an unchanged step does not", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  try {
    const progress = await createLinearSessionProgress(sqliteDb(db), "session", "PAS-1", () =>
      clock.now(),
    );
    await progress.phase("implementing");
    await progress.plan([{ content: "Rank runners", status: "inProgress" }]);
    await flush(dispatcher);
    clock.advance(150_000);
    await progress.plan([{ content: "Rank runners", status: "inProgress" }]);
    await flush(dispatcher);
    await progress.plan([{ content: "Rank runners", status: "completed" }]);
    clock.advance(150_000);
    await flush(dispatcher);
    expect(
      tracker.sessionUpdates.flatMap((update) => (update.plan ? [update.plan[0]?.status] : [])),
    ).toEqual(["inProgress", "completed"]);
    expect(
      listOutbox(db, "session").filter(
        (row) => row.op === "linear.session.plan" && row.status !== "dropped",
      ),
    ).toHaveLength(2);
  } finally {
    db.close();
  }
});

test("the keepalive names the current agent step, else the last line, else the phase", async () => {
  const db = tempDb();
  try {
    const progress = await createLinearSessionProgress(sqliteDb(db), "session", "PAS-1");
    await progress.phase("implementing");
    expect(await progress.keepalive(null)).toBe("Implementing PAS-1.");
    expect(await progress.keepalive("Found the cause in the scheduler.")).toBe(
      "Found the cause in the scheduler.",
    );
    await progress.plan([
      { content: "Read the scheduler", status: "completed" },
      { content: "Add coverage", status: "completed" },
      { content: "rank runners by load share", status: "inProgress" },
      { content: "Wire the setting", status: "pending" },
      { content: "Document it", status: "pending" },
    ]);
    expect(await progress.keepalive("Found the cause.")).toBe(
      "Step 3 of 5: rank runners by load share.",
    );
    // Another reporter for the same session reads the step from the saved plan.
    expect(
      await (await createLinearSessionProgress(sqliteDb(db), "session", "PAS-1")).keepalive(null),
    ).toBe("Step 3 of 5: rank runners by load share.");
    await progress.plan([
      { content: "Read the scheduler", status: "completed" },
      { content: "Wire the setting", status: "pending" },
    ]);
    expect(await progress.keepalive(null)).toBe("Step 2 of 2: Wire the setting.");
    await progress.phase("verifying");
    expect(await progress.keepalive(null)).toBe("Verifying PAS-1.");
  } finally {
    db.close();
  }
});

test("repeated merge wakes on a published pull request keep a stable title within the throttle", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  const wake = () =>
    createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () => clock.now());
  try {
    await (await wake()).phase("verifying");
    await flush(dispatcher);
    await (await wake()).phase("publishing");
    markPr(db);
    await (await wake()).phase("merging");
    expect(latest(db, "linear.session.summary").summary).toBe("ENG-1: waiting to merge");
    for (let tick = 0; tick < 10; tick++) {
      await (await wake()).reach("merging");
      clock.advance(30_000);
      await flush(dispatcher);
    }
    const summaries = tracker.sessionUpdates.flatMap((update) =>
      update.summary ? [update.summary] : [],
    );
    expect(summaries).toEqual(["ENG-1: verifying", "ENG-1: waiting to merge"]);
    expect(await (await wake()).keepalive(null)).toBe("Merging ENG-1.");

    // A stable CI wait stays the title through further wakes.
    await (await wake()).status("ENG-1: CI 4 of 6 done");
    for (let tick = 0; tick < 5; tick++) {
      await (await wake()).reach("merging");
      await (await wake()).status("ENG-1: CI 4 of 6 done");
      clock.advance(30_000);
      await flush(dispatcher);
    }
    expect(tracker.sessionUpdates.flatMap((u) => (u.summary ? [u.summary] : [])).at(-1)).toBe(
      "ENG-1: CI 4 of 6 done",
    );
    expect(
      listOutbox(db, "session").filter(
        (row) => row.op === "linear.session.summary" && row.status !== "dropped",
      ),
    ).toHaveLength(3);
  } finally {
    db.close();
  }
});

test("a new head on a published pull request updates it without regressing the phase", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  const wake = () =>
    createLinearSessionProgress(sqliteDb(db), "session", "ENG-1", () => clock.now());
  try {
    await (await wake()).phase("merging");
    markPr(db);
    await flush(dispatcher);
    clock.advance(120_000);
    await (await wake()).restart("ci", 1, 10);
    await flush(dispatcher);
    expect(tracker.sessionUpdates.at(-1)?.summary).toBe("ENG-1: fixing CI");
    await (await wake()).phase("verifying");
    clock.advance(1_000);
    await (await wake()).phase("publishing");
    expect(latest(db, "linear.session.summary").summary).toBe("ENG-1: fixing CI");
    expect(latest(db, "linear.session.plan").plan?.at(-1)).toEqual({
      content: "Verify fixes",
      status: "inProgress",
    });
    expect(await (await wake()).keepalive(null)).toBe("Merging ENG-1.");
    await (await wake()).phase("merging");
    expect(latest(db, "linear.session.summary").summary).toBe("ENG-1: waiting to merge");
    clock.advance(120_000);
    await flush(dispatcher);
    const summaries = tracker.sessionUpdates.flatMap((u) => (u.summary ? [u.summary] : []));
    expect(summaries).not.toContain("ENG-1: updating the pull request");
    expect(summaries.at(-1)).toBe("ENG-1: waiting to merge");
    expect(
      latest(db, "linear.session.plan")
        .plan?.slice(3)
        .every((step) => step.status === "completed"),
    ).toBe(true);
    await (await wake()).phase("completed");
    await flush(dispatcher);
    expect(tracker.sessionUpdates.at(-1)?.summary).toBe("ENG-1: merged");
    await (await wake()).reach("merging");
    expect(latest(db, "linear.session.summary").summary).toBe("ENG-1: merged");
  } finally {
    db.close();
  }
});

test("reconstruction reaches merging once and stale or stopped reporters change nothing", async () => {
  const db = tempDb();
  try {
    await (await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")).phase("publishing");
    markPr(db);
    const captured = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
    await (await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")).reach("merging");
    expect(latest(db, "linear.session.summary").summary).toBe("ENG-1: waiting to merge");
    const rows = listOutbox(db).length;
    await (await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1")).reach("merging");
    await captured.reach("merging");
    expect(listOutbox(db)).toHaveLength(rows);

    await advanceOutboxSession(sqliteDb(db), "linear", "session");
    await captured.phase("publishing");
    expect(
      listOutbox(db).filter((row) => row.status !== "dropped" && row.generation === 0),
    ).not.toContainEqual(
      expect.objectContaining({
        payload: expect.objectContaining({ summary: "ENG-1: publishing" }),
      }),
    );
    const fresh = await createLinearSessionProgress(sqliteDb(db), "session", "ENG-1");
    await fresh.reach("merging");
    expect(listOutbox(db).findLast((row) => row.op === "linear.session.summary")?.generation).toBe(
      1,
    );

    await stopOutboxSession(sqliteDb(db), "linear", "session");
    await fresh.phase("publishing");
    await fresh.reach("merging");
    expect(
      listOutbox(db).every(
        (row) => !row.op.startsWith("linear.session.") || row.status === "dropped",
      ),
    ).toBe(true);
  } finally {
    db.close();
  }
});
