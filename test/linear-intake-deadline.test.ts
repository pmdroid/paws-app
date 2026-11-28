import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { setJournalSink, type Db } from "../src/db";
import {
  INTAKE_DEADLINE_MS,
  createFakeTracker,
  createInboxStore,
  createIntakeQueue,
  createLinearIntake,
  type AcceptedLinearEvent,
} from "../src/linear";
import { createMetricsRecorder } from "../src/metrics";
import { tempStore } from "./pglite";
import { waitFor } from "./wait-for";

function created(n: number): AcceptedLinearEvent {
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
    updatedAtMs: 1,
    payload: JSON.stringify({ agentSession: { creatorId: "human" } }),
  };
}

function prompted(activity: string, body: string, source: "webhook" | "poll" = "poll") {
  return {
    ...created(0),
    dedupeKey: `activity:${activity}`,
    deliveryId: null,
    source,
    action: "prompted",
    activityId: activity,
    body,
  } satisfies AcceptedLinearEvent;
}

function fakeDeadlines(start: number) {
  let clock = start;
  const pending: { at: number; controller: AbortController }[] = [];
  return {
    now: () => clock,
    asked: [] as number[],
    deadline(ms: number) {
      this.asked.push(ms);
      const controller = new AbortController();
      pending.push({ at: clock + ms, controller });
      return controller.signal;
    },
    advance(ms: number) {
      clock += ms;
      for (const timer of pending.filter((entry) => entry.at <= clock))
        timer.controller.abort(new DOMException("The operation timed out.", "TimeoutError"));
    },
  };
}

async function row(db: Db, dedupeKey: string) {
  return (await db.run((q) =>
    q.one(
      q.orm
        .select({
          handled: q.t.inboxEvent.handled,
          attempts: q.t.inboxEvent.attempts,
          nextAttemptAt: q.t.inboxEvent.nextAttemptAt,
          lastError: q.t.inboxEvent.lastError,
        })
        .from(q.t.inboxEvent)
        .where(eq(q.t.inboxEvent.dedupeKey, dedupeKey)),
    ),
  ))!;
}

test("a session whose Linear call hangs for 120 s holds one slot for 45 s while other sessions are accepted, then retries", async () => {
  const { db, close } = await tempStore();
  const store = createInboxStore(db);
  const time = fakeDeadlines(1_000_000);
  let wakeSlow = () => {};
  const slow = new Promise<void>((resolve) => {
    wakeSlow = resolve;
  });
  const accepted: string[] = [];
  let slowCalls = 0;
  const { onEvent, queue } = createLinearIntake({
    store,
    tracker: createFakeTracker([]),
    signal: new AbortController().signal,
    deadline: (ms) => time.deadline(ms),
    now: time.now,
    log: () => {},
    followUp: async (event) => {
      if (event.sessionId === "s0" && slowCalls++ === 0) {
        await slow;
      }
      accepted.push(event.sessionId!);
    },
  });
  try {
    for (let n = 0; n < 10; n++) await store.commit(created(n));
    queue.wake();
    await waitFor(() => accepted.length === 9, { observe: () => accepted });
    expect(await row(db, created(0).dedupeKey)).toMatchObject({ handled: 0, attempts: 0 });
    time.advance(INTAKE_DEADLINE_MS);
    await waitFor(async () => (await row(db, created(0).dedupeKey)).attempts === 1);
    await queue.idle();
    expect(await row(db, created(0).dedupeKey)).toEqual({
      handled: 0,
      attempts: 1,
      nextAttemptAt: time.now() + 30_000,
      lastError: "The operation timed out.",
    });
    time.advance(30_000);
    queue.wake();
    await waitFor(async () => (await row(db, created(0).dedupeKey)).handled === 1);
    expect({ accepted, asked: [...new Set(time.asked)], slowCalls }).toEqual({
      accepted: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s0"],
      asked: [45_000],
      slowCalls: 2,
    });
  } finally {
    wakeSlow();
    await queue.stop();
    await onEvent.close();
    await close();
  }
});

test("queued duplicate prompts for one session become the newest, and created events and other prompts stay", async () => {
  const { db, close } = await tempStore();
  const store = createInboxStore(db);
  const journalled: string[] = [];
  const restore = setJournalSink((line) => journalled.push(line));
  const metrics = createMetricsRecorder({ now: () => 0 });
  const delivered: string[] = [];
  const queue = createIntakeQueue({
    store,
    metrics,
    log: () => {},
    arrive: async () => true,
    deliver: async (event) => {
      delivered.push(event.dedupeKey);
    },
  });
  try {
    await store.commit(created(0));
    await store.commit(prompted("a1", "@paws look again"));
    await store.commit(prompted("a2", "@paws look again", "webhook"));
    await store.commit(prompted("a3", "and the tests"));
    queue.wake();
    await waitFor(async () => (await row(db, "activity:a3")).handled === 1);
    await queue.idle();
    expect({
      delivered,
      handled: (await row(db, "activity:a1")).handled,
      journalled: journalled.filter((line) => line.includes("coalesced")),
      durations: metrics
        .drain(Number.MAX_SAFE_INTEGER)
        .filter((entry) => entry.name === "intake.duration")
        .map((entry) => [entry.labels.outcome, entry.count]),
    }).toEqual({
      delivered: ["session:s0:created", "activity:a2", "activity:a3"],
      handled: 1,
      journalled: ["linear intake activity:a1 coalesced into activity:a2"],
      durations: [
        ["handled", 3],
        ["coalesced", 1],
      ],
    });
  } finally {
    restore();
    await queue.stop();
    await close();
  }
});
