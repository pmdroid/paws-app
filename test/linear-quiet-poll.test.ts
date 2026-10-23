import { createHmac } from "node:crypto";
import { describe, expect, test } from "bun:test";
import {
  createInboxStore,
  createIntakePollSource,
  handleLinearWebhook,
  startCatchUpPoller,
  type InboxStore,
  type Sleeper,
} from "../src/linear";
import { insertQueuedItem, linearWebhookWarning } from "../src/db";
import { tempDb } from "./helpers";

const NOW = 1_700_000_000_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("catch-up poll in a quiet workspace", () => {
  test("a workspace with no Linear activity for 3 hours makes at most 20 poll requests", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    expect((await deliver(store, NOW, "secret")).status).toBe(200);
    const clock = fakeClock(NOW, NOW + 3 * HOUR);
    const requests = countingSource(() => emptyData());
    const poller = startCatchUpPoller({
      source: requests.source,
      store,
      onEvent: () => {},
      sleeper: clock.sleeper,
      now: clock.now,
      mono: clock.mono,
    });
    await clock.done;
    await poller.stop();
    db.close();
    expect(requests.count()).toBeGreaterThan(0);
    expect(requests.count()).toBeLessThanOrEqual(20);
  });

  test("after a restart with a recent verified webhook stored, one catch-up pass then the backstop", async () => {
    const db = tempDb();
    expect((await deliver(createInboxStore(db), NOW, "secret")).status).toBe(200);
    const restarted = createInboxStore(db);
    const waits: number[] = [];
    const requests = countingSource(() => emptyData());
    const poller = startCatchUpPoller({
      source: requests.source,
      store: restarted,
      onEvent: () => {},
      sleeper: recordingSleeper(waits),
      now: () => NOW + 30 * MINUTE,
      mono: () => 0,
    });
    await waitFor(() => waits.length > 0);
    await poller.stop();
    db.close();
    expect(requests.count()).toBe(1);
    expect(waits).toEqual([12 * MINUTE]);
  });

  test("repeated webhook verification failures switch to polling once a minute", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    expect((await deliver(store, NOW, "secret")).status).toBe(200);
    for (const _ of [1, 2, 3]) {
      expect((await deliver(store, NOW + MINUTE, "rotated")).status).toBe(401);
    }
    const waits: number[] = [];
    const poller = startCatchUpPoller({
      source: countingSource(() => emptyData()).source,
      store,
      onEvent: () => {},
      sleeper: recordingSleeper(waits),
      now: () => NOW + 2 * MINUTE,
      mono: () => 0,
    });
    await waitFor(() => waits.length > 0);
    await poller.stop();
    db.close();
    expect(waits).toEqual([MINUTE]);
  });

  test("no verified webhook since setup polls once a minute, never faster", async () => {
    const db = tempDb();
    const waits: number[] = [];
    const poller = startCatchUpPoller({
      source: countingSource(() => emptyData()).source,
      store: createInboxStore(db),
      onEvent: () => {},
      sleeper: recordingSleeper(waits),
      now: () => NOW,
      mono: () => 0,
    });
    await waitFor(() => waits.length > 0);
    await poller.stop();
    db.close();
    expect(waits).toEqual([MINUTE]);
  });

  test("a prompt the poll finds on a known session that no webhook delivered polls once a minute", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    expect((await deliver(store, NOW, "secret")).status).toBe(200);
    const waits: number[] = [];
    const poller = startCatchUpPoller({
      source: countingSource(() => ({
        ...emptyData(),
        agentActivities: {
          nodes: [
            {
              id: "activity-missed",
              createdAt: new Date(NOW + 5 * MINUTE).toISOString(),
              updatedAt: new Date(NOW + 5 * MINUTE).toISOString(),
              user: { id: "human" },
              signal: null,
              agentSession: { id: "session-webhook", issue: { id: "iss_webhook" } },
              content: { __typename: "AgentActivityPromptContent", body: "hi", type: "prompt" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      })).source,
      store,
      onEvent: () => {},
      sleeper: recordingSleeper(waits),
      now: () => NOW + 20 * MINUTE,
      mono: () => 0,
    });
    await waitFor(() => waits.length > 0);
    await poller.stop();
    expect(store.get("activity:activity-missed")).not.toBeNull();
    db.close();
    expect(waits).toEqual([MINUTE]);
  });

  test("missed deliveries found by the catch-up poll raise the webhook may be disabled warning", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    expect((await deliver(store, NOW, "secret")).status).toBe(200);
    expect(linearWebhookWarning(db, NOW + MINUTE)).toBeNull();
    const missed = startCatchUpPoller({
      source: countingSource(() => missedPrompt()).source,
      store,
      onEvent: () => {},
      sleeper: recordingSleeper([]),
      now: () => NOW + 20 * MINUTE,
      mono: () => 0,
    });
    await waitFor(() => store.get("activity:activity-missed") !== null);
    await missed.stop();
    expect(linearWebhookWarning(db, NOW + 20 * MINUTE)).toEqual({
      reason: "missed",
      lastVerifiedMs: NOW,
      missedMs: NOW + 20 * MINUTE,
    });

    const waits: number[] = [];
    const restarted = startCatchUpPoller({
      source: countingSource(() => emptyData()).source,
      store: createInboxStore(db),
      onEvent: () => {},
      sleeper: recordingSleeper(waits),
      now: () => NOW + 21 * MINUTE,
      mono: () => 0,
    });
    await waitFor(() => waits.length > 0);
    await restarted.stop();
    expect(waits).toEqual([MINUTE]);

    expect((await deliver(store, NOW + 22 * MINUTE, "secret")).status).toBe(200);
    expect(linearWebhookWarning(db, NOW + 22 * MINUTE)).toBeNull();
    db.close();
  });

  test("an hour without a verified delivery warns only while sessions are active", async () => {
    const db = tempDb();
    expect((await deliver(createInboxStore(db), NOW, "secret")).status).toBe(200);
    expect(linearWebhookWarning(db, NOW + 2 * HOUR)).toBeNull();
    insertQueuedItem(db, { id: "item", sessionKey: "session-webhook" });
    expect(linearWebhookWarning(db, NOW + HOUR)).toBeNull();
    expect(linearWebhookWarning(db, NOW + 2 * HOUR)).toEqual({
      reason: "silent",
      lastVerifiedMs: NOW,
      missedMs: null,
    });
    db.run("UPDATE work_item SET state = 'merged'");
    expect(linearWebhookWarning(db, NOW + 2 * HOUR)).toBeNull();
    db.close();
  });
});

