import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FakeClock } from "../core";
import {
  JobLoop,
  OutboxDispatcher,
  advanceLinearSessionGeneration,
  applyWorkItemEvent,
  beginImplementRun,
  enqueueOutboxOnce,
  getWorkItem,
  insertQueuedItem,
  listOutbox,
  migrate,
  openDatabase,
  sqliteDb,
} from "../db";
import type { GitHubBinding } from "../github";
import { createFakeTracker } from "../linear";
import { mergeQueueTurn } from "../merge";
import { deliverLinearOutbox } from "./dispatch";
import { Orchestrator } from "./orchestrator";

const PULL_URL = "https://github.com/acme/app/pull/7";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paws-review-wait-"));
  const db = openDatabase(":memory:");
  migrate(db);
  const clock = new FakeClock(1_000);
  const orchestrator = new Orchestrator({
    db,
    clock,
    jobs: new JobLoop(db, clock),
    outbox: new OutboxDispatcher(db, clock),
    pawsRoot: root,
  });
  insertQueuedItem(db, { id: "ENG-7", sessionKey: "ses_1", now: clock.now() });
  await beginImplementRun(sqliteDb(db), "ENG-7", clock.now());
  applyWorkItemEvent(db, "ENG-7", "turn_ended");
  applyWorkItemEvent(db, "ENG-7", "closeout_accepted");
  enqueueOutboxOnce(db, {
    target: "linear",
    op: "activity",
    orderingKey: "ses_1",
    idempotencyKey: "pull-request-ready:ENG-7:0",
    delivery: "ordered",
    payload: { id: crypto.randomUUID(), sessionId: "ses_1", kind: "response", body: "Opened #7." },
    now: clock.now(),
  });
  let decision = "REVIEW_REQUIRED";
  const github: GitHubBinding = {
    appId: "1",
    installationId: "2",
    privateKeyPem: "unused",
    tokenProvider: { mode: "token", tokenFor: async () => "fake-token" },
    client: {
      request: async () => ({
        status: 200,
        body: { data: { repository: { pullRequest: { reviewDecision: decision } } } },
      }),
    },
  };
  const tracker = createFakeTracker();
  const failures: Error[] = [];
  const delivery = new OutboxDispatcher(db, clock, { backoffBaseMs: 1_000 });
  delivery.setHandler(async (row) => {
    const failure = failures.shift();
    if (failure) throw failure;
    await deliverLinearOutbox(row, tracker, async () => {}, undefined, db);
  });
  const caps = orchestrator["orderCapabilities"]("ENG-7");
  return {
    db,
    clock,
    tracker,
    failures,
    caps,
    review: (next: string) => {
      decision = next;
    },
    wake: (head: string) =>
      mergeQueueTurn(
        { db, store: sqliteDb(db), item: getWorkItem(db, "ENG-7")!, caps },
        { owner: "acme", repo: "app" },
        github,
        { number: 7, url: PULL_URL, head },
      ),
    deliver: async () => {
      for (let round = 0; round < 10; round++) {
        if ((await delivery.tick()).length === 0) return;
        await delivery.idle();
      }
    },
    notices: async () =>
      (await listOutbox(sqliteDb(db), "ses_1")).filter((row) =>
        row.idempotencyKey.startsWith("merge-review:"),
      ),
    posted: () => tracker.progress.map((update) => update.body),
    cleanup: async () => {
      await orchestrator.shutdown();
      db.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

test("a required review after the pull request response posts one notice with the link", async () => {
  const f = await fixture();
  try {
    await f.deliver();
    expect(await f.wake("h1")).toMatchObject({ reason: "review", queued: true });
    const [notice] = await f.notices();
    expect(notice).toMatchObject({
      idempotencyKey: "merge-review:ENG-7:0:required:h1",
      status: "pending",
      delivery: "ordered",
      generation: 0,
    });
    await f.deliver();
    expect(f.posted()).toEqual([
      "Opened #7.",
      `Waiting for an approving review on [pull request #7](${PULL_URL}). It joins the acme/app merge queue once approved.`,
    ]);
    expect(f.tracker.progress.at(-1)).toMatchObject({ kind: "response" });

    for (let wake = 0; wake < 3; wake++) await f.wake("h1");
    await f.deliver();
    expect(await f.notices()).toHaveLength(1);
    expect(f.tracker.progress).toHaveLength(2);
  } finally {
    await f.cleanup();
  }
});

test("changes requested and a new head each post their own notice, in order", async () => {
  const f = await fixture();
  try {
    await f.wake("h1");
    f.review("CHANGES_REQUESTED");
    await f.wake("h1");
    await f.wake("h1");
    f.review("REVIEW_REQUIRED");
    await f.wake("h2");
    await f.deliver();
    expect((await f.notices()).map((row) => row.idempotencyKey)).toEqual([
      "merge-review:ENG-7:0:required:h1",
      "merge-review:ENG-7:0:changes_requested:h1",
      "merge-review:ENG-7:0:required:h2",
    ]);
    expect(f.posted()).toEqual([
      "Opened #7.",
      `Waiting for an approving review on [pull request #7](${PULL_URL}). It joins the acme/app merge queue once approved.`,
      `Changes were requested on [pull request #7](${PULL_URL}). Paws collects the review feedback before the next fix turn, and the pull request joins the acme/app merge queue once approved.`,
      `Waiting for an approving review on [pull request #7](${PULL_URL}). It joins the acme/app merge queue once approved.`,
    ]);
  } finally {
    await f.cleanup();
  }
});

test("other progress after the pull request response stays quiet", async () => {
  const f = await fixture();
  try {
    await sqliteDb(f.db).run((q) =>
      f.caps.voice.thought(q, getWorkItem(f.db, "ENG-7")!, "Checking reviews.", "merge-thought:1"),
    );
    await f.wake("h1");
    await f.deliver();
    expect((await listOutbox(sqliteDb(f.db), "ses_1")).map((row) => row.idempotencyKey)).toEqual([
      "pull-request-ready:ENG-7:0",
      "merge-review:ENG-7:0:required:h1",
    ]);
    expect(f.posted()).not.toContain("Checking reviews.");
  } finally {
    await f.cleanup();
  }
});

test("a cancelled item or a superseded generation hears no stale notice", async () => {
  const f = await fixture();
  try {
    await f.deliver();
    await f.wake("h1");
    await advanceLinearSessionGeneration(sqliteDb(f.db), "ses_1");
    await f.deliver();
    expect(f.posted()).toEqual(["Opened #7."]);

    f.db.run("UPDATE work_item SET cancel_requested = 1 WHERE id = ?", ["ENG-7"]);
    await f.wake("h2");
    expect((await f.notices()).map((row) => row.idempotencyKey)).toEqual([
      "merge-review:ENG-7:0:required:h1",
    ]);
  } finally {
    await f.cleanup();
  }
});

test("a failed delivery retries the same notice, with the same activity id, before the next", async () => {
  const f = await fixture();
  try {
    await f.deliver();
    f.failures.push(new Error("Linear unavailable"));
    await f.wake("h1");
    await f.wake("h2");
    await f.deliver();
    expect(f.posted()).toEqual(["Opened #7."]);
    await f.wake("h1");
    f.clock.advance(60_000);
    await f.deliver();
    const [first, second] = await f.notices();
    expect(f.tracker.progress.slice(1).map((update) => update.id)).toEqual([
      (first!.payload as { id: string }).id,
      (second!.payload as { id: string }).id,
    ]);
    expect(await f.notices()).toHaveLength(2);
    expect(f.tracker.progress).toHaveLength(3);
  } finally {
    await f.cleanup();
  }
});
