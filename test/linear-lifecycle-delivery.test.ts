import { expect, test } from "bun:test";
import { join } from "node:path";
import { FakeClock, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  advanceLinearSessionGeneration,
  insertQueuedItem,
  listOutbox,
  openDatabase,
  migrate,
} from "../src/db";
import { attachOrchestrator } from "../src/loop";
import { createFakeTracker, openLinear, type AcceptedLinearEvent } from "../src/linear";
import { tempDb, tempHome } from "./helpers";

function created(): AcceptedLinearEvent {
  return {
    dedupeKey: "session:session:created",
    deliveryId: null,
    source: "webhook",
    action: "created",
    sessionId: "session",
    issueId: "issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 1,
    payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
  };
}

for (const [body, existing] of [
  ["Picked up this issue.", true],
  ["Picked up ENG-1.", false],
  ["Picked up this issue.", false],
] as const) {
  test(`Stop fences a deferred ${body} before the final activity, existing task: ${existing}`, async () => {
    const db = tempDb();
    const home = tempHome();
    if (existing) insertQueuedItem(db, { id: "existing", sessionKey: "session" });
    const tracker = createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ENG-1",
        title: "Task",
        description: null,
        subIssues: [],
      },
    ]);
    const outbox = new OutboxDispatcher(db, systemClock);
    const orchestrator = attachOrchestrator({
      db,
      pawsRoot: home,
      tracker,
      outbox,
      jobs: new JobLoop(db, systemClock),
    });
    const ready = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const post = tracker.postProgress.bind(tracker);
    tracker.postProgress = async (update, options) => {
      if (update.body === body) {
        if (!options?.signal) throw new Error("unfenced progress");
        ready.resolve(options.signal);
        await release.promise;
      }
      options?.signal?.throwIfAborted();
      return post(update, options);
    };
    const linear = openLinear({
      db,
      secretsDir: join(home, "secrets"),
      env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
      publicUrl: null,
      fetch: async () => {
        throw new Error("unexpected direct Linear request");
      },
      progressReporter: (event) => orchestrator.sessionProgressReporter(event),
      followUp: (event) => orchestrator.onLinearEvent(event),
    });
    let intake: Promise<void | boolean> | undefined;
    try {
      intake = Promise.resolve(linear.webhook.onEvent!(created()));
      const signal = await ready.promise;
      const row = listOutbox(db).find(
        (entry) => (entry.payload as { body?: string }).body === body,
      )!;
      expect((row.payload as { id: string }).id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      const stopping = linear.webhook.onEvent!({
        ...created(),
        dedupeKey: "activity:stop",
        action: "prompted",
        signal: "stop",
        updatedAtMs: 2,
      });
      for (let i = 0; i < 100 && !signal.aborted; i++) await Bun.sleep(1);
      expect(signal.aborted).toBe(true);
      expect(tracker.progress.some((update) => update.kind === "response")).toBe(false);
      release.resolve();
      await stopping;
      await intake;
      await outbox.idle();
      outbox.tick();
      await outbox.idle();
      expect(tracker.progress.some((update) => update.body === body)).toBe(false);
      expect(listOutbox(db).find((entry) => entry.id === row.id)?.status).toBe("dropped");
      const terminal = tracker.progress.findIndex((update) => update.kind === "response");
      expect(terminal).toBeGreaterThanOrEqual(0);
      expect(tracker.progress.slice(terminal + 1)).toEqual([]);
      const count = tracker.progress.length;
      await linear.webhook.onEvent!(created());
      expect(tracker.progress).toHaveLength(count);
    } finally {
      release.resolve();
      await intake;
      await outbox.idle();
      db.close();
    }
  });
}

