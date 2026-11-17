import { afterEach, expect, test } from "bun:test";
import { listWorkItems } from "../src/db";
import { intakeDelegatedIssue } from "../src/intake";
import { setJournalSink } from "../src/journal";
import {
  acknowledgeNewSession,
  createFakeTracker,
  createInboxStore,
  LinearIntakeRefusedError,
  startCatchUpPoller,
  type AcceptedLinearEvent,
  type PolledSession,
} from "../src/linear";
import { tempStore } from "./pglite";

const NOT_DELEGATED = "The issue is no longer delegated to Paws.";
let restoreJournal: (() => void) | null = null;

afterEach(() => {
  restoreJournal?.();
  restoreJournal = null;
});

function captureJournal(): string[] {
  const lines: string[] = [];
  restoreJournal = setJournalSink((line) => lines.push(line));
  return lines;
}

async function fixture(
  delegated: boolean,
  options: { updatedAgoMs?: number; withDb?: boolean } = {},
) {
  const { db, close } = await tempStore();
  const tracker = createFakeTracker([
    {
      linearIssueId: "issue",
      identifier: "ENG-1",
      title: "Task",
      description: null,
      subIssues: [],
    },
  ]);
  const store = createInboxStore(db);
  const now = Date.now();
  const session: PolledSession = {
    id: "session",
    issueId: "issue",
    createdAtMs: now - 120_000,
    updatedAtMs: now - (options.updatedAgoMs ?? 60_000),
    endedAtMs: now - 60_000,
    stoppedAtMs: null,
    stale: true,
  };
  const poller = startCatchUpPoller({
    source: {
      poll: async () => ({
        sessions: [session],
        issues: [],
        comments: [],
        activities: [],
        budget: null,
        caughtUp: true,
        queried: true,
      }),
    },
    store,
    ...(options.withDb === false ? {} : { db }),
    timer: false,
    onEvent: (event) =>
      acknowledgeNewSession(tracker, event, async (accepted) => {
        if (!delegated) throw new LinearIntakeRefusedError(NOT_DELEGATED, { quiet: true });
        await intakeDelegatedIssue(db, tracker, {
          linearIssueId: "issue",
          sessionId: accepted.sessionId,
        });
      }),
  });
  return {
    db,
    tracker,
    store,
    poller,
    async close() {
      await poller.stop();
      await close();
    },
  };
}

test("catch-up starts work for a delegation whose session went stale before any webhook", async () => {
  const f = await fixture(true);
  try {
    await f.poller.pollNow();
    const items = await listWorkItems(f.db);
    expect(items).toHaveLength(1);
    expect(items[0]!.sessionKey).toBe("session");
    await f.poller.pollNow();
    expect(await listWorkItems(f.db)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("catch-up retries a stale session whose issue intake was already handled", async () => {
  const f = await fixture(true);
  try {
    const intake: AcceptedLinearEvent = {
      dedupeKey: "issue:issue:intake",
      deliveryId: null,
      source: "poll",
      action: "created",
      sessionId: "session",
      issueId: "issue",
      activityId: null,
      body: null,
      signal: null,
      updatedAtMs: Date.now() - 90_000,
      payload: JSON.stringify({ kind: "intake", mode: "delegate", identifier: "ENG-1" }),
    };
    await f.store.commit(intake);
    await f.store.markHandled(intake.dedupeKey);
    await f.poller.pollNow();
    expect(await listWorkItems(f.db)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a stale session whose issue is no longer delegated is refused with one journal line", async () => {
  const f = await fixture(false);
  const lines = captureJournal();
  try {
    await f.poller.pollNow();
    await f.poller.pollNow();
    expect(await listWorkItems(f.db)).toHaveLength(0);
    expect(lines.filter((line) => line.includes(NOT_DELEGATED))).toEqual([
      `linear intake issue session session refused: ${NOT_DELEGATED}`,
    ]);
  } finally {
    await f.close();
  }
});

test("a quiet refusal posts nothing to Linear and still writes a journal line", async () => {
  const lines = captureJournal();
  const tracker = createFakeTracker([]);
  const event: AcceptedLinearEvent = {
    dedupeKey: "session:quiet:created",
    deliveryId: "delivery",
    source: "webhook",
    action: "created",
    sessionId: "quiet",
    issueId: "issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 1,
    payload: "{}",
  };
  const accepted = await acknowledgeNewSession(tracker, event, async () => {
    throw new LinearIntakeRefusedError(NOT_DELEGATED, { quiet: true });
  });
  expect(accepted).toBe(false);
  expect(tracker.progress.map((update) => update.kind)).toEqual(["thought"]);
  expect(lines).toEqual([`linear intake issue session quiet refused: ${NOT_DELEGATED}`]);
});

test("catch-up recovers a stale session last updated before the poll window", async () => {
  const f = await fixture(true, { updatedAgoMs: 3 * 60 * 60_000 });
  try {
    await f.poller.pollNow();
    expect(await listWorkItems(f.db)).toHaveLength(1);
  } finally {
    await f.close();
  }
});

test("a poll without a database cannot tell a stale session has no work, so it starts none", async () => {
  const f = await fixture(true, { withDb: false });
  try {
    await f.poller.pollNow();
    expect(await listWorkItems(f.db)).toHaveLength(0);
  } finally {
    await f.close();
  }
});

test("a refusal is journaled even when its Linear reply fails", async () => {
  const lines = captureJournal();
  const tracker = createFakeTracker([]);
  const event: AcceptedLinearEvent = {
    dedupeKey: "session:loud:created",
    deliveryId: "delivery",
    source: "webhook",
    action: "created",
    sessionId: "loud",
    issueId: "issue",
    activityId: null,
    body: null,
    signal: null,
    updatedAtMs: 1,
    payload: "{}",
  };
  const failing = {
    ...tracker,
    postProgress: async (update: Parameters<typeof tracker.postProgress>[0]) => {
      if (update.kind === "error") throw new Error("Linear is down");
      await tracker.postProgress(update);
    },
  };
  await expect(
    acknowledgeNewSession(failing, event, async () => {
      throw new LinearIntakeRefusedError(NOT_DELEGATED);
    }),
  ).rejects.toThrow("Linear is down");
  expect(lines).toEqual([`linear intake issue session loud refused: ${NOT_DELEGATED}`]);
});
