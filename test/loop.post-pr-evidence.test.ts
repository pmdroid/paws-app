import { expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { FakeClock } from "../src/core";
import {
  enqueueOutbox,
  enqueueOutboxOnce,
  insertQueuedItem,
  listOutbox,
  OutboxDispatcher,
} from "../src/db";
import { createEvidenceStore } from "../src/evidence";
import { createFakeTracker } from "../src/linear";
import {
  askSteps,
  createEvidenceArtifactPublisher,
  deliverLinearOutbox,
  enqueueEvidenceCard,
  evidenceSectionUrl,
  evidenceThoughts,
} from "../src/loop";
import { tempHome } from "./helpers";
import { seed } from "./dialects";
import { tempStore } from "./pglite";

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

async function setup() {
  const { db, close } = await tempStore();
  const home = tempHome();
  const item = await insertQueuedItem(db, { id: "item", sessionKey: "session" });
  await seed(db, (q) =>
    q.orm.update(q.t.workItem).set({ state: "verifying" }).where(eq(q.t.workItem.id, "item")),
  );
  const tracker = createFakeTracker();
  const store = createEvidenceStore({ store: db, root: join(home, "evidence") });
  const publisher = createEvidenceArtifactPublisher({
    store: db,
    itemId: "item",
    sessionId: "session",
    evidence: store,
    publicUrl: "https://paws.example",
    uploads: true,
  });
  const dispatcher = new OutboxDispatcher(db, new FakeClock(Date.now()));
  dispatcher.setHandler((row, context) =>
    deliverLinearOutbox(row, tracker, async () => {}, context, db),
  );
  const flush = async () => {
    while ((await dispatcher.tick()).length) await dispatcher.idle();
  };
  const publish = async (index: number, headCommit: string) => {
    const bytes = new Uint8Array([...PNG, index]);
    await (
      await publisher
    ).publish(
      {
        path: `shot-${index}.png`,
        displayName: `shot-${index}.png`,
        mimeType: "image/png",
        bytes: new Blob([bytes]),
        sizeBytes: bytes.length,
        sha256: createHash("sha256").update(bytes).digest("hex"),
      },
      {
        itemId: "item",
        runId: "run",
        worktreePath: home,
        role: "implementer",
        signal: new AbortController().signal,
        evidence: { checkId: "visual-proof", attempt: 1, headCommit },
      },
    );
  };
  const link = evidenceSectionUrl("https://paws.example", item)!;
  return {
    db,
    item,
    tracker,
    flush,
    publish,
    link,
    async cleanup() {
      await close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("16 screenshots of a check post one thought with the count and the link, once per head", async () => {
  const f = await setup();
  try {
    const head = "a".repeat(40);
    for (let index = 0; index < 16; index++) await f.publish(index, head);
    expect(await listOutbox(f.db)).toHaveLength(0);
    for (let round = 0; round < 2; round++)
      for (const { key, body } of await evidenceThoughts(f.db, {
        itemId: "item",
        checkIds: ["visual-proof", "no-files"],
        head,
        link: f.link,
      }))
        await enqueueOutboxOnce(f.db, {
          target: "linear",
          op: "activity",
          orderingKey: "session",
          delivery: "ordered",
          idempotencyKey: key,
          payload: { sessionId: "session", kind: "thought", body },
          now: Date.now(),
        });
    await f.flush();
    expect(f.tracker.progress.map(({ kind, body }) => [kind, body])).toEqual([
      [
        "thought",
        `Closeout evidence for \`visual-proof\`: 16 screenshots. See them in Paws: ${f.link}`,
      ],
    ]);
    expect(f.link).toBe("https://paws.example/dashboard/issues/item#evidence-gallery");
  } finally {
    await f.cleanup();
  }
});

test("after the PR response the issue gets one evidence card, and a new head updates it", async () => {
  const f = await setup();
  try {
    await enqueueOutbox(f.db, {
      target: "linear",
      op: "activity",
      orderingKey: "session",
      delivery: "ordered",
      idempotencyKey: "pull-request-ready:item:0",
      payload: { sessionId: "session", kind: "response", body: "Opened PR #1" },
    });
    await f.flush();
    for (const head of ["a".repeat(40), "b".repeat(40)]) {
      for (let index = 0; index < 16; index++) await f.publish(index, head);
      for (let round = 0; round < 2; round++)
        await enqueueEvidenceCard(f.db, {
          sessionId: "session",
          generation: 0,
          item: f.item,
          link: f.link,
          head,
          now: Date.now(),
        });
      await f.flush();
      expect(f.tracker.attachments).toMatchObject([
        {
          issueId: "lin-item-item",
          title: "Closeout evidence",
          subtitle: `16 screenshots at ${head.slice(0, 7)}`,
          url: f.link,
        },
      ]);
    }
    expect(f.tracker.progress.map(({ kind }) => kind)).toEqual(["response"]);
    await f.db.transaction((q) =>
      askSteps(q, { itemId: "item", runId: null, sessionId: "session" }, "agent", "Which layout?", {
        options: ["Wide", "Narrow"],
      }),
    );
    await f.flush();
    expect(f.tracker.questions).toHaveLength(1);
  } finally {
    await f.cleanup();
  }
});

test("a closed response fences later activities even without a PR response in its generation", async () => {
  const { db, close } = await tempStore();
  try {
    const tracker = createFakeTracker();
    const dispatcher = new OutboxDispatcher(db, new FakeClock(Date.now()));
    dispatcher.setHandler((row, context) =>
      deliverLinearOutbox(row, tracker, async () => {}, context, db),
    );
    for (const [key, kind] of [
      ["closed:item:0", "response"],
      ["late", "thought"],
    ])
      await enqueueOutbox(db, {
        target: "linear",
        op: "activity",
        orderingKey: "session",
        delivery: "ordered",
        idempotencyKey: key!,
        payload: { sessionId: "session", kind, body: "Closed: cancelled" },
      });
    while ((await dispatcher.tick()).length) await dispatcher.idle();
    expect(tracker.progress.map((update) => update.kind)).toEqual(["response"]);
  } finally {
    await close();
  }
});
