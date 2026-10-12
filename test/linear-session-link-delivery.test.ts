import { expect, test } from "bun:test";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import { enqueueOutbox, getOutbox, migrate, openDatabase, OutboxDispatcher } from "../src/db";
import { createLinearTracker } from "../src/linear";
import { deliverLinearOutbox } from "../src/loop";
import { tempDb, tempHome } from "./helpers";

test("persisted session link replacement, incremental removal and clearing reach GraphQL after reopen", async () => {
  const path = join(tempHome(), "paws.db");
  let db = openDatabase(path);
  migrate(db);
  const changes = [
    { externalUrls: [{ label: "Paws", url: "http://127.0.0.1:8787/status" }] },
    {
      addedExternalUrls: [{ label: "Pull request", url: "https://github.com/acme/app/pull/2" }],
      removedExternalUrls: ["https://github.com/acme/app/pull/1"],
    },
    { externalUrls: [] },
  ];
  changes.forEach((change, index) =>
    enqueueOutbox(db, {
      target: "linear",
      op: "linear.session.links",
      orderingKey: "session",
      idempotencyKey: `links:${index}`,
      now: 1,
      payload: { sessionId: "session", identifier: "ENG-1", ...change },
    }),
  );
  db.close();
  db = openDatabase(path);
  const sent: unknown[] = [];
  const tracker = createLinearTracker({
    async query(_query, variables) {
      sent.push(variables);
      return { agentSessionUpdate: { success: true, agentSession: { id: "session" } } };
    },
  });
  const dispatcher = new OutboxDispatcher(db, new FakeClock(1));
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context),
  );
  try {
    while (dispatcher.tick().length) await dispatcher.idle();
    expect(sent).toEqual(changes.map((input) => ({ id: "session", input })));
  } finally {
    db.close();
  }
});

test.each([
  { externalUrls: "invalid" },
  { externalUrls: [{ label: "Missing URL" }] },
  { externalUrls: [{ label: "Unsafe", url: "javascript:alert(1)" }] },
  { removedExternalUrls: "invalid" },
  { removedExternalUrls: [123] },
  { removedExternalUrls: ["file:///tmp/output.txt"] },
  { externalUrls: [], addedExternalUrls: [] },
  { externalUrls: [], removedExternalUrls: [] },
])("invalid session URL operation fails before transport: %j", async (change) => {
  const db = tempDb();
  let sent = 0;
  const tracker = createLinearTracker({
    async query() {
      sent++;
      return { agentSessionUpdate: { success: true, agentSession: { id: "session" } } };
    },
  });
  try {
    const id = enqueueOutbox(db, {
      target: "linear",
      op: "linear.session.links",
      orderingKey: "session",
      idempotencyKey: "invalid",
      payload: { sessionId: "session", ...change },
    });
    await expect(
      deliverLinearOutbox(getOutbox(db, id)!, tracker, async () => {}),
    ).rejects.toThrow();
    expect(sent).toBe(0);
  } finally {
    db.close();
  }
});
