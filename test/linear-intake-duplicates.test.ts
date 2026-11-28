import { afterEach, expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { insertInboxEvent, type Db } from "../src/db";
import { setJournalSink } from "../src/journal";
import {
  createFakeTracker,
  createInboxStore,
  createLinearIntake,
  startCatchUpPoller,
  type AcceptedLinearEvent,
  type IntakeSighting,
  type PolledActivity,
} from "../src/linear";
import { tempStore } from "./pglite";
import { waitFor } from "./wait-for";

let cleanup: (() => Promise<void>)[] = [];

afterEach(async () => {
  for (const close of cleanup.reverse()) await close();
  cleanup = [];
});

const T0 = Date.parse("2026-11-28T00:40:00Z");

function webhookCreated(): AcceptedLinearEvent {
  const payload = JSON.stringify({
    type: "AgentSessionEvent",
    action: "created",
    agentSession: { id: "s1", issue: { id: "issue-1", identifier: "PAS-1" } },
    agentActivity: { id: "a1", content: { type: "prompt", body: "Work on PAS-1" } },
  });
  return {
    dedupeKey: "session:s1:created",
    deliveryId: "delivery-1",
    source: "webhook",
    action: "created",
    sessionId: "s1",
    issueId: "issue-1",
    activityId: "a1",
    body: "Work on PAS-1",
    signal: null,
    updatedAtMs: T0,
    payload,
  };
}

function activity(id: string, body: string): PolledActivity {
  return { id, issueId: "issue-1", sessionId: "s1", body, signal: null, updatedAtMs: T0 + 1_000 };
}

function sighting(activities: PolledActivity[], withIssue = true): IntakeSighting {
  return {
    sessions: [{ id: "s1", issueId: "issue-1", createdAtMs: T0, updatedAtMs: T0 + 1_000 }],
    issues: withIssue
      ? [
          {
            id: "issue-1",
            identifier: "PAS-1",
            updatedAtMs: T0 + 1_000,
            labeled: false,
            delegated: true,
          },
        ]
      : [],
    comments: [],
    activities,
    budget: null,
    caughtUp: true,
    queried: true,
  };
}

async function fixture(now = () => T0 + 60_000) {
  const { db, close } = await tempStore();
  const inbox = createInboxStore(db);
  const commits: AcceptedLinearEvent[] = [];
  const store = {
    ...inbox,
    commit: (event: AcceptedLinearEvent) => (commits.push(event), inbox.commit(event)),
  };
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue-1",
      identifier: "PAS-1",
      title: "Task",
      description: null,
      subIssues: [],
    },
  ]);
  const intakes: AcceptedLinearEvent[] = [];
  const { onEvent, queue } = createLinearIntake({
    store,
    tracker,
    signal: new AbortController().signal,
    followUp: async (event) => {
      intakes.push(event);
    },
    pollMs: 5,
  });
  let next = sighting([]);
  const poller = startCatchUpPoller({
    source: { poll: async () => next },
    store,
    intake: queue,
    onEvent,
    db,
    timer: false,
    now,
  });
  cleanup.push(async () => {
    await poller.stop();
    await queue.stop();
    await onEvent.close();
    await close();
  });
  const lines: string[] = [];
  const restore = setJournalSink((line) => lines.push(line));
  cleanup.push(async () => restore());
  return {
    db,
    store,
    intakes,
    commits,
    lines,
    async webhook(event: AcceptedLinearEvent) {
      const committed = await store.commit(event);
      if (committed.inserted) queue.arrive(event);
    },
    async poll(sight: IntakeSighting, expected: string[]) {
      next = sight;
      await poller.pollNow();
      await waitFor(async () => (await queued(db)) === 0 && intakes.length >= expected.length, {
        observe: () => intakes.map((event) => event.dedupeKey),
      });
      await queue.idle();
      expect(intakes.map((event) => event.dedupeKey).sort()).toEqual(expected);
    },
  };
}

async function queued(db: Db): Promise<number> {
  const [row] = await db.run((q) =>
    q.all(q.orm.select({ n: count() }).from(q.t.inboxEvent).where(eq(q.t.inboxEvent.handled, 0))),
  );
  return row!.n;
}

test("a webhook created, a poll created and a poll prompted for the same activity become one intake", async () => {
  const f = await fixture();
  await f.webhook(webhookCreated());
  await f.poll(sighting([activity("a1", "Work on PAS-1")]), ["session:s1:created"]);
  expect(await f.store.get("issue:issue-1:intake")).not.toBeNull();
  expect(f.lines).toContain("merged duplicate poll created for session s1 into session:s1:created");
  expect(f.lines).toContain(
    "merged duplicate poll prompted for session s1 into session:s1:created",
  );

  await f.poll(sighting([activity("a2", "Also add a test")]), [
    "activity:a2",
    "session:s1:created",
  ]);
});

