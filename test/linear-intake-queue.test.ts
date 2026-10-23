import { expect, test } from "bun:test";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RunnerSlotsBusyError, systemClock } from "../src/core";
import { JobLoop, OutboxDispatcher, migrate, openDatabase } from "../src/db";
import {
  INTAKE_RETRY_MS,
  createFakeTracker,
  createInboxStore,
  createIntakeQueue,
  createLinearIntake,
  createLinearLedger,
  LinearRateLimitError,
  type AcceptedLinearEvent,
  type TrackerAdapter,
} from "../src/linear";
import { attachOrchestrator } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

function created(n: number, receivedAt = 1): AcceptedLinearEvent {
  return {
    dedupeKey: `session:s${n}:created`,
    deliveryId: `delivery-${n}`,
    source: "webhook",
    action: "created",
    sessionId: `s${n}`,
    issueId: `issue-${n}`,
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: receivedAt,
    payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
  };
}

function unhandled(db: ReturnType<typeof tempDb>): number {
  return db
    .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM inbox_event WHERE handled = 0")
    .get()!.n;
}

test("a burst of 20 sessions while every runner slot is busy and Linear rate-limits is queued two at a time", async () => {
  const home = tempHome();
  const root = join(home, "paws");
  mkdirSync(root);
  const db = openDatabase(join(root, "paws.db"));
  migrate(db);
  let clock = Date.parse("2026-10-22T03:55:00Z");
  const ledger = createLinearLedger({ now: () => clock, random: () => 0, log: () => {} });
  const fake = createFakeTracker(
    Array.from({ length: 20 }, (_, n) => ({
      linearIssueId: `issue-${n}`,
      identifier: `PAS-${n}`,
      title: `Burst ${n}`,
      description: null,
      subIssues: [],
    })),
  );
  // Linear answers 50 requests, then rate-limits for a minute.
  let requests = 0;
  let limitedUntil = 0;
  let rateLimited = 0;
  const tracker = new Proxy(fake, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        if (limitedUntil !== 0 && clock >= limitedUntil) {
          requests = 0;
          limitedUntil = 0;
        }
        requests += 1;
        if (requests > 50) {
          if (limitedUntil === 0) limitedUntil = clock + 60_000;
          rateLimited += 1;
          throw ledger.limited(
            "intake",
            new LinearRateLimitError(limitedUntil - clock, {
              requestsRemaining: 0,
              requestsLimit: 50,
              requestsResetMs: limitedUntil,
              complexityRemaining: null,
              complexityLimit: null,
              complexityResetMs: null,
              complexity: null,
            }),
          );
        }
        return value.apply(target, args);
      };
    },
  }) as TrackerAdapter;
  const remote = () => async () => {
    throw new RunnerSlotsBusyError();
  };
  const jobs = new JobLoop(db, systemClock);
  const outbox = new OutboxDispatcher(db, systemClock);
  const orchestrator = attachOrchestrator({
    db,
    jobs,
    outbox,
    home,
    pawsRoot: root,
    tracker,
    linearTaskModes: true,
    launch: () => {
      throw new Error("Remote execution must not launch a local agent");
    },
    remoteExecution: {
      slotFree: () => false,
      agentForSession: remote,
      agentForItem: remote,
    },
  });
  const store = createInboxStore(db);
  let active = 0;
  let mostActive = 0;
  const { onEvent, queue } = createLinearIntake({
    store,
    tracker,
    signal: new AbortController().signal,
    ledger,
    now: () => clock,
    log: () => {},
    followUp: async (event) => {
      active += 1;
      mostActive = Math.max(mostActive, active);
      try {
        await Bun.sleep(2);
        return await orchestrator.onLinearEvent(event);
      } finally {
        active -= 1;
      }
    },
  });
  try {
    for (let n = 0; n < 20; n++) {
      const event = created(n, clock + n * 40);
      store.commit(event);
      queue.arrive(event);
    }
    for (let round = 0; round < 20 && unhandled(db) > 0; round++) {
      await queue.idle();
      if (unhandled(db) === 0) break;
      clock += 60_000;
      queue.wake();
    }
    await queue.idle();
    const items = db
      .query<{ state: string }, []>("SELECT state FROM work_item ORDER BY linear_issue_id")
      .all();
    expect({
      unhandled: unhandled(db),
      items: items.length,
      states: [...new Set(items.map((item) => item.state))],
      errors: fake.progress.filter((update) => update.kind === "error"),
      questions: fake.questions,
      mostActive,
      rateLimited: rateLimited > 0,
    }).toEqual({
      unhandled: 0,
      items: 20,
      states: ["queued"],
      errors: [],
      questions: [],
      mostActive: 2,
      rateLimited: true,
    });
  } finally {
    await queue.stop();
    await onEvent.close();
    await orchestrator.shutdown().catch(() => undefined);
    await outbox.idle();
    db.close();
  }
}, 20_000);