test("acknowledgement retry and duplicate replay preserve one activity UUID", async () => {
  const db = tempDb();
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  const outbox = new OutboxDispatcher(db, clock);
  const orchestrator = attachOrchestrator({
    db,
    clock,
    tracker,
    outbox,
    jobs: new JobLoop(db, clock),
    pawsRoot: tempHome(),
  });
  const ids: (string | undefined)[] = [];
  tracker.postProgress = async (update) => {
    ids.push(update.id);
    if (ids.length === 1) throw new Error("retry delivery");
  };
  try {
    const update = {
      sessionId: "session",
      kind: "thought" as const,
      body: "Picked up this issue.",
    };
    await orchestrator.sessionProgressReporter(created())(update);
    await orchestrator.sessionProgressReporter(created())(update);
    expect(ids).toHaveLength(1);
    clock.advance(60_000);
    await orchestrator.sessionProgressReporter(created())(update);
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBeString();
    expect(listOutbox(db)).toHaveLength(1);
    expect(listOutbox(db)[0]?.status).toBe("sent");
  } finally {
    db.close();
  }
});

test("an old prompted intake failure cannot terminate a newer session generation", async () => {
  const db = tempDb();
  const home = tempHome();
  const tracker = createFakeTracker();
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    db,
    pawsRoot: home,
    tracker,
    outbox,
    jobs: new JobLoop(db, systemClock),
  });
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const linear = openLinear({
    db,
    secretsDir: join(home, "secrets"),
    env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
    publicUrl: null,
    progressReporter: (event) => orchestrator.sessionProgressReporter(event),
    followUp: async () => {
      ready.resolve();
      await release.promise;
      throw new Error("old intake failure");
    },
  });
  const old = Promise.resolve(
    linear.webhook.onEvent!({ ...created(), action: "prompted", dedupeKey: "old-prompt" }),
  ).catch((error: unknown) => error);
  try {
    await ready.promise;
    const generation = advanceLinearSessionGeneration(db, "session");
    release.resolve();
    await old;
    expect(tracker.progress).toEqual([]);
    const error = listOutbox(db).find((row) => (row.payload as { kind?: string }).kind === "error");
    expect(error?.generation).toBe(generation - 1);
    expect(error?.status).toBe("dropped");
    await orchestrator.sessionProgressReporter({ ...created(), dedupeKey: "new-prompt" })({
      sessionId: "session",
      kind: "thought",
      body: "Working on the newer request.",
    });
    expect(tracker.progress.map((update) => update.body)).toEqual([
      "Working on the newer request.",
    ]);
  } finally {
    release.resolve();
    await old;
    db.close();
  }
});

test.each([false, true])(
  "prompted intake failure uses its own accepted generation, superseded: %s",
  async (superseded) => {
    const db = tempDb();
    const home = tempHome();
    const tracker = createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ENG-1",
        title: "Task",
        description: null,
        subIssues: [],
      },
    ]);
    const outbox = new OutboxDispatcher(db, systemClock);
    const orchestrator = attachOrchestrator({
      db,
      pawsRoot: home,
      tracker,
      outbox,
      jobs: new JobLoop(db, systemClock),
    });
    const ready = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const load = tracker.loadEpic.bind(tracker);
    let reads = 0;
    tracker.loadEpic = async (issueId) => {
      if (++reads === 1) {
        ready.resolve();
        await release.promise;
        throw new Error("failed prompted intake");
      }
      return load(issueId);
    };
    const linear = openLinear({
      db,
      secretsDir: join(home, "secrets"),
      env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
      publicUrl: null,
      progressReporter: (event) => orchestrator.sessionProgressReporter(event),
      followUp: (event) => orchestrator.onLinearEvent(event),
    });
    const prompt = {
      ...created(),
      action: "prompted" as const,
      dedupeKey: "failed-prompt",
      activityId: "failed-prompt",
      body: "First request",
    };
    const old = Promise.resolve(linear.webhook.onEvent!(prompt)).catch((error: unknown) => error);
    let next: Promise<unknown> | undefined;
    try {
      await ready.promise;
      if (superseded)
        next = Promise.resolve(
          linear.webhook.onEvent!({
            ...prompt,
            dedupeKey: "newer-prompt",
            activityId: "newer-prompt",
            body: "Newer request",
            updatedAtMs: 2,
          }),
        );
      release.resolve();
      await old;
      await next;
      const error = listOutbox(db).find(
        (row) => (row.payload as { kind?: string }).kind === "error",
      );
      expect(error?.generation).toBe(1);
      expect(error?.status).toBe(superseded ? "dropped" : "sent");
      expect(tracker.progress.filter((update) => update.kind === "error")).toHaveLength(
        superseded ? 0 : 1,
      );
      if (superseded)
        expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM work_item").get()?.n).toBe(1);
    } finally {
      release.resolve();
      await old;
      await next;
      await orchestrator.shutdown();
      db.close();
    }
  },
);

