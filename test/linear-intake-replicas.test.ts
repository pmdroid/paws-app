import { expect, test } from "bun:test";
import { count, eq } from "drizzle-orm";
import { openPawsStore } from "../src/db";
import {
  INTAKE_LEASE_MS,
  POLL_INTERVAL_FAILING_MS,
  POLL_INTERVAL_WEBHOOK_MS,
  createInboxStore,
  createIntakeQueue,
  handleLinearWebhook,
  pollIntervalMs,
  webhookVerificationFailures,
  type AcceptedLinearEvent,
  type InboxStore,
  type IntakeQueue,
} from "../src/linear";
import { pgliteServer } from "./pglite";

async function replicas() {
  const server = await pgliteServer();
  const other = await openPawsStore({ url: server.url, pgliteDir: "" });
  return {
    first: server.store,
    second: other.store,
    async close() {
      await other.close();
      await server.close();
    },
  };
}

function linearEvent(
  session: string,
  action: "created" | "prompted",
  activity: string | null = null,
): AcceptedLinearEvent {
  return {
    dedupeKey: activity === null ? `session:${session}:created` : `activity:${activity}`,
    deliveryId: `delivery-${activity ?? session}`,
    source: "webhook",
    action,
    sessionId: session,
    issueId: `issue-${session}`,
    activityId: activity,
    body: activity === null ? null : `Follow-up ${activity} for Acme`,
    signal: null,
    updatedAtMs: 1,
    payload: JSON.stringify({ agentSession: { id: session, issue: { identifier: "ACME-1" } } }),
  };
}

function instance(
  name: string,
  store: InboxStore,
  now: () => number,
  delivered: string[],
  deliver: (event: AcceptedLinearEvent) => Promise<void> = () => Bun.sleep(5),
): IntakeQueue {
  return createIntakeQueue({
    store,
    owner: name,
    now,
    log: () => {},
    arrive: async () => {
      await Bun.sleep(2);
      return true;
    },
    deliver: async (event) => {
      delivered.push(`${name} ${event.dedupeKey}`);
      await deliver(event);
    },
  });
}

test("two instances receiving the same events handle each one once, in session order", async () => {
  const { first, second, close } = await replicas();
  const stores = [createInboxStore(first), createInboxStore(second)] as const;
  const delivered: string[] = [];
  const queues = [
    instance("acme-a", stores[0], Date.now, delivered),
    instance("acme-b", stores[1], Date.now, delivered),
  ] as const;
  const events = [
    linearEvent("acme-s1", "created"),
    linearEvent("acme-s2", "created"),
    linearEvent("acme-s1", "prompted", "acme-p1"),
    linearEvent("acme-s1", "prompted", "acme-p2"),
  ];
  try {
    for (const each of events) {
      for (const [n, store] of stores.entries()) {
        const committed = await store.commit(each);
        if (committed.inserted) queues[n]!.arrive(each);
        else queues[n]!.wake();
      }
      await Bun.sleep(1);
    }
    const unhandled = async () =>
      (await first.run((q) =>
        q.one(
          q.orm.select({ n: count() }).from(q.t.inboxEvent).where(eq(q.t.inboxEvent.handled, 0)),
        ),
      ))!.n;
    while ((await unhandled()) > 0) {
      await Promise.all(queues.map((queue) => queue.idle()));
      for (const queue of queues) queue.wake();
      await Bun.sleep(5);
    }
    const keys = delivered.map((line) => line.split(" ")[1]);
    expect({
      once: [...keys].sort(),
      lane: keys.filter((key) => key !== "session:acme-s2:created"),
    }).toEqual({
      once: [
        "activity:acme-p1",
        "activity:acme-p2",
        "session:acme-s1:created",
        "session:acme-s2:created",
      ],
      lane: ["session:acme-s1:created", "activity:acme-p1", "activity:acme-p2"],
    });
  } finally {
    await Promise.all(queues.map((queue) => queue.stop()));
    await close();
  }
});

test("an instance that dies mid-intake loses its lease, and the other takes the event after two minutes", async () => {
  const { first, second, close } = await replicas();
  let clock = 1_000_000;
  const delivered: string[] = [];
  let die: (reason: Error) => void = () => {};
  const dying = instance(
    "acme-a",
    createInboxStore(first),
    () => clock,
    delivered,
    () =>
      new Promise<void>((_, reject) => {
        die = reject;
      }),
  );
  const surviving = instance("acme-b", createInboxStore(second), () => clock, delivered);
  try {
    await createInboxStore(first).commit(linearEvent("acme-s1", "created"));
    dying.wake();
    while (delivered.length === 0) await Bun.sleep(1);
    clock += INTAKE_LEASE_MS - 1;
    surviving.wake();
    await surviving.idle();
    const whileLeased = [...delivered];
    clock += 1;
    surviving.wake();
    await surviving.idle();
    expect({
      whileLeased,
      delivered,
      handled: await second.run((q) =>
        q.one(
          q.orm
            .select({ handled: q.t.inboxEvent.handled, lockedBy: q.t.inboxEvent.lockedBy })
            .from(q.t.inboxEvent),
        ),
      ),
    }).toEqual({
      whileLeased: ["acme-a session:acme-s1:created"],
      delivered: ["acme-a session:acme-s1:created", "acme-b session:acme-s1:created"],
      handled: { handled: 1, lockedBy: null },
    });
  } finally {
    const stopping = dying.stop();
    die(new Error("acme-a is gone"));
    await Promise.all([stopping, surviving.stop()]);
    await close();
  }
});

test("the poller on one instance reads verification failures another instance's webhook counted", async () => {
  const { first, second, close } = await replicas();
  const receiving = createInboxStore(first);
  const polling = createInboxStore(second);
  await receiving.setCursor("linear:webhook", 1_000);
  const reject = () =>
    handleLinearWebhook(
      new Request("http://acme.test/webhooks/linear", {
        method: "POST",
        headers: { "linear-signature": "0".repeat(64) },
        body: "{}",
      }),
      "acme-secret",
      { store: receiving },
    );
  const cadence = async () =>
    pollIntervalMs({
      now: 2_000,
      lastWebhookMs: 1_000,
      webhookFailures: await webhookVerificationFailures(polling),
    });
  try {
    const before = await cadence();
    for (let n = 0; n < 3; n++) expect((await reject()).status).toBe(401);
    expect({
      before,
      failures: await webhookVerificationFailures(polling),
      after: await cadence(),
    }).toEqual({
      before: POLL_INTERVAL_WEBHOOK_MS,
      failures: 3,
      after: POLL_INTERVAL_FAILING_MS,
    });
  } finally {
    await close();
  }
});
