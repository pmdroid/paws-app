import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import {
  enqueueOutbox,
  insertQueuedItem,
  listOutbox,
  legacyMigrate,
  OutboxDispatcher,
  openDatabase,
} from "../src/db";
import { createFakeTracker } from "../src/linear";
import { deliverLinearOutbox } from "../src/loop";
import { tempHome } from "./helpers";

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = tempHome();
  homes.push(home);
  const db = openDatabase(join(home, "paws.db"));
  legacyMigrate(db);
  insertQueuedItem(db, { id: "item", sessionKey: "session" });
  return { db };
}

async function deliverAll(db: Database, tracker: ReturnType<typeof createFakeTracker>) {
  const clock = new FakeClock(Date.now());
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context, db),
  );
  for (let round = 0; round < 50; round++) {
    dispatcher.tick();
    await dispatcher.idle();
    clock.advance(3_600_000);
  }
}

test("a dead evidence row is repaired on start and the rows behind it deliver in order", async () => {
  const f = setup();
  try {
    const stuck = (body: string, key: string, id?: string) =>
      enqueueOutbox(f.db, {
        target: "linear",
        op: "activity",
        delivery: "ordered",
        priority: 0,
        orderingKey: "session",
        idempotencyKey: key,
        payload: { ...(id ? { id } : {}), sessionId: "session", kind: "thought", body },
      });
    stuck("before", "before");
    const evidence = stuck(
      "evidence",
      "evidence:session:0:01K7ZZZZZZZZZZZZZZZZZZZZZZ",
      "01K7ZZZZZZZZZZZZZZZZZZZZZZ",
    );
    stuck("closeout accepted", "after-1");
    stuck("completed", "after-2");
    const tracker = createFakeTracker();
    await deliverAll(f.db, tracker);
    expect(listOutbox(f.db, "session").find((row) => row.id === evidence)?.status).toBe("dead");
    expect(tracker.progress.map((update) => update.body)).toEqual(["before"]);

    f.db.run("DELETE FROM schema_migration WHERE id = '076_evidence_activity_uuid'");
    legacyMigrate(f.db);

    const repaired = listOutbox(f.db, "session").find((row) => row.id === evidence)!;
    expect(repaired).toMatchObject({ status: "pending", attempts: 0, error: null });
    expect((repaired.payload as { id: string }).id).toMatch(UUID_V4);
    await deliverAll(f.db, tracker);
    expect(tracker.progress.map((update) => update.body)).toEqual([
      "before",
      "evidence",
      "closeout accepted",
      "completed",
    ]);
    expect(listOutbox(f.db, "session").every((row) => row.status === "sent")).toBe(true);
  } finally {
    f.db.close();
  }
});

test("a pending evidence row with a ULID id is repaired before it is sent", async () => {
  const f = setup();
  try {
    const queued = enqueueOutbox(f.db, {
      target: "linear",
      op: "activity",
      delivery: "ordered",
      priority: 0,
      orderingKey: "session",
      idempotencyKey: "evidence:session:0:01K7YYYYYYYYYYYYYYYYYYYYYY",
      payload: {
        id: "01K7YYYYYYYYYYYYYYYYYYYYYY",
        sessionId: "session",
        kind: "thought",
        body: "queued evidence",
      },
    });

    f.db.run("DELETE FROM schema_migration WHERE id = '076_evidence_activity_uuid'");
    legacyMigrate(f.db);

    const repaired = listOutbox(f.db, "session").find((row) => row.id === queued)!;
    expect(repaired.status).toBe("pending");
    expect((repaired.payload as { id: string }).id).toMatch(UUID_V4);
    const tracker = createFakeTracker();
    await deliverAll(f.db, tracker);
    expect(tracker.progress.map((update) => update.body)).toEqual(["queued evidence"]);
  } finally {
    f.db.close();
  }
});