let deliveries = 0;

function deliver(store: InboxStore, at: number, signingSecret: string): Promise<Response> {
  deliveries += 1;
  const body = JSON.stringify({
    type: "AgentSessionEvent",
    action: "created",
    webhookTimestamp: at,
    agentSession: { id: "session-webhook", issueId: "iss_webhook" },
  });
  return handleLinearWebhook(
    new Request("http://127.0.0.1/webhooks/linear", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "linear-signature": createHmac("sha256", signingSecret).update(body).digest("hex"),
        "linear-delivery": `delivery-${deliveries}`,
      },
      body,
    }),
    "secret",
    { store, now: () => at },
  );
}

function missedPrompt(): Record<string, unknown> {
  return {
    ...emptyData(),
    agentActivities: {
      nodes: [
        {
          id: "activity-missed",
          createdAt: new Date(NOW + 5 * MINUTE).toISOString(),
          updatedAt: new Date(NOW + 5 * MINUTE).toISOString(),
          user: { id: "human" },
          signal: null,
          agentSession: { id: "session-webhook", issue: { id: "iss_webhook" } },
          content: { __typename: "AgentActivityPromptContent", body: "hi", type: "prompt" },
        },
      ],
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function emptyData(): Record<string, unknown> {
  return {
    viewer: { id: "app_1" },
    issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    comments: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
    agentActivities: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
  };
}

function countingSource(data: () => unknown) {
  let requests = 0;
  const source = createIntakePollSource(
    {
      async query() {
        requests += 1;
        return data();
      },
    },
    { teamId: "team_1" },
  );
  return { source, count: () => requests };
}

function fakeClock(start: number, end: number) {
  let clock = start;
  let finish: () => void = () => {};
  let release: () => void = () => {};
  const done = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const sleeper: Sleeper = {
    async wait(ms) {
      clock += ms;
      if (clock < end) return;
      finish();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    wake() {
      release();
    },
  };
  return { sleeper, done, now: () => clock, mono: () => clock - start };
}

function recordingSleeper(waits: number[]): Sleeper {
  let release: () => void = () => {};
  return {
    wait(ms) {
      waits.push(ms);
      return new Promise<void>((resolve) => {
        release = resolve;
      });
    },
    wake() {
      release();
    },
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error("condition not met");
}
