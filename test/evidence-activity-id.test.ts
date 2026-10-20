import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ArtifactSnapshot, PublishArtifactContext } from "../src/acp";
import { FakeClock } from "../src/core";
import {
  enqueueOutbox,
  insertQueuedItem,
  listOutbox,
  migrate,
  OutboxDispatcher,
  openDatabase,
} from "../src/db";
import { createEvidenceStore } from "../src/evidence";
import { createFakeTracker } from "../src/linear";
import { createEvidenceArtifactPublisher, deliverLinearOutbox } from "../src/loop";
import { tempHome } from "./helpers";

const UUID_V4 = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const PNG = Buffer.alloc(64, 1);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(PNG);

const homes: string[] = [];

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true });
});

function setup() {
  const home = tempHome();
  homes.push(home);
  const db = openDatabase(join(home, "paws.db"));
  migrate(db);
  insertQueuedItem(db, { id: "item", sessionKey: "session" });
  const store = createEvidenceStore({ db, root: join(home, "evidence") });
  const publisher = createEvidenceArtifactPublisher({
    db,
    evidence: store,
    publicUrl: "https://paws.example",
    itemId: "item",
    sessionId: "session",
  });
  const artifact: ArtifactSnapshot = {
    path: "shot.png",
    displayName: "shot.png",
    mimeType: "image/png",
    sizeBytes: PNG.byteLength,
    sha256: createHash("sha256").update(PNG).digest("hex"),
    bytes: new Blob([PNG]),
  };
  const context: PublishArtifactContext = {
    itemId: "item",
    runId: "run-1",
    worktreePath: home,
    role: "implementer",
    signal: new AbortController().signal,
    evidence: { checkId: "build-status", attempt: 1, headCommit: "a".repeat(40) },
  };
  return { db, publish: () => publisher.publish(artifact, context) };
}

async function deliverAll(db: Database, tracker: ReturnType<typeof createFakeTracker>) {
  const clock = new FakeClock(Date.now());
  const dispatcher = new OutboxDispatcher(db, clock);
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context, db),
  );
  // Each round runs an hour later so retry backoff never hides a row.
  for (let round = 0; round < 50; round++) {
    dispatcher.tick();
    await dispatcher.idle();
    clock.advance(3_600_000);
  }
}

test("a published evidence activity has a UUID v4 id and reaches Linear", async () => {
  const f = setup();
  try {
    const published = await f.publish();
    const evidenceId = published.url.split("/").at(-1)!;
    const [activity, ...rest] = listOutbox(f.db, "session");
    expect(rest).toHaveLength(0);
    expect((activity!.payload as { id: string }).id).toMatch(UUID_V4);
    expect(activity!.idempotencyKey).toBe(`evidence:session:0:${evidenceId}`);

    const tracker = createFakeTracker();
    await deliverAll(f.db, tracker);
    expect(listOutbox(f.db, "session").map((row) => row.status)).toEqual(["sent"]);
    expect(tracker.progress).toHaveLength(1);
    expect(tracker.progress[0]).toMatchObject({
      sessionId: "session",
      kind: "thought",
      id: (activity!.payload as { id: string }).id,
    });
    expect(tracker.progress[0]!.body).toContain(published.url);
  } finally {
    f.db.close();
  }
});

test("publishing the same evidence twice queues one activity", async () => {
  const f = setup();
  try {
    const first = await f.publish();
    const second = await f.publish();
    expect(second.url).toBe(first.url);
    expect(listOutbox(f.db, "session").filter((row) => row.op === "activity")).toHaveLength(1);
  } finally {
    f.db.close();
  }
});

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
    migrate(f.db);

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