test("item Stop delivery retains one UUID through failure, reopen and duplicate replay", async () => {
  const path = join(tempHome(), "stop.db");
  let db = openDatabase(path);
  migrate(db);
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  const ids: (string | undefined)[] = [];
  tracker.postProgress = async (update) => {
    ids.push(update.id);
    if (ids.length === 1) throw new Error("retry Stop delivery");
  };
  let outbox = new OutboxDispatcher(db, clock);
  const options = () => ({
    db,
    clock,
    tracker,
    outbox,
    jobs: new JobLoop(db, clock),
    pawsRoot: tempHome(),
  });
  let orchestrator = attachOrchestrator(options());
  try {
    insertQueuedItem(db, { id: "stopped", sessionKey: "session" });
    const stop = {
      ...created(),
      dedupeKey: "stop-retry",
      action: "prompted" as const,
      signal: "stop",
      updatedAtMs: 1_000,
    };
    await orchestrator.onLinearEvent(stop);
    const row = listOutbox(db).find((entry) => entry.delivery === "stop")!;
    const id = (row.payload as { id: string }).id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids).toEqual([id]);
    await orchestrator.shutdown();
    db.close();
    db = openDatabase(path);
    migrate(db);
    clock.advance(60_000);
    outbox = new OutboxDispatcher(db, clock);
    orchestrator = attachOrchestrator(options());
    await orchestrator.onLinearEvent(stop);
    outbox.tick();
    await outbox.idle();
    expect(ids).toEqual([id, id]);
    expect(listOutbox(db).find((entry) => entry.id === row.id)?.status).toBe("sent");
    await orchestrator.onLinearEvent(stop);
    expect(ids).toEqual([id, id]);
    expect(listOutbox(db)).toHaveLength(1);
  } finally {
    await orchestrator.shutdown();
    await outbox.idle();
    db.close();
  }
});

test("a merged item settles its delegation without a delegation summary", async () => {
  const db = openDatabase(join(tempHome(), "completion.db"));
  migrate(db);
  const item = insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
  db.run("UPDATE work_item SET state = 'merged' WHERE id = ?", [item.id]);
  const tracker = createFakeTracker([
    {
      linearIssueId: "lin-ENG-1",
      identifier: "ENG-1",
      title: "Task",
      description: null,
      subIssues: [{ linearIssueId: item.linearIssueId, identifier: "ENG-1", title: "Task" }],
    },
  ]);
  const orchestrator = attachOrchestrator({
    db,
    pawsRoot: tempHome(),
    tracker,
    channel: "comments",
    jobs: new JobLoop(db, systemClock),
    outbox: new OutboxDispatcher(db, systemClock),
  });
  try {
    await orchestrator.onLinearEvent({ ...created(), issueId: "lin-ENG-1" });
    expect(
      db.query<{ state: string }, [string]>("SELECT state FROM work_item WHERE id = ?").get(item.id)
        ?.state,
    ).toBe("merged");
    expect(listOutbox(db).some((row) => row.idempotencyKey.startsWith("epic-done:"))).toBe(false);
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(false);
    expect(tracker.progress.some((update) => update.body.includes("Epic abandoned"))).toBe(false);
  } finally {
    await orchestrator.shutdown();
    db.close();
  }
});
