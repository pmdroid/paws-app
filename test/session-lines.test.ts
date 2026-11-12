import { afterEach, describe, expect, test } from "bun:test";
import {
  beginImplementRun,
  enqueueOutbox,
  enqueueOutboxOnce,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  type Db,
} from "../src/db";
import { eq } from "drizzle-orm";
import {
  acknowledgeNewSession,
  createFakeTracker,
  FIRST_ACTIVITY_BODY,
  sessionHasItemInFlight,
  type AcceptedLinearEvent,
} from "../src/linear";
import { askSteps } from "../src/loop";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const open: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of open.splice(0)) await close();
});

async function database() {
  const { db, close } = await tempStore();
  open.push(close);
  return db;
}

function markSent(db: Db, id: number): Promise<void> {
  return seed(db, (q) =>
    q.orm.update(q.t.outbox).set({ status: "sent", sentAt: 1 }).where(eq(q.t.outbox.id, id)),
  );
}

async function thought(db: Db, key: string, body: string, ephemeral = false): Promise<number> {
  return enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: "ses-1",
    idempotencyKey: key,
    payload: { sessionId: "ses-1", kind: "thought", body, ...(ephemeral ? { ephemeral } : {}) },
  });
}

const bodies = async (db: Db) =>
  (await listOutbox(db, "ses-1"))
    .filter((row) => row.status !== "dropped")
    .map((row) => (row.payload as { body?: string }).body);

describe("lifecycle lines", () => {
  test("a thought that repeats the last sent or pending thought is not enqueued", async () => {
    const db = await database();
    const fix = "Fixing Closeout findings for PAS-619 (1 of 3).";
    const first = await thought(db, "fix:1", fix);
    // The resumed fix path and the keepalive say the same line again.
    expect(await thought(db, "fix:2", fix)).toBe(first);
    expect(await thought(db, "keep:1", fix, true)).toBe(first);
    await markSent(db, first);
    expect(await thought(db, "fix:3", fix)).toBe(first);
    // A repeated idempotency key still returns its own row.
    expect(await thought(db, "fix:1", fix)).toBe(first);
    expect(await bodies(db)).toEqual([fix]);

    await thought(db, "runtime:1", "Starting on agentbox in pmdroid/paws-app, bun 1.4.2.");
    await thought(db, "runtime:2", "Starting on agentbox in pmdroid/paws-app, bun 1.4.2.");
    // A different line in between makes the earlier line news again.
    await thought(db, "fix:4", fix);
    expect(await bodies(db)).toEqual([
      fix,
      "Starting on agentbox in pmdroid/paws-app, bun 1.4.2.",
      fix,
    ]);
  });

  test("a response starts a new phase, and an ephemeral line Linear already shows may repeat", async () => {
    const db = await database();
    await thought(db, "a", "Verifying PAS-1.");
    await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-1",
      idempotencyKey: "error",
      delivery: "ordered",
      payload: { sessionId: "ses-1", kind: "error", body: "Closeout could not start." },
    });
    await thought(db, "b", "Verifying PAS-1.");
    const keep = await thought(db, "keep:1", "Step 2 of 5: rank runners.", true);
    await markSent(db, keep);
    expect(await thought(db, "keep:2", "Step 2 of 5: rank runners.", true)).not.toBe(keep);
    expect(await bodies(db)).toEqual([
      "Verifying PAS-1.",
      "Closeout could not start.",
      "Verifying PAS-1.",
      "Step 2 of 5: rank runners.",
      "Step 2 of 5: rank runners.",
    ]);
  });
});

describe("a waiting question", () => {
  async function waiting(db: Db) {
    await insertQueuedItem(db, { id: "item-q", sessionKey: "ses-1", now: 0 });
    await beginImplementRun(db, "item-q", 1_000);
    const item = (await getWorkItem(db, "item-q"))!;
    await db.transaction((q) =>
      askSteps(
        q,
        { itemId: item.id, runId: item.currentRunId, sessionId: "ses-1", version: item.version },
        "agent",
        "Which repository?",
        { options: ["paws-app", "paws-runner"], now: 2_000 },
      ),
    );
    expect((await getWorkItem(db, "item-q"))?.state).toBe("awaiting_input");
  }

  const errorActivity = async (db: Db, key: string) =>
    await enqueueOutbox(db, {
      target: "linear",
      op: "activity",
      orderingKey: "ses-1",
      idempotencyKey: key,
      payload: { sessionId: "ses-1", kind: "error", body: "Paws could not start work." },
    });

  test("a critical error does not drop its elicitation while the item still waits", async () => {
    const db = await database();
    await waiting(db);
    await errorActivity(db, "error:1");
    const elicitation = (await listOutbox(db, "ses-1")).find((row) => row.op === "elicitation");
    expect(elicitation?.status).toBe("pending");
  });

  test("an elicitation whose item stopped waiting is still superseded", async () => {
    const db = await database();
    await waiting(db);
    await seed(db, (q) =>
      q.orm.update(q.t.workItem).set({ state: "failed" }).where(eq(q.t.workItem.id, "item-q")),
    );
    await errorActivity(db, "error:1");
    expect((await listOutbox(db, "ses-1")).find((row) => row.op === "elicitation")?.status).toBe(
      "dropped",
    );
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
    const db = await database();
    await insertQueuedItem(db, { id: "item-1", sessionKey: "ses-1", now: 0 });
    await beginImplementRun(db, "item-1", 1_000);
    expect(await sessionHasItemInFlight(db, "ses-1")).toBe(true);
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
    const db = await database();
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
