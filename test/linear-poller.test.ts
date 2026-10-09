import { describe, expect, test } from "bun:test";
import { createLinearCatchUpSource, sessionCreatedKey } from "../src/linear";
import type { CatchUpSource, LinearClient } from "../src/linear";
import { createInboxStore } from "../src/linear";
import {
  POLL_INTERVAL_DOWN_MS,
  POLL_INTERVAL_UP_MS,
  WAKE_GAP_MS,
  pollIntervalMs,
  sleepGapMs,
  startCatchUpPoller,
  type Sleeper,
} from "../src/linear";
import { tempDb } from "./helpers";

describe("linear catch-up", () => {
  test("polls on start, every 60s with the tunnel up, every 3s when it is down, and on wake", async () => {
    expect(pollIntervalMs(true)).toBe(POLL_INTERVAL_UP_MS);
    expect(pollIntervalMs(false)).toBe(POLL_INTERVAL_DOWN_MS);
    expect(
      sleepGapMs({ previousWallMs: 0, previousMonoMs: 0, wallMs: 120_000, monoMs: 1_000 }),
    ).toBeGreaterThan(WAKE_GAP_MS);

    const db = tempDb();
    const store = createInboxStore(db);
    const seen: string[] = [];
    let tunnelUp = true;
    let wall = 1_000_000;
    const waits: number[] = [];
    const gate: { release: (() => void) | null } = { release: null };
    const sleeper: Sleeper = {
      wait(ms) {
        waits.push(ms);
        return new Promise<void>((resolve) => {
          gate.release = resolve;
        });
      },
      wake() {
        gate.release?.();
        gate.release = null;
      },
    };
    const source: CatchUpSource = {
      async listUpdated() {
        return [];
      },
    };
    const poller = startCatchUpPoller({
      source,
      store,
      onEvent: (event) => {
        seen.push(event.dedupeKey);
      },
      tunnelUp: () => tunnelUp,
      sleeper,
      now: () => wall,
      mono: () => 0,
    });
    await waitFor(() => waits.length > 0);
    expect(waits).toEqual([POLL_INTERVAL_UP_MS]);
    tunnelUp = false;
    gate.release?.();
    await waitFor(() => waits.length > 1);
    expect(waits[1]).toBe(POLL_INTERVAL_DOWN_MS);
    wall += 120_000;
    poller.noteWake();
    await waitFor(() => waits.length > 2);
    expect(waits[2]).toBe(POLL_INTERVAL_DOWN_MS);
    expect(seen).toEqual([]);
    poller.stop();
    await poller.settled;
    db.close();
  });

  test("feeds new sessions and prompts through the inbox once", async () => {
    const db = tempDb();
    const store = createInboxStore(db);
    const handled: string[] = [];
    const source = createLinearCatchUpSource(scriptedClient());
    const events = await source.listUpdated(1_000);
    expect(events.map((event) => event.dedupeKey)).toEqual([
      sessionCreatedKey("ses_new"),
      "activity:act_prompt",
    ]);
    const poller = startCatchUpPoller({
      source: { listUpdated: async () => events },
      store,
      onEvent: async (event) => {
        handled.push(event.dedupeKey);
      },
      tunnelUp: () => true,
      sleeper: blockedSleeper(),
      now: () => 5_000,
    });
    await waitFor(() => handled.length === 2);
    expect(store.listUnhandled()).toHaveLength(0);
    expect(store.getCursor("linear")).toBe(5_000);
    poller.noteWake();
    await Bun.sleep(20);
    expect(handled).toEqual([sessionCreatedKey("ses_new"), "activity:act_prompt"]);
    poller.stop();
    await poller.settled;
    db.close();
  });
});

function blockedSleeper(): Sleeper {
  let resolveWait: (() => void) | null = null;
  return {
    wait: () =>
      new Promise((resolve) => {
        resolveWait = resolve;
      }),
    wake() {
      resolveWait?.();
      resolveWait = null;
    },
  };
}

function scriptedClient(): LinearClient {
  return {
    async query(query) {
      if (query.includes("agentSessions")) {
        return {
          agentSessions: {
            nodes: [
              {
                id: "ses_old",
                createdAt: "1970-01-01T00:00:00.000Z",
                updatedAt: "1970-01-01T00:00:01.000Z",
                issue: { id: "old" },
              },
              {
                id: "ses_new",
                createdAt: "1970-01-01T00:00:02.000Z",
                updatedAt: "1970-01-01T00:00:02.000Z",
                issue: { id: "iss_new" },
              },
            ],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        };
      }
      return {
        agentActivities: {
          nodes: [
            {
              id: "act_thought",
              updatedAt: "1970-01-01T00:00:03.000Z",
              signal: null,
              agentSession: { id: "ses_new", issue: { id: "iss_new" } },
              content: {
                __typename: "AgentActivityThoughtContent",
                body: "thinking",
                type: "thought",
              },
            },
            {
              id: "act_prompt",
              updatedAt: "1970-01-01T00:00:04.000Z",
              signal: "stop",
              agentSession: { id: "ses_new", issue: { id: "iss_new" } },
              content: { __typename: "AgentActivityPromptContent", body: "stop", type: "prompt" },
            },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      };
    },
  };
}

async function waitFor(ready: () => boolean): Promise<void> {
  const deadline = Date.now() + 1_000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for the poller");
    await Bun.sleep(10);
  }
}