test("a session that keeps failing retries on its own schedule while later sessions are admitted", async () => {
  const db = tempDb();
  const store = createInboxStore(db);
  let clock = 1_000_000;
  const delivered: string[] = [];
  const queue = createIntakeQueue({
    store,
    now: () => clock,
    log: () => {},
    arrive: async () => true,
    deliver: async (event) => {
      delivered.push(event.sessionId!);
      if (event.sessionId === "s0") throw new Error("Linear is unreachable for this session");
    },
  });
  const failing = () =>
    db
      .query<{ attempts: number; next_attempt_at: number; last_error: string }, []>(
        "SELECT attempts, next_attempt_at, last_error FROM inbox_event WHERE session_id = 's0'",
      )
      .get()!;
  try {
    store.commit(created(0));
    store.commit(created(1));
    queue.wake();
    await queue.idle();
    const waits: number[] = [];
    for (let n = 2; n < 8; n++) {
      const due = failing().next_attempt_at;
      waits.push(due - clock);
      // Not due yet: a wake admits the newer session and leaves the failing one alone.
      clock = due - 1;
      store.commit(created(n));
      queue.wake();
      await queue.idle();
      clock = due;
      queue.wake();
      await queue.idle();
    }
    expect({
      waits,
      attempts: failing().attempts,
      lastError: failing().last_error,
      delivered,
      unhandled: db
        .query<{ session_id: string }, []>("SELECT session_id FROM inbox_event WHERE handled = 0")
        .all(),
    }).toEqual({
      waits: [30_000, 60_000, 120_000, 300_000, 600_000, 600_000],
      attempts: 7,
      lastError: "Linear is unreachable for this session",
      delivered: [
        "s0",
        "s1",
        "s2",
        "s0",
        "s3",
        "s0",
        "s4",
        "s0",
        "s5",
        "s0",
        "s6",
        "s0",
        "s7",
        "s0",
      ],
      unhandled: [{ session_id: "s0" }],
    });
    expect(INTAKE_RETRY_MS).toEqual([30_000, 60_000, 120_000, 300_000, 600_000]);
  } finally {
    await queue.stop();
    db.close();
  }
});

test("the queue starts nothing during a Linear rate-limit hold and resumes after it", async () => {
  const db = tempDb();
  const store = createInboxStore(db);
  let clock = 1_000_000;
  const ledger = createLinearLedger({ now: () => clock, random: () => 0, log: () => {} });
  const delivered: string[] = [];
  const queue = createIntakeQueue({
    store,
    ledger,
    now: () => clock,
    log: () => {},
    arrive: async () => true,
    deliver: async (event) => {
      delivered.push(event.sessionId!);
    },
  });
  try {
    ledger.limited(
      "poller",
      new LinearRateLimitError(30_000, {
        requestsRemaining: 0,
        requestsLimit: 5000,
        requestsResetMs: clock + 30_000,
        complexityRemaining: null,
        complexityLimit: null,
        complexityResetMs: null,
        complexity: null,
      }),
    );
    store.commit(created(0));
    queue.wake();
    await queue.idle();
    const held = [...delivered];
    clock += 31_000;
    queue.wake();
    await queue.idle();
    expect({ held, delivered }).toEqual({ held: [], delivered: ["s0"] });
  } finally {
    await queue.stop();
    db.close();
  }
});

test("every arrival posts its first activity at once while both intake slots are busy", async () => {
  const db = tempDb();
  const store = createInboxStore(db);
  const fake = createFakeTracker([]);
  let release = () => {};
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started: string[] = [];
  const { onEvent, queue } = createLinearIntake({
    store,
    tracker: fake,
    signal: new AbortController().signal,
    log: () => {},
    followUp: async (event) => {
      started.push(event.sessionId!);
      await blocked;
    },
  });
  try {
    for (let n = 0; n < 5; n++) {
      const event = created(n);
      store.commit(event);
      queue.arrive(event);
    }
    while (started.length < 2) await Bun.sleep(1);
    const acknowledged = fake.progress
      .filter((update) => update.body === "Picked up this issue.")
      .map((update) => update.sessionId);
    const whileBusy = [...started];
    release();
    await queue.idle();
    expect({ acknowledged, whileBusy, started, unhandled: unhandled(db) }).toEqual({
      acknowledged: ["s0", "s1", "s2", "s3", "s4"],
      whileBusy: ["s0", "s1"],
      started: ["s0", "s1", "s2", "s3", "s4"],
      unhandled: 0,
    });
  } finally {
    release();
    await queue.stop();
    await onEvent.close();
    db.close();
  }
});
