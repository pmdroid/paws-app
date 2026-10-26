import { afterEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import {
  beginImplementRun,
  enqueueOutbox,
  enqueueOutboxOnce,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  migrate,
  openDatabase,
} from "../src/db";
import {
  acknowledgeNewSession,
  createFakeTracker,
  FIRST_ACTIVITY_BODY,
  sessionHasItemInFlight,
  type AcceptedLinearEvent,
} from "../src/linear";
import { ask } from "../src/loop";

const open: Database[] = [];
afterEach(() => {
  for (const db of open.splice(0)) db.close();
});

function database(): Database {
  const db = openDatabase(":memory:");
  migrate(db);
  open.push(db);
  return db;
}

function thought(db: Database, key: string, body: string, ephemeral = false): number {
  return enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: "ses-1",
    idempotencyKey: key,
    payload: { sessionId: "ses-1", kind: "thought", body, ...(ephemeral ? { ephemeral } : {}) },
  });
}

const bodies = (db: Database) =>
  listOutbox(db, "ses-1")
    .filter((row) => row.status !== "dropped")
    .map((row) => (row.payload as { body?: string }).body);

describe("lifecycle lines", () => {
  test("a thought that repeats the last sent or pending thought is not enqueued", () => {
    const db = database();
    const fix = "Fixing Closeout findings for PAS-619 (1 of 3).";
    const first = thought(db, "fix:1", fix);
    // The resumed fix path and the keepalive say the same line again.
    expect(thought(db, "fix:2", fix)).toBe(first);
    expect(thought(db, "keep:1", fix, true)).toBe(first);
    db.run("UPDATE outbox SET status = 'sent', sent_at = 1 WHERE id = ?", [first]);
    expect(thought(db, "fix:3", fix)).toBe(first);
    // A repeated idempotency key still returns its own row.
    expect(thought(db, "fix:1", fix)).toBe(first);
    expect(bodies(db)).toEqual([fix]);

    thought(db, "runtime:1", "Starting on agentbox in pmdroid/paws-app, bun 1.4.2.");
    thought(db, "runtime:2", "Starting on agentbox in pmdroid/paws-app, bun 1.4.2.");
    // A different line in between makes the earlier line news again.
    thought(db, "fix:4", fix);
    expect(bodies(db)).toEqual([fix, "Starting on agentbox in pmdroid/paws-app, bun 1.4.2.", fix]);
  });

  test("a response starts a new phase, and an ephemeral line Linear already shows may repeat", () => {
    const db = database();
    thought(db, "a", "Verifying PAS-1.");
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-1",
      idempotencyKey: "error",
      delivery: "ordered",
      payload: { sessionId: "ses-1", kind: "error", body: "Closeout could not start." },
    });
    thought(db, "b", "Verifying PAS-1.");
    const keep = thought(db, "keep:1", "Step 2 of 5: rank runners.", true);
    db.run("UPDATE outbox SET status = 'sent', sent_at = 1 WHERE id = ?", [keep]);
    expect(thought(db, "keep:2", "Step 2 of 5: rank runners.", true)).not.toBe(keep);
    expect(bodies(db)).toEqual([
      "Verifying PAS-1.",
      "Closeout could not start.",
      "Verifying PAS-1.",
      "Step 2 of 5: rank runners.",
      "Step 2 of 5: rank runners.",
    ]);
  });
});

describe("a waiting question", () => {
  function waiting(db: Database) {
    insertQueuedItem(db, { id: "item-q", sessionKey: "ses-1", now: 0 });
    beginImplementRun(db, "item-q", 1_000);
    const item = getWorkItem(db, "item-q")!;
    ask(
      db,
      { itemId: item.id, runId: item.currentRunId, sessionId: "ses-1", version: item.version },
      "agent",
      "Which repository?",
      { options: ["paws-app", "paws-runner"], now: 2_000 },
    );
    expect(getWorkItem(db, "item-q")?.state).toBe("awaiting_input");
  }

  const errorActivity = (db: Database, key: string) =>
    enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-1",
      idempotencyKey: key,
      payload: { sessionId: "ses-1", kind: "error", body: "Paws could not start work." },
    });

  test("a critical error does not drop its elicitation while the item still waits", () => {
    const db = database();
    waiting(db);
    errorActivity(db, "error:1");
    const elicitation = listOutbox(db, "ses-1").find((row) => row.op === "elicitation");
    expect(elicitation?.status).toBe("pending");
    // A redelivery after the error is not refused by the session fence either.
    const again = enqueueOutboxOnce(db, {
      target: "linear",
      op: "elicitation",
      orderingKey: "ses-1",
      idempotencyKey: `${elicitation!.idempotencyKey}:redelivery`,
      payload: elicitation!.payload,
    });
    expect(listOutbox(db, "ses-1").find((row) => row.id === again)?.status).toBe("pending");
  });

  test("an elicitation whose item stopped waiting is still superseded", () => {
    const db = database();
    waiting(db);
    db.run("UPDATE work_item SET state = 'failed' WHERE id = 'item-q'");
    errorActivity(db, "error:1");
    expect(listOutbox(db, "ses-1").find((row) => row.op === "elicitation")?.status).toBe("dropped");
  });
});

describe("acknowledgeNewSession on a session with a running item", () => {
  const prompted: AcceptedLinearEvent = {
    dedupeKey: "session:ses-1:prompted:a",
    deliveryId: "a",
    source: "webhook",
    action: "prompted",
    sessionId: "ses-1",
    issueId: "iss-1",
    activityId: "act-1",
    body: "Any update?",
    signal: null,
    updatedAtMs: 1,
    payload: "{}",
  };

  test("posts no terminal error and leaves the retry to the queue", async () => {
    const db = database();
    insertQueuedItem(db, { id: "item-1", sessionKey: "ses-1", now: 0 });
    beginImplementRun(db, "item-1", 1_000);
    expect(sessionHasItemInFlight(db, "ses-1")).toBe(true);
    const tracker = createFakeTracker();
    await expect(
      acknowledgeNewSession(
        tracker,
        prompted,
        async () => {
          throw new Error("Linear refused the follow-up read");
        },
        undefined,
        { sessionBusy: (sessionId) => sessionHasItemInFlight(db, sessionId) },
      ),
    ).rejects.toThrow("Linear refused the follow-up read");
    expect(tracker.progress).toEqual([]);
  });

  test("still reports the failure on a session with nothing running", async () => {
    const db = database();
    const tracker = createFakeTracker();
    await expect(
      acknowledgeNewSession(
        tracker,
        { ...prompted, action: "created" },
        async () => {
          throw new Error("Linear refused the follow-up read");
        },
        undefined,
        { sessionBusy: (sessionId) => sessionHasItemInFlight(db, sessionId) },
      ),
    ).rejects.toThrow();
    expect(tracker.progress.map((update) => [update.kind, update.body])).toEqual([
      ["thought", FIRST_ACTIVITY_BODY],
      ["error", "Paws could not start work on this issue. Please retry."],
    ]);
  });
});
