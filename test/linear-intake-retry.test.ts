import { expect, test } from "bun:test";
import { pawsPaths } from "../src/config";
import { openPawsStore } from "../src/db";
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
import { migratedHome } from "./helpers";

test.each(["session", null])(
  "replays failed intake after reopening the store for %s",
  async (sessionId) => {
    const home = await migratedHome();
    const reopen = () => openPawsStore({ url: null, pgliteDir: pawsPaths(home).pgliteDir });
    let database = await reopen();
    let db = database.store;
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
    await store.commit(event);
    let attempts = 0;
    const items = () =>
      db.run((q) => q.all(q.orm.select({ id: q.t.workItem.id }).from(q.t.workItem)));
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
        db: db,
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
            await intakeDelegatedIssue(db, tracker, {
              linearIssueId: "issue",
              sessionId,
            });
          }),
      });
      await paused;
      await poller.stop();
      await poller.settled;
    }
    try {
      await tick(true);
      expect(attempts).toBe(1);
      expect((await store.listUnhandled()).map((pending) => pending.dedupeKey)).toEqual([
        event.dedupeKey,
      ]);
      expect(await items()).toHaveLength(0);
      if (sessionId) expect(tracker.progress.at(-1)?.kind).toBe("error");
      await database.close();
      database = await reopen();
      db = database.store;
      store = createInboxStore(db);
      await tick(false);
      expect(attempts).toBe(2);
      expect(await store.listUnhandled()).toHaveLength(0);
      expect(await items()).toHaveLength(1);
      await tick(false);
      expect(attempts).toBe(2);
    } finally {
      await database.close();
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
