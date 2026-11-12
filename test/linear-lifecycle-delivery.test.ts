import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { join } from "node:path";
import { FakeClock, systemClock } from "../src/core";
import {
  JobLoop,
  OutboxDispatcher,
  advanceLinearSessionGeneration,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  listWorkItems,
  openPawsStore,
} from "../src/db";
import { attachOrchestrator } from "../src/loop";
import { createFakeTracker, openLinear, type AcceptedLinearEvent } from "../src/linear";
import { tempHome } from "./helpers";
import { copyMigratedPglite, tempStore } from "./pglite";

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
  ["Picked up this issue.", false],
] as const) {
  test(`Stop fences a deferred ${body} before the final activity, existing task: ${existing}`, async () => {
    const { db, close } = await tempStore();
    const home = tempHome();
    if (existing) await insertQueuedItem(db, { id: "existing", sessionKey: "session" });
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
      store: db,
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
    const linear = await openLinear({
      db,
      store: db,
      secretsDir: join(home, "secrets"),
      env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
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
      const row = (await listOutbox(db)).find(
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
      await outbox.tick();
      await outbox.idle();
      expect(tracker.progress.some((update) => update.body === body)).toBe(false);
      expect((await listOutbox(db)).find((entry) => entry.id === row.id)?.status).toBe("dropped");
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
      await close();
    }
  });
}

test("acknowledgement retry and duplicate replay preserve one activity UUID", async () => {
  const { db, close } = await tempStore();
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  const outbox = new OutboxDispatcher(db, clock);
  const orchestrator = attachOrchestrator({
    store: db,
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
    expect(ids).toHaveLength(0);
    expect((await listOutbox(db))[0]?.notBefore).toBe(6_000);
    clock.advance(5_000);
    await outbox.tick();
    await outbox.idle();
    expect(ids).toHaveLength(1);
    clock.advance(60_000);
    await orchestrator.sessionProgressReporter(created())(update);
    await outbox.tick();
    await outbox.idle();
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[0]).toBeString();
    expect(await listOutbox(db)).toHaveLength(1);
    expect((await listOutbox(db))[0]?.status).toBe("sent");
  } finally {
    await close();
  }
});

test("an old prompted intake failure cannot terminate a newer session generation", async () => {
  const { db, close } = await tempStore();
  const home = tempHome();
  const tracker = createFakeTracker();
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    store: db,
    pawsRoot: home,
    tracker,
    outbox,
    jobs: new JobLoop(db, systemClock),
  });
  const ready = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const linear = await openLinear({
    db,
    store: db,
    secretsDir: join(home, "secrets"),
    env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
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
    const generation = await advanceLinearSessionGeneration(db, "session");
    release.resolve();
    await old;
    expect(tracker.progress).toEqual([]);
    const error = (await listOutbox(db)).find(
      (row) => (row.payload as { kind?: string }).kind === "error",
    );
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
    await close();
  }
});

test.each([false, true])(
  "prompted intake failure uses its own accepted generation, superseded: %s",
  async (superseded) => {
    const { db, close } = await tempStore();
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
      store: db,
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
    const linear = await openLinear({
      db,
      store: db,
      secretsDir: join(home, "secrets"),
      env: { LINEAR_ACCESS_TOKEN: "fixture-token" },
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
      const error = (await listOutbox(db)).find(
        (row) => (row.payload as { kind?: string }).kind === "error",
      );
      expect(error?.generation).toBe(1);
      expect(error?.status).toBe(superseded ? "dropped" : "sent");
      expect(tracker.progress.filter((update) => update.kind === "error")).toHaveLength(
        superseded ? 0 : 1,
      );
      if (superseded) expect(await listWorkItems(db)).toHaveLength(1);
    } finally {
      release.resolve();
      await old;
      await next;
      await orchestrator.shutdown();
      await close();
    }
  },
);

test("item Stop delivery retains one UUID through failure, reopen and duplicate replay", async () => {
  const pgliteDir = join(tempHome(), "pglite");
  await copyMigratedPglite(pgliteDir);
  let open = await openPawsStore({ url: null, pgliteDir });
  const clock = new FakeClock(1_000);
  const tracker = createFakeTracker();
  const ids: (string | undefined)[] = [];
  tracker.postProgress = async (update) => {
    ids.push(update.id);
    if (ids.length === 1) throw new Error("retry Stop delivery");
  };
  let outbox = new OutboxDispatcher(open.store, clock);
  const options = () => ({
    store: open.store,
    clock,
    tracker,
    outbox,
    jobs: new JobLoop(open.store, clock),
    pawsRoot: tempHome(),
  });
  let orchestrator = attachOrchestrator(options());
  try {
    await insertQueuedItem(open.store, { id: "stopped", sessionKey: "session" });
    const stop = {
      ...created(),
      dedupeKey: "stop-retry",
      action: "prompted" as const,
      signal: "stop",
      updatedAtMs: 1_000,
    };
    await orchestrator.onLinearEvent(stop);
    const row = (await listOutbox(open.store)).find((entry) => entry.delivery === "stop")!;
    const id = (row.payload as { id: string }).id;
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(ids).toEqual([id]);
    await orchestrator.shutdown();
    await outbox.idle();
    await open.close();
    open = await openPawsStore({ url: null, pgliteDir });
    clock.advance(60_000);
    outbox = new OutboxDispatcher(open.store, clock);
    orchestrator = attachOrchestrator(options());
    await orchestrator.onLinearEvent(stop);
    await outbox.tick();
    await outbox.idle();
    expect(ids).toEqual([id, id]);
    expect((await listOutbox(open.store)).find((entry) => entry.id === row.id)?.status).toBe(
      "sent",
    );
    await orchestrator.onLinearEvent(stop);
    expect(ids).toEqual([id, id]);
    expect((await listOutbox(open.store)).map((entry) => entry.op)).toEqual(["activity"]);
  } finally {
    await orchestrator.shutdown();
    await outbox.idle();
    await open.close();
  }
});

test("a merged item settles its delegation without a delegation summary", async () => {
  const { db, close } = await tempStore();
  const item = await insertQueuedItem(db, { id: "ENG-1", sessionKey: "session" });
  await db.run((q) =>
    q.exec(q.orm.update(q.t.workItem).set({ state: "merged" }).where(eq(q.t.workItem.id, item.id))),
  );
  const tracker = createFakeTracker([
    {
      linearIssueId: "lin-ENG-1",
      identifier: "ENG-1",
      title: "Task",
      description: null,
      subIssues: [{ linearIssueId: item.linearIssueId, identifier: "ENG-1", title: "Task" }],
    },
  ]);
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    store: db,
    pawsRoot: tempHome(),
    tracker,
    jobs: new JobLoop(db, systemClock),
    outbox,
  });
  try {
    await orchestrator.onLinearEvent({ ...created(), issueId: "lin-ENG-1" });
    expect((await getWorkItem(db, item.id))?.state).toBe("merged");
    expect((await listOutbox(db)).some((row) => row.idempotencyKey.startsWith("epic-done:"))).toBe(
      false,
    );
    expect(tracker.progress.some((update) => update.body.includes("Epic complete"))).toBe(false);
    expect(tracker.progress.some((update) => update.body.includes("Epic abandoned"))).toBe(false);
  } finally {
    await orchestrator.shutdown();
    await outbox.idle();
    await close();
  }
});