test("a webhook created after the poll's issue intake merges into it", async () => {
  const f = await fixture();
  await f.poll(sighting([]), ["issue:issue-1:intake"]);
  await f.webhook(webhookCreated());
  await f.poll(sighting([]), ["issue:issue-1:intake"]);
});

test("the poller does not re-queue a session the webhook delivered 5 minutes ago", async () => {
  const f = await fixture(() => Date.now() + 5 * 60_000);
  await f.webhook(webhookCreated());
  const recent = sighting([], false);
  await f.poll({ ...recent, sessions: [{ ...recent.sessions[0]!, updatedAtMs: Date.now() }] }, [
    "session:s1:created",
  ]);
  expect(f.commits.filter((event) => event.source === "poll")).toEqual([]);
  expect(await f.store.get("session:s1:created")).toMatchObject({ source: "webhook" });
});

test("duplicates queued before the merge are merged on the next pass, and other sessions stay", async () => {
  const f = await fixture();
  const row = (event: AcceptedLinearEvent, receivedAt: number) => ({ ...event, receivedAt });
  await insertInboxEvent(f.db, row(webhookCreated(), 1));
  await insertInboxEvent(
    f.db,
    row(
      {
        ...webhookCreated(),
        dedupeKey: "issue:issue-1:intake",
        source: "poll",
        deliveryId: null,
        activityId: null,
      },
      2,
    ),
  );
  await insertInboxEvent(
    f.db,
    row(
      {
        ...webhookCreated(),
        dedupeKey: "session:s2:created",
        sessionId: "s2",
        issueId: "issue-2",
        deliveryId: "delivery-2",
        activityId: null,
      },
      3,
    ),
  );
  await f.poll({ ...sighting([], false), sessions: [] }, [
    "session:s1:created",
    "session:s2:created",
  ]);
});

test("a merged alias never suppresses the event it merged into, and a newer webhook payload joins the queued intake", async () => {
  const f = await fixture();
  const pollIntake: AcceptedLinearEvent = {
    ...webhookCreated(),
    dedupeKey: "issue:issue-1:intake",
    source: "poll",
    deliveryId: null,
    activityId: null,
    body: null,
    payload: JSON.stringify({ kind: "intake", mode: "delegate", identifier: "PAS-1" }),
  };
  expect(await f.store.commit(webhookCreated())).toEqual({ inserted: true, handled: false });
  expect(await f.store.commit(pollIntake)).toEqual({ inserted: false, handled: true });
  expect(await f.store.duplicateOf("session:s1:created")).toBeNull();

  const g = await fixture();
  await g.store.commit(pollIntake);
  await g.store.commit(webhookCreated());
  expect(await g.store.duplicateOf("issue:issue-1:intake")).toBeNull();
  const survivor = (await g.store.get("issue:issue-1:intake"))!;
  expect(survivor).toMatchObject({ activityId: "a1", body: "Work on PAS-1", actorId: null });
  expect(JSON.parse(survivor.payload)).toMatchObject({
    mode: "delegate",
    agentActivity: { id: "a1" },
  });
});

test("a polled session created merges into its issue intake, but a stale re-intake and a late session do not", async () => {
  const f = await fixture();
  const pollIntake: AcceptedLinearEvent = {
    ...webhookCreated(),
    dedupeKey: "issue:issue-1:intake",
    source: "poll",
    deliveryId: null,
    activityId: null,
    payload: JSON.stringify({ kind: "intake", mode: "delegate" }),
  };
  const polled: AcceptedLinearEvent = {
    ...webhookCreated(),
    source: "poll",
    deliveryId: null,
    activityId: null,
    payload: JSON.stringify({ kind: "session" }),
  };
  await f.store.commit(pollIntake);
  expect(await f.store.commit(polled)).toEqual({ inserted: false, handled: true });
  const g = await fixture();
  await g.store.commit(pollIntake);
  const stale = { ...polled, payload: JSON.stringify({ kind: "session", reason: "stale" }) };
  expect(await g.store.commit(stale)).toEqual({ inserted: true, handled: false });
  const h = await fixture();
  await h.store.commit({ ...pollIntake, sessionId: null });
  expect(await h.store.commit(polled)).toEqual({ inserted: true, handled: false });
});
