import { expect, test } from "bun:test";
import { join } from "node:path";
import { migrate, openDatabase } from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import {
  acknowledgeNewSession,
  LinearHttpError,
  createFakeTracker,
  createInboxStore,
  startCatchUpPoller,
  type AcceptedLinearEvent,
  type Sleeper,
} from "../src/linear";
import { tempHome } from "./helpers";

test.each(["session", null])(
  "replays failed intake after reopening SQLite for %s",
  async (sessionId) => {
    const path = join(tempHome(), "paws.db");
    let db = openDatabase(path);
    migrate(db);
    const event: AcceptedLinearEvent = {
      dedupeKey: "created:retry",
      deliveryId: null,
      source: "poll",
      action: "created",
      sessionId,
      issueId: "issue",
      activityId: null,
      body: null,
      signal: null,
      updatedAtMs: 1,
      payload: "{}",
    };
    const tracker = createFakeTracker([
      {
        linearIssueId: "issue",
        identifier: "ENG-1",
        title: "Retry",
        description: null,
        subIssues: [],
      },
    ]);
    let store = createInboxStore(db);
    store.commit(event);
    let attempts = 0;
    async function tick(fail: boolean) {
      let release: (() => void) | undefined;
      let sleeping: (() => void) | undefined;
      const paused = new Promise<void>((resolve) => {
        sleeping = resolve;
      });
      const sleeper: Sleeper = {
        wait: () =>
          new Promise<void>((resolve) => {
            release = resolve;
            sleeping?.();
          }),
        wake: () => release?.(),
      };
      const poller = startCatchUpPoller({
        db,
        store,
        sleeper,
        source: {
          poll: async () => ({
            queried: false,
            caughtUp: false,
            budget: null,
            issues: [],
            sessions: [],
            comments: [],
            activities: [],
          }),
        },
        onEvent: (accepted) =>
          acknowledgeNewSession(tracker, accepted, async () => {
            attempts += 1;
            if (fail) throw new Error("scripted intake failure");
            await intakeDelegatedIssue(db, tracker, { linearIssueId: "issue", sessionId });
          }),
      });
      await paused;
      await poller.stop();
      await poller.settled;
    }
    try {
      await tick(true);
      expect(attempts).toBe(1);
      expect(store.listUnhandled().map((pending) => pending.dedupeKey)).toEqual([event.dedupeKey]);
      expect(db.query("SELECT id FROM work_item").all()).toHaveLength(0);
      if (sessionId) expect(tracker.progress.at(-1)?.kind).toBe("error");
      db.close();
      db = openDatabase(path);
      store = createInboxStore(db);
      await tick(false);
      expect(attempts).toBe(2);
      expect(store.listUnhandled()).toHaveLength(0);
      expect(db.query("SELECT id FROM work_item").all()).toHaveLength(1);
      await tick(false);
      expect(attempts).toBe(2);
    } finally {
      db.close();
    }
  },
);

test("retains the intake error when posting its error activity fails", async () => {
  const tracker = createFakeTracker();
  tracker.postProgress = async () => {
    throw new Error("report failed");
  };
  const original = new Error("intake failed");
  await expect(
    acknowledgeNewSession(
      tracker,
      {
        dedupeKey: "activity:retry",
        deliveryId: null,
        source: "poll",
        action: "prompted",
        sessionId: "session",
        issueId: "issue",
        activityId: "retry",
        body: "request",
        signal: null,
        updatedAtMs: 1,
        payload: "{}",
      },
      async () => {
        throw original;
      },
    ),
  ).rejects.toBe(original);
});

test("a transient Linear failure during follow-up never posts a terminal error", async () => {
  const tracker = createFakeTracker();
  const error = new LinearHttpError(503, "", new Headers());
  await expect(
    acknowledgeNewSession(
      tracker,
      {
        dedupeKey: "activity:503",
        deliveryId: null,
        source: "poll",
        action: "prompted",
        sessionId: "session",
        issueId: "issue",
        activityId: "503",
        body: "request",
        signal: null,
        updatedAtMs: 1,
        payload: "{}",
      },
      async () => {
        throw error;
      },
    ),
  ).rejects.toBe(error);
  expect(tracker.progress.filter((update) => update.kind === "error")).toEqual([]);
});
